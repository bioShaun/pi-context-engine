/**
 * pi-context-engine — Context lifecycle engine for Pi Coding Agent.
 *
 * v0.1 (spec §38): /context metrics, tool pruning (/context clean),
 * structured checkpoints, pressure policy (auto prune/checkpoint/compact,
 * handoff = suggest only), pins, audit log.
 *
 * Safety:
 *  - Pruning is NON-destructive: the `context` event rewrites the effective
 *    message list per LLM call. The session file is never modified (§46).
 *  - Fail-open: any engine error is audited and swallowed; Pi continues (§36).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";

import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { loadConfig, resolveThresholds, type ContextEngineConfig } from "./config.ts";
import { analyzeContext, TokenCalibrator, type ModelInfo } from "./observer/context-observer.ts";
import { pruneContext, getPruneOptsForPressure, type StubConfig } from "./pruning/pruner.ts";
import {
  planAutomatic,
  isCheckpointFresh,
  updateHysteresisBands,
  markBandActive,
} from "./policy/engine.ts";
import { SessionStore } from "./checkpoint/store.ts";
import { generateCheckpoint, buildComplete } from "./checkpoint/checkpoint.ts";
import { getLatestCheckpointPath } from "./checkpoint/latest.ts";
import { PinStore, ensurePinsInContext } from "./pins/pins.ts";
import { buildHandoffPrompt } from "./handoff/handoff.ts";
import { Auditor, getState, putState } from "./audit.ts";
import { loadState, saveState, DEFAULT_STATE } from "./state.ts";
import { renderContextReport, renderCleanReport, fmtK } from "./report.ts";
import type { AnyMessage, Checkpoint, ContextAnalysis, EngineState, Pin } from "./types.ts";
import { ENGINE_ID } from "./types.ts";
import { messageText } from "./observer/token-estimator.ts";
import { createContextSearchTool, runContextSearch, renderedTokens } from "./recall/tool.ts";
import { buildTransientGuidance } from "./transient/guidance.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Per-session engine
// ---------------------------------------------------------------------------

interface Engine {
  sessionId: string;
  config: ContextEngineConfig;
  store: SessionStore;
  pins: PinStore;
  auditor: Auditor;
  state: EngineState;
  calibrator: TokenCalibrator;
  /** Manual /context clean is armed: next context pass prunes aggressively. */
  cleanArmed: { until: number };
  checkpointBusy: boolean;
  /**
   * In-flight ctx.compact(). Pi core's AgentSession.compact() has no
   * reentrancy guard: two concurrent calls race on the shared
   * `_compactionAbortController` and the loser crashes with "Cannot read
   * properties of undefined (reading 'signal')". The extension must never
   * start a second compact while one is running.
   */
  compactBusy: boolean;
  /**
   * Independent abort handle for the in-flight checkpoint LLM call. NOT
   * ctx.signal: ctx.compact() legitimately aborts the shared session signal
   * (AgentSession.compact() awaits this.abort()), and that must not kill a
   * running checkpoint (the cross-event case of the G4 hazard).
   */
  checkpointAbort: AbortController | null;
  /**
   * Auto compact requested by the policy but not yet fired. ctx.compact()
   * starts with abort(), so firing mid-run kills the in-flight turn
   * ("Operation aborted"). The request is queued in the context event and
   * fired from agent_end (or the checkpoint chain once the run is idle),
   * matching pi's own auto-compaction timing.
   */
  compactPending: { pressure: number } | null;
  /**
   * True while an agent run is active. Set in the context event (only fires
   * mid-run), cleared on agent_end. Gates tryFirePendingCompact.
   */
  agentRunning: boolean;
  lastHandoffSuggestAt: number;
  /**
   * Pressure from the most recent observation (context event / turn_end).
   * Drives the transient guidance band at before_agent_start (spec §14).
   */
  lastPressure: number;
  /** True once any fold/stub has been applied this session (spec §14.2). */
  hasFoldedContent: boolean;
}

function toModelInfo(model: unknown): ModelInfo | null {
  if (!model || typeof model !== "object") return null;
  const m = model as {
    provider?: string;
    id?: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
  };
  if (!m.id || !m.contextWindow) return null;
  return {
    provider: m.provider ?? "unknown",
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

function createEngine(ctx: ExtensionContext): Engine {
  const config = loadConfig(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId() ?? "in-memory";
  const store = new SessionStore(config.stateDir, sessionId);
  const pins = new PinStore(() => store.loadPins(), (p) => store.savePins(p));
  const auditor = new Auditor(store);
  const calibrator = new TokenCalibrator(20);
  let state = loadState(store) ?? DEFAULT_STATE;

  // Log any configuration migration / sanitization events (§11)
  if (config._migrationEvents?.length) {
    for (const ev of config._migrationEvents) {
      auditor.event(ev.action, ev);
    }
    config._migrationEvents = [];
  }

  // Compaction count comes from the session itself (survives restarts).
  try {
    const branch = ctx.sessionManager.getBranch();
    const count = branch.filter((e) => e.type === "compaction").length;
    state = { ...state, compactionCount: count };
    saveState(store, state);
  } catch {
    // in-memory sessions etc. — keep loaded state
  }

  return {
    sessionId,
    config,
    store,
    pins,
    auditor,
    state,
    calibrator,
    cleanArmed: { until: 0 },
    checkpointBusy: false,
    compactBusy: false,
    checkpointAbort: null,
    compactPending: null,
    agentRunning: false,
    lastHandoffSuggestAt: 0,
    lastPressure: 0,
    hasFoldedContent: false,
  };
}

function persistState(engine: Engine): void {
  saveState(engine.store, engine.state);
}

let engine: Engine | null = null;
let piApi: ExtensionAPI | null = null;

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

function loadLatestCheckpoint(e: Engine): Checkpoint | null {
  const path = getLatestCheckpointPath(e.config.stateDir, e.sessionId);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

function checkpointIsFresh(
  e: Engine,
  currentTokens?: number,
  currentMessagesCount?: number,
): boolean {
  return isCheckpointFresh(
    e.state,
    e.config,
    currentTokens,
    currentMessagesCount,
    Date.now(),
  );
}

async function runCheckpoint(
  e: Engine,
  ctx: ExtensionContext,
  messages: readonly AnyMessage[],
  source: "manual" | "auto",
  notify?: (text: string, kind: "info" | "warning" | "error") => void,
): Promise<{ ok: boolean; text: string }> {
  if (e.checkpointBusy) {
    return { ok: false, text: "checkpoint already in progress" };
  }
  if (!ctx.model) {
    return { ok: false, text: "no model available for checkpoint generation" };
  }
  e.checkpointBusy = true;
  // Own AbortController, not ctx.signal — see Engine.checkpointAbort.
  const checkpointAbort = new AbortController();
  e.checkpointAbort = checkpointAbort;
  e.state.lastCheckpointAttemptAt = Date.now();
  persistState(e);

  try {
    const targetModel = e.config.checkpoint?.model
      ? { ...ctx.model, id: e.config.checkpoint.model }
      : ctx.model;

    const result = await generateCheckpoint(
      {
        messages,
        complete: buildComplete({ ...ctx, model: targetModel }),
        signal: checkpointAbort.signal,
        sessionId: e.sessionId,
        tokensBefore: ctx.getContextUsage()?.tokens ?? undefined,
        source,
        pins: e.pins.active(),
      },
      { saveCheckpoint: (cp) => e.store.saveCheckpoint(cp) },
    );

    if (!result.ok) {
      e.state.checkpointFailStreak = (e.state.checkpointFailStreak ?? 0) + 1;
      const maxStreak = e.config.checkpoint?.maxFailStreak ?? 3;
      if (e.state.checkpointFailStreak >= maxStreak) {
        e.state.checkpointCircuitBroken = true;
        e.state.checkpointDisabledReason = result.errors.join("; ");
        e.auditor.event("checkpoint_circuit_broken", {
          source,
          streak: e.state.checkpointFailStreak,
          errors: result.errors,
        });
        notify?.(
          `auto checkpoint disabled: ${result.errors.join("; ")}`,
          "warning",
        );
      }
      persistState(e);
      e.auditor.event("checkpoint_failed", {
        source,
        streak: e.state.checkpointFailStreak,
        errors: result.errors,
      });
      return { ok: false, text: `checkpoint failed: ${result.errors.join("; ")}` };
    }

    e.state.checkpointFailStreak = 0;
    e.state.lastCheckpointAt = Date.now();
    e.state.checkpointCount += 1;
    e.state.tokensAtLastCheckpoint = ctx.getContextUsage()?.tokens ?? undefined;
    e.state.messagesAtLastCheckpoint = messages.length;
    persistState(e);

    const cp = result.checkpoint!;
    e.auditor.event("checkpoint", {
      source,
      goal: cp.task.goal,
      constraints: cp.constraints.length,
      next: cp.next_actions[0],
    });
    const name = e.store.listCheckpoints().at(-1) ?? "latest.json";
    return {
      ok: true,
      text: `checkpoint ${name} saved\n  goal: ${cp.task.goal}\n  constraints: ${cp.constraints.length}  ·  next: ${cp.next_actions[0] ?? "(none)"}`,
    };
  } catch (err) {
    e.state.checkpointFailStreak = (e.state.checkpointFailStreak ?? 0) + 1;
    persistState(e);
    e.auditor.event("checkpoint_error", {
      source,
      streak: e.state.checkpointFailStreak,
      error: String(err),
    });
    return { ok: false, text: `checkpoint error: ${String(err)}` };
  } finally {
    e.checkpointBusy = false;
    if (e.checkpointAbort === checkpointAbort) e.checkpointAbort = null;
  }
}

/**
 * Fire the queued auto compact — but only once the agent run is idle and no
 * checkpoint or compact is in flight. ctx.compact() begins with abort(), so
 * firing mid-run kills the in-flight turn; deferring to agent_end matches
 * pi's own auto-compaction timing (which also compacts between runs).
 *
 * Called from the agent_end handler and from the checkpoint completion
 * chain: when the run ends while a checkpoint is still generating, agent_end
 * skips (checkpointBusy) and the chain becomes the only firing path. The
 * chain runs with runCheckpoint's finally already executed, so checkpointBusy
 * is clear and the fresh checkpoint anchors the compaction (G4).
 */
function tryFirePendingCompact(ctx: ExtensionContext): void {
  const e = engine;
  if (!e || !e.compactPending || e.compactBusy || e.checkpointBusy || e.agentRunning) {
    return;
  }
  const { pressure } = e.compactPending;
  e.compactPending = null;

  setTransientStatus(ctx, "ctx: compacting…", 0);
  e.state.lastCompactAt = Date.now();
  e.state.lastCompactPressureBefore = pressure;
  e.state.actionHistory = [
    ...(e.state.actionHistory ?? []).slice(-19),
    { action: "compact", timestamp: Date.now(), turn: e.state.turnCount },
  ];
  markBandActive(e.state, "compact");
  persistState(e);
  const cp = loadLatestCheckpoint(e);
  e.auditor.event("compact", {
    triggered: "auto",
    pressure,
    anchored: cp !== null,
  });

  e.compactBusy = true;
  try {
    ctx.compact({
      customInstructions: compactInstructions(
        cp,
        e.pins.active(),
        (e.state.consecutiveIneffectiveCompacts ?? 0) >= 1,
      ),
      // D1 fix: session_compact handler is the single source of truth.
      onComplete: () => {
        e.compactBusy = false;
        try {
          e.auditor.event("compact_completed", { triggered: "auto" });
          setTransientStatus(ctx, "ctx: compacted", 3500);
        } catch {
          // fail-open
        }
      },
      onError: (err) => {
        e.compactBusy = false;
        setTransientStatus(ctx, "ctx: compact failed", 3500);
        notify(ctx, `auto compaction failed: ${err.message}`, "error");
      },
    });
  } catch (err) {
    e.compactBusy = false;
    setTransientStatus(ctx, "ctx: compact failed", 3500);
    notify(ctx, `auto compaction could not start: ${String(err)}`, "error");
  }
}

/**
 * Build compaction custom instructions (spec §9.3).
 * Includes recovery state, hard constraints from checkpoint & active pins,
 * and aggressive pruning guidance when previous compact was ineffective.
 */
function compactInstructions(
  cp: Checkpoint | null,
  activePins: Pin[] = [],
  lastCompactIneffective = false,
): string {
  const parts: string[] = [
    "Keep the recovery state intact: goal, explicit user constraints, current implementation state, files touched, verification status, and next actions.",
  ];

  // Hard constraints from checkpoint and active pins
  const allConstraints = new Set<string>();
  if (cp?.constraints) {
    for (const c of cp.constraints) allConstraints.add(c);
  }
  for (const pin of activePins) {
    if (pin.type === "constraint" || pin.type === "requirement") {
      allConstraints.add(pin.content);
    }
  }

  if (allConstraints.size > 0) {
    parts.push(`Hard constraints: ${Array.from(allConstraints).join("; ")}.`);
  }

  if (cp?.next_actions && cp.next_actions.length > 0) {
    parts.push(`Next action: ${cp.next_actions[0]}.`);
  }

  if (lastCompactIneffective) {
    parts.push(
      "Previous compaction did not effectively reduce context pressure; this summary should more aggressively discard tool output details.",
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

async function showPanel(
  ctx: ExtensionCommandContext | ExtensionContext,
  title: string,
  body: string,
): Promise<void> {
  if (ctx.mode === "tui") {
    await (ctx as ExtensionCommandContext).ui.custom((_tui, theme, _kb, done) => {
      const container = new Container();
      const border = new DynamicBorder((s: string) => theme.fg("accent", s));
      container.addChild(border);
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      container.addChild(new Text(body, 1, 1));
      container.addChild(new Text(theme.fg("dim", "Enter/Esc to close"), 1, 0));
      container.addChild(border);
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
          return true;
        },
      };
    });
  } else if (ctx.hasUI) {
    ctx.ui.notify(`${title}\n${body}`, "info");
  } else {
    console.log(`\n=== ${title} ===\n${body}\n`);
  }
}

function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info") {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(text, kind);
      return;
    }
  } catch {
    // context already shut down (print mode) — fall through to stdout
  }
  try {
    console.log(`[${ENGINE_ID}] ${text}`);
  } catch {
    // stdout closed — nothing else we can do; never throw (spec §36)
  }
}

let transientStatusTimer: ReturnType<typeof setTimeout> | null = null;

function setTransientStatus(
  ctx: { hasUI?: boolean; ui?: { setStatus: (id: string, text: string | undefined) => void } },
  text: string,
  durationMs = 3500,
): void {
  if (!ctx.hasUI || !ctx.ui) return;
  if (transientStatusTimer) {
    clearTimeout(transientStatusTimer);
    transientStatusTimer = null;
  }
  try {
    ctx.ui.setStatus(ENGINE_ID, text);
  } catch {
    // fail-open
  }
  if (durationMs > 0) {
    transientStatusTimer = setTimeout(() => {
      try {
        ctx.ui?.setStatus(ENGINE_ID, undefined);
      } catch {
        // fail-open
      }
      transientStatusTimer = null;
    }, durationMs);
  }
}

function clearTransientStatus(
  ctx?: { hasUI?: boolean; ui?: { setStatus: (id: string, text: string | undefined) => void } },
): void {
  if (transientStatusTimer) {
    clearTimeout(transientStatusTimer);
    transientStatusTimer = null;
  }
  if (ctx?.hasUI && ctx.ui) {
    try {
      ctx.ui.setStatus(ENGINE_ID, undefined);
    } catch {
      // fail-open
    }
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * Session-local toggle (instant enable/disable).
 *
 * Only mutates the in-memory engine.config.enabled — never any config file.
 * A new session (or restart) reloads `enabled` from the config cascade, so
 * the toggle is intentionally ephemeral.
 *
 * disable(): besides flipping the flag it cancels a queued auto compact
 * (compactPending) and clears transient state, so nothing the pipeline had
 * staged fires after the switch. The enabled guards in the context /
 * before_agent_start / turn_end handlers already skip everything else.
 * The auto-compact re-queue inside an in-flight checkpoint chain is also
 * gated on enabled (see queueAutoCompact), so a checkpoint completing after
 * disable cannot resurrect the queued compact.
 */
async function cmdEnable(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (e.config.enabled) {
    notify(ctx, "context engine already enabled (this session)", "info");
    return;
  }
  e.config.enabled = true;
  e.auditor.event("engine_toggled", { enabled: true, reason: "manual" });
  notify(ctx, "context engine enabled (this session; config file unchanged)", "info");
}

async function cmdDisable(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (!e.config.enabled) {
    notify(ctx, "context engine already disabled (this session)", "info");
    return;
  }
  e.config.enabled = false;
  e.compactPending = null; // cancel a queued auto compact
  e.cleanArmed = { until: 0 }; // drop a pending manual clean as well
  e.lastPressure = 0; // transient guidance band input
  e.hasFoldedContent = false; // transient guidance flag (§14.2)
  clearTransientStatus(ctx);
  e.auditor.event("engine_toggled", { enabled: false, reason: "manual" });
  notify(
    ctx,
    "context engine disabled (this session; auto pipeline off; config file unchanged)",
    "info",
  );
}

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) {
    notify(ctx, "context engine not initialized", "warning");
    return;
  }
  const effective = currentMessages(ctx);
  const model = toModelInfo(ctx.model);
  const { analysis } = analyzeContext({
    messages: effective,
    usage: ctx.getContextUsage(),
    model,
    config: e.config,
    pins: e.pins.active(),
    calibrator: e.calibrator,
    tokenEstimator: (m) => estimateTokens(m as AgentMessage),
  });
  const cp = loadLatestCheckpoint(e);
  const decision = planAutomatic(
    {
      analysis,
      state: e.state,
      config: e.config,
      model,
      checkpointFresh: checkpointIsFresh(e, analysis.totalTokens, effective.length),
    },
    e.state,
  ).decision;
  const stateLine = e.config.enabled
    ? "State: ENABLED — auto pipeline active this session"
    : "State: DISABLED — auto pipeline off this session (/context enable to resume)";
  await showPanel(
    ctx,
    "Context Engine",
    `${stateLine}\n\n${renderContextReport({
      analysis,
      model,
      pins: e.pins.all(),
      compactions: e.state.compactionCount,
      decision,
      checkpointFresh: !!cp,
    })}`,
  );
}

/**
 * The `context` event already handed us the exact message list for the next
 * call; commands that run while idle prefer that list — but ONLY while the
 * session and leaf it was captured from are still current. Otherwise we
 * fall back to the authoritative session context. Stale captures (session
 * switch, /tree navigation, compaction) must never leak into a report.
 */
let lastSeenMessages: readonly AnyMessage[] = [];
let lastSeenSession: { id: string; leaf: string | null } | null = null;

function safeLeafId(ctx: ExtensionContext): string | null {
  try {
    return ctx.sessionManager.getLeafId();
  } catch {
    return null;
  }
}

function currentMessages(ctx: ExtensionCommandContext): AnyMessage[] {
  const e = engine;
  if (
    e &&
    lastSeenSession &&
    lastSeenSession.id === e.sessionId &&
    lastSeenSession.leaf === safeLeafId(ctx) &&
    lastSeenMessages.length
  ) {
    return [...lastSeenMessages];
  }
  try {
    const entries = ctx.sessionManager.buildContextEntries();
    return entries.flatMap((en) => sessionEntryToContextMessages(en)) as AnyMessage[];
  } catch {
    return [...lastSeenMessages];
  }
}

async function cmdClean(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  const messages = currentMessages(ctx);
  const model = toModelInfo(ctx.model);
  const before = analyzeContext({
    messages,
    usage: ctx.getContextUsage(),
    model,
    config: e.config,
    pins: e.pins.active(),
    calibrator: e.calibrator,
    tokenEstimator: (m) => estimateTokens(m as AgentMessage),
  });
  const { toolCalls } = before.classify;
  const result = pruneContext({
    messages,
    analysis: before.analysis,
    toolCalls,
    // Manual clean always uses the most aggressive configured band (§8.1).
    opts: getPruneOptsForPressure(before.analysis.pressure, e.config, "manual"),
    // v0.3 (pi-native-recall §6, §7, §12)
    sessionId: e.sessionId,
    stub: stubCfgOf(e),
    cacheAware: e.config.cacheAware.enabled,
  });
  if (!result.actions.length) {
    notify(ctx, "nothing to clean", "info");
    return;
  }
  const afterTokens = Math.max(0, before.analysis.totalTokens - result.removedTokens);
  e.cleanArmed = { until: Date.now() + 15 * 60_000 };
  e.auditor.prune(result.actions, "manual", before.analysis.totalTokens, afterTokens);
  persistState(e);
  setTransientStatus(ctx, `ctx: -${fmtK(result.removedTokens)}`, 3500);
  const after = {
    ...before.analysis,
    totalTokens: afterTokens,
    staleTokens: Math.max(0, before.analysis.staleTokens - result.removedTokens),
    disposableTokens: Math.max(0, before.analysis.disposableTokens),
  };
  await showPanel(ctx, "Context clean", renderCleanReport(before.analysis, after, result.actions));
  notify(
    ctx,
    `armed: ${fmtK(result.removedTokens)} tokens will be pruned on the next model call (session file untouched)`,
    "info",
  );
}

async function cmdCheckpoint(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  const messages = currentMessages(ctx);
  notify(ctx, "generating checkpoint…", "info");
  setTransientStatus(ctx, "ctx: checkpointing…", 0);
  const r = await runCheckpoint(e, ctx, messages, "manual", (t, k) => notify(ctx, t, k));
  setTransientStatus(ctx, r.ok ? "ctx: cp saved" : "ctx: cp failed", 3500);
  if (ctx.mode === "tui") {
    await (ctx as ExtensionCommandContext).ui.editor("Review checkpoint report", r.text);
  } else {
    notify(ctx, r.text, r.ok ? "info" : "error");
  }
}

async function cmdCompact(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (e.compactBusy) {
    return notify(ctx, "compaction already in progress", "warning");
  }
  // G4 (§4): a checkpoint must exist before we compact.
  const messages = currentMessages(ctx);
  let cp = loadLatestCheckpoint(e);
  if (!cp || !checkpointIsFresh(e, undefined, messages.length)) {
    notify(ctx, "generating checkpoint before compact…", "info");
    const r = await runCheckpoint(e, ctx, messages, "auto", (t, k) => notify(ctx, t, k));
    if (!r.ok) {
      notify(ctx, `compact aborted — no recoverable checkpoint: ${r.text}`, "error");
      return;
    }
    cp = loadLatestCheckpoint(e);
  }
  notify(ctx, "compaction started (checkpoint-anchored)", "info");
  setTransientStatus(ctx, "ctx: compacting…", 0);
  // A manual compact satisfies any queued auto request.
  e.compactPending = null;
  e.compactBusy = true;
  try {
    ctx.compact({
      customInstructions: compactInstructions(
        cp,
        e.pins.active(),
        (e.state.consecutiveIneffectiveCompacts ?? 0) >= 1,
      ),
      // NOTE: do NOT count compactions here (D1 fix). Pi emits `session_compact` for
      // extension-triggered compactions too — the handler is the single
      // source of truth.
      onComplete: () => {
        e.compactBusy = false;
        try {
          e.auditor.event("compact", { triggered: "manual" });
          setTransientStatus(ctx, "ctx: compacted", 3500);
          notify(ctx, "compaction completed", "info");
        } catch {
          // fail-open
        }
      },
      onError: (err) => {
        e.compactBusy = false;
        setTransientStatus(ctx, "ctx: compact failed", 3500);
        notify(ctx, `compaction failed: ${err.message}`, "error");
      },
    });
  } catch (err) {
    e.compactBusy = false;
    setTransientStatus(ctx, "ctx: compact failed", 3500);
    notify(ctx, `compaction could not start: ${String(err)}`, "error");
  }
}

async function cmdHandoff(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (ctx.mode !== "tui") {
    notify(ctx, "handoff requires interactive mode", "warning");
    return;
  }
  const messages = currentMessages(ctx);
  let cp = loadLatestCheckpoint(e);
  if (!cp || !checkpointIsFresh(e, undefined, messages.length)) {
    notify(ctx, "generating checkpoint before handoff…", "info");
    const r = await runCheckpoint(e, ctx, messages, "auto", (t, k) => notify(ctx, t, k));
    if (!r.ok) {
      notify(ctx, `handoff aborted: ${r.text}`, "error");
      return;
    }
    cp = loadLatestCheckpoint(e);
  }
  let diffSummary: string | undefined;
  try {
    if (piApi) {
      const res = await piApi.exec("git", ["diff", "--stat"]);
      if (res?.stdout?.trim()) diffSummary = res.stdout.trim();
    }
  } catch {
    // not a git repo / exec unavailable — fine
  }
  const prompt = buildHandoffPrompt({
    checkpoint: cp,
    pins: e.pins.active(),
    gitDiffSummary: diffSummary,
  });
  const edited = await ctx.ui.editor("Handoff prompt (edit, then Esc to cancel)", prompt);
  if (edited === undefined) {
    notify(ctx, "handoff cancelled", "info");
    return;
  }
  const parent = ctx.sessionManager.getSessionFile();
  const result = await ctx.newSession({
    parentSession: parent,
    withSession: async (replacementCtx) => {
      replacementCtx.ui.setEditorText(edited);
      replacementCtx.ui.notify("Handoff ready — submit to start the new session.", "info");
    },
  });
  if (!result.cancelled) {
    e.state.handoffCount += 1;
    persistState(e);
    e.auditor.event("handoff", { parent, source: "manual" });
  }
}

async function lastUserText(ctx: ExtensionCommandContext): Promise<string> {
  try {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const en = branch[i];
      if (en.type === "message" && en.message?.role === "user") {
        return messageText(en.message as AnyMessage).trim();
      }
    }
  } catch {
    // not a persisted session
  }
  return "";
}

async function cmdPin(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (!rest) return notify(ctx, "usage: /context pin <text> | pin-last | pin-file <path>", "error");
  const pin = e.pins.add(PinStore.inferType(rest), rest);
  notify(ctx, `pinned (${pin.type}): ${pin.content.slice(0, 80)}`, "info");
}

async function cmdPinLast(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  const text = await lastUserText(ctx);
  if (!text) return notify(ctx, "no user message found to pin", "error");
  const pin = e.pins.add(PinStore.inferType(text), text.slice(0, 500));
  notify(ctx, `pinned (${pin.type}): ${pin.content.slice(0, 80)}`, "info");
}

async function cmdPinFile(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (!rest) return notify(ctx, "usage: /context pin-file <path>", "error");
  const pin = e.pins.add("file", rest);
  notify(ctx, `pinned file: ${rest}`, "info");
}

async function cmdPins(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return;
  const pins = e.pins.all();
  const body = pins.length
    ? pins
        .map(
          (p) =>
            `${p.active ? "✓" : "✗"} ${p.id} [${p.type}] ${p.content.slice(0, 100)}${
              p.active ? "" : " (inactive)"
            }`,
        )
        .join("\n")
    : "(no pins)";
  await showPanel(ctx, "Pins", body);
}

async function cmdUnpin(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const e = engine;
  if (!e) return;
  const id = args.trim();
  if (!id) {
    const active = e.pins.active();
    if (!active.length) return notify(ctx, "no pins to remove", "info");
    const options = active.map((p) => `${p.id} [${p.type}] ${p.content.slice(0, 60)}`);
    const choice = await ctx.ui.select("Unpin which?", options);
    if (!choice) return;
    const removed = e.pins.remove(choice.slice(0, 12));
    return notify(ctx, removed ? `unpinned ${removed.id}` : "pin not found", removed ? "info" : "error");
  }
  const removed = e.pins.remove(id);
  notify(ctx, removed ? `unpinned ${removed.id}` : `pin ${id} not found`, removed ? "info" : "error");
}

async function cmdHistory(ctx: ExtensionCommandContext): Promise<void> {
  const e = engine;
  if (!e) return;
  const pruneLog = e.store.readJsonl("prune-log").slice(-12);
  const events = e.store
    .readJsonl("metrics")
    .filter((x) => typeof x === "object" && (x as { action?: string }).action !== "metric")
    .slice(-12);
  const lines: string[] = [];
  for (const x of pruneLog) {
    const o = x as Record<string, unknown>;
    lines.push(
      `#${o.item_id ?? "?"} ${o.action} ${o.tool ?? ""} ${fmtK(Number(o.original_tokens ?? 0))}→${fmtK(Number(o.replacement_tokens ?? 0))} — ${o.reason}`,
    );
  }
  for (const x of events) {
    const o = x as Record<string, unknown>;
    const rest = Object.fromEntries(
      Object.entries(o).filter(([k]) => !["time", "action"].includes(k)),
    );
    lines.push(`${o.time ?? ""} ${o.action} ${JSON.stringify(rest).slice(0, 160)}`);
  }
  await showPanel(ctx, "Context engine history", lines.length ? lines.join("\n") : "(no activity yet)");
}

// ---------------------------------------------------------------------------
// /context search (pi-native-recall spec §11)
// ---------------------------------------------------------------------------

function stubCfgOf(e: Engine): StubConfig {
  return {
    enhanced: e.config.stub.enhanced,
    maxChars: e.config.stub.maxChars,
    maxErrorChars: e.config.stub.maxErrorChars,
    includeRecoveryRef: e.config.stub.includeRecoveryRef,
  };
}

/**
 * v0.3 §12.1: an auto prune only needs to reclaim enough to exit the prune
 * band (plus a small buffer for meter drift). Combined with cache-aware
 * ordering this applies the minimal set of candidates — the observable
 * behavior behind acceptance Case R3. Manual clean always applies everything.
 */
function autoPruneTarget(e: Engine, analysis: ContextAnalysis, model: ModelInfo | null): number {
  try {
    const t = resolveThresholds(e.config, model);
    const exit = t.prune.exit;
    if (!(analysis.pressure > exit) || !(analysis.pressure > 0)) return 0;
    const capacity = analysis.totalTokens / analysis.pressure; // implied window
    if (!Number.isFinite(capacity) || capacity <= 0) return 0;
    return Math.ceil((analysis.pressure - exit) * capacity) + 512;
  } catch {
    return 0; // fail-open: apply all planned candidates
  }
}

async function cmdSearch(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const e = engine;
  if (!e) return notify(ctx, "context engine not initialized", "warning");
  if (!e.config.search.enabled) {
    return notify(ctx, "context search is disabled (search.enabled=false)", "warning");
  }
  let q = rest.trim();
  let send = false;
  if (/(^|\s)--send\s*$/.test(q)) {
    send = true;
    q = q.replace(/(^|\s)--send\s*$/, "").trim();
  }
  if (!q) {
    return notify(
      ctx,
      'usage: /context search <query> [--send]  ·  e.g. /context search tool:bash "error TS2322"',
      "error",
    );
  }
  const run = await runContextSearch(e, ctx.sessionManager, { query: q }, undefined);
  if (!run.ok) return notify(ctx, run.error, "error");
  await showPanel(ctx, "Context search", run.rendered.text);

  if (send) {
    try {
      piApi?.sendMessage(
        {
          customType: `${ENGINE_ID}:search`,
          content: run.rendered.text,
          display: true,
          details: run.rendered.details,
        },
        { triggerTurn: true, deliverAs: ctx.isIdle() ? "nextTurn" : "steer" },
      );
      e.auditor.event("context_search_sent", {
        hits: run.rendered.details.hits,
        tokens: renderedTokens(run.rendered),
      });
      notify(ctx, "search results sent to the model (budgeted & redacted)", "info");
    } catch (err) {
      notify(ctx, `failed to send search results: ${String(err)}`, "error");
    }
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  piApi = pi;

  // Model self-service recall (pi-native-recall spec §10). Registration is
  // global; the per-session engine (and its search.enabled flag) is resolved
  // at execution time. When the boot config disables search entirely, the
  // tool is not registered at all (spec §15).
  let searchEnabledAtBoot = true;
  try {
    searchEnabledAtBoot = loadConfig().search.enabled;
  } catch {
    // fall back to default (enabled)
  }
  if (searchEnabledAtBoot) {
    try {
      pi.registerTool(
        createContextSearchTool(() => engine),
      );
    } catch (err) {
      try {
        console.error(`[${ENGINE_ID}] context_search registration failed:`, String(err));
      } catch {
        // fail-open
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      engine = createEngine(ctx);
      lastSeenMessages = [];
      lastSeenSession = null;
      clearTransientStatus(ctx);
    } catch (err) {
      engine = null;
      try {
        console.error(`[${ENGINE_ID}] startup failed:`, String(err));
      } catch {
        // nothing else to do
      }
    }
  });

  pi.on("session_shutdown", () => {
    if (engine) {
      try {
        engine.checkpointAbort?.abort();
      } catch {
        // fail-open
      }
      try {
        engine.auditor.flush();
      } catch {
        // fail-open
      }
    }
    engine = null;
    lastSeenMessages = [];
    lastSeenSession = null;
    clearTransientStatus();
  });

  // -------------------------------------------------------------------------
  // Context event pipeline (spec §3: OBSERVE → DECIDE → PRUNE → REINJECT → ESCALATE)
  // -------------------------------------------------------------------------

  pi.on("context", async (event, ctx) => {
    const e = engine;
    if (!e || !e.config.enabled) return;
    // The context event only fires before an LLM call, i.e. mid-run.
    e.agentRunning = true;
    try {
      lastSeenMessages = event.messages as AnyMessage[];
      lastSeenSession = { id: e.sessionId, leaf: safeLeafId(ctx) };
      const model = toModelInfo(ctx.model);
      const usage = ctx.getContextUsage();

      // 1. OBSERVE: unified metering (§4), single-turn memoization (§10.2)
      let { analysis, classify, meter } = analyzeContext({
        messages: event.messages as AnyMessage[],
        usage,
        model,
        config: e.config,
        pins: e.pins.active(),
        calibrator: e.calibrator,
        tokenEstimator: (m) => estimateTokens(m as AgentMessage),
      });

      // Check compact effectiveness from previous round (§9.1)
      if (e.state.lastCompactPressureBefore !== undefined) {
        const pressureBefore = e.state.lastCompactPressureBefore;
        const pressureAfter = analysis.pressure;
        const pressureDrop = pressureBefore - pressureAfter;
        e.state.lastCompactPressureBefore = undefined;

        if (pressureDrop < 0.05) {
          e.state.consecutiveIneffectiveCompacts =
            (e.state.consecutiveIneffectiveCompacts ?? 0) + 1;
          e.auditor.event("compact_ineffective", {
            pressureBefore,
            pressureAfter,
            pressureDrop,
            consecutive: e.state.consecutiveIneffectiveCompacts,
          });

          if (
            e.state.consecutiveIneffectiveCompacts >= 2 &&
            e.config.policy.adaptiveThresholds
          ) {
            e.state.adaptiveCompactEnterDelta =
              (e.state.adaptiveCompactEnterDelta ?? 0) + 0.04;
            e.auditor.event("adaptive_threshold_increased", {
              action: "compact",
              delta: e.state.adaptiveCompactEnterDelta,
            });
          }
        } else {
          e.state.consecutiveIneffectiveCompacts = 0;
        }
        persistState(e);
      }

      // §6: per-turn bookkeeping — turn counter + hysteresis band tracking
      // (a latched band resets only after 2 consecutive turns below exit).
      e.state.turnCount = (e.state.turnCount ?? 0) + 1;
      const bandsChanged = updateHysteresisBands(
        e.state,
        analysis.pressure,
        resolveThresholds(e.config, model),
      );
      if (bandsChanged) persistState(e);

      // Checkpoint freshness (D4, §7.1)
      const checkpointFresh = checkpointIsFresh(
        e,
        analysis.totalTokens,
        event.messages.length,
      );

      // 2. DECIDE: state machine plan with hysteresis & rate limits (§5, §6)
      let plan = planAutomatic(
        { analysis, state: e.state, config: e.config, model, checkpointFresh },
        e.state,
      );

      if (plan.throttledActions?.length) {
        for (const act of plan.throttledActions) {
          e.auditor.event("policy_throttled", {
            action: act,
            pressure: analysis.pressure,
          });
          notify(
            ctx,
            `auto ${act} throttled: max per 10 turns reached`,
            "info",
          );
        }
      }

      const armed = Date.now() < e.cleanArmed.until;
      if (
        !plan.prune &&
        !armed &&
        !plan.checkpoint &&
        !plan.compact &&
        !plan.handoffSuggest
      ) {
        e.lastPressure = analysis.pressure; // transient guidance band (§14)
        return; // fast path — no action needed
      }

      let messages: AnyMessage[] = event.messages as AnyMessage[];

      // 3. PRUNE: non-destructive rewrite with pressure bands (§8.1)
      if (plan.prune || armed) {
        const pruneOpts = armed
          ? getPruneOptsForPressure(analysis.pressure, e.config, "manual")
          : plan.pruneOpts;
        const result = pruneContext({
          messages,
          analysis,
          toolCalls: classify.toolCalls,
          opts: pruneOpts,
          // v0.3 (pi-native-recall §6, §7, §12)
          sessionId: e.sessionId,
          stub: stubCfgOf(e),
          cacheAware: e.config.cacheAware.enabled,
          targetReclaimable: armed ? 0 : autoPruneTarget(e, analysis, model),
        });

        if (result.actions.length) {
          messages = result.context;
          e.hasFoldedContent = true; // transient guidance flag (§14.2)
          e.state.lastPruneAt = Date.now();
          e.state.actionHistory = [
            ...(e.state.actionHistory ?? []).slice(-19),
            { action: "prune", timestamp: Date.now(), turn: e.state.turnCount },
          ];
          if (!armed) markBandActive(e.state, "prune"); // §6 latch (auto path only)

          // Recompute analysis under exact same meter (P2, D5)
          const analysisBefore = analysis;
          analysis = meter.recompute(analysis, result);
          const saved = Math.max(0, analysisBefore.totalTokens - analysis.totalTokens);
          setTransientStatus(ctx, `ctx: -${fmtK(saved)}`, 3500);

          // Check prune effectiveness and adaptive threshold (§6)
          const enterThreshold = resolveThresholds(e.config, model).prune.enter;
          if (analysis.pressure >= enterThreshold - 0.05) {
            e.state.consecutiveIneffectivePrunes =
              (e.state.consecutiveIneffectivePrunes ?? 0) + 1;
            if (
              e.state.consecutiveIneffectivePrunes >= 2 &&
              e.config.policy.adaptiveThresholds
            ) {
              e.state.adaptivePruneEnterDelta =
                (e.state.adaptivePruneEnterDelta ?? 0) + 0.05;
              e.auditor.event("adaptive_threshold_increased", {
                action: "prune",
                delta: e.state.adaptivePruneEnterDelta,
              });
            }
          } else {
            e.state.consecutiveIneffectivePrunes = 0;
          }

          e.auditor.prune(
            result.actions,
            armed ? "manual" : "auto",
            analysisBefore.totalTokens,
            analysis.totalTokens,
          );
          persistState(e);
          if (armed) e.cleanArmed = { until: 0 };

          // Post-prune escalation check within event (§3). Uses the
          // recomputed (same-meter) pressure; respects the compact latch.
          if (!plan.compact && !e.state.bandActive?.compact && e.config.auto.compact) {
            const t = resolveThresholds(e.config, model);
            const compactEnter =
              t.compact.enter + (e.state.adaptiveCompactEnterDelta ?? 0);
            if (
              analysis.pressure >= compactEnter &&
              Date.now() - e.state.lastCompactAt >= e.config.cooldowns.compactMs
            ) {
              plan = { ...plan, compact: true };
            }
          }
        }
      }

      // 4. REINJECT: ensure pins survive (D2 fixed)
      const activePins = e.pins.active();
      if (activePins.length) {
        const ensured = ensurePinsInContext(messages, activePins);
        if (ensured.injected.length) {
          messages = ensured.messages;
          e.auditor.event("pins_injected", { pins: ensured.injected.map((p) => p.id) });
        }
      }

      // 5. ESCALATE: checkpoint, compact, handoff suggestions
      //
      // G4 (§4): a checkpoint must exist before we compact. When both are
      // planned, the checkpoint runs to completion FIRST and the compaction
      // request is queued from its completion chain. Two further defenses
      // make this hold across separate context events: the checkpoint LLM
      // call runs on its own AbortController instead of the shared session
      // signal (Engine.checkpointAbort), and compaction never fires mid-run —
      // ctx.compact() begins with abort(), which would kill the in-flight
      // turn ("Operation aborted"). The request is queued here and fired by
      // tryFirePendingCompact from agent_end, matching pi's own
      // auto-compaction timing. If the context overflows before the run
      // ends, pi's native overflow recovery (compact + retry) handles it.
      const queueAutoCompact = (): void => {
        // Session-local disable must win even over an in-flight checkpoint
        // completion chain: never re-queue a compact after the toggle.
        if (!e.config.enabled || !plan.compact || e.compactBusy) return;
        if (e.compactPending) {
          // Already queued — refresh the pressure snapshot used for
          // post-compact effectiveness tracking (§9.1).
          e.compactPending.pressure = analysis.pressure;
          return;
        }
        e.compactPending = { pressure: analysis.pressure };
        e.auditor.event("compact_queued", { pressure: analysis.pressure });
        setTransientStatus(ctx, "ctx: compact queued (runs when the turn ends)", 0);
      };

      if (plan.checkpoint && !e.checkpointBusy) {
        setTransientStatus(ctx, "ctx: checkpointing…", 0);
        e.state.actionHistory = [
          ...(e.state.actionHistory ?? []).slice(-19),
          { action: "checkpoint", timestamp: Date.now(), turn: e.state.turnCount },
        ];
        markBandActive(e.state, "checkpoint");
        persistState(e);
        void runCheckpoint(e, ctx, messages, "auto").then((r) => {
          // Session-local disable may land while the checkpoint LLM call is
          // in flight. runCheckpoint has already persisted and audited the
          // result by now; everything after this point is post-completion
          // pipeline behavior (transient status, notification, compact
          // queue/fire) and must not surface after the switch.
          if (!e.config.enabled) return;
          setTransientStatus(ctx, r.ok ? "ctx: cp saved" : "ctx: cp failed", 3000);
          notify(
            ctx,
            r.ok ? r.text : `auto checkpoint failed: ${r.text}`,
            r.ok ? "info" : "warning",
          );
          // G4: compact only after the checkpoint settles. Pressure relief
          // still wins when the checkpoint failed (runCheckpoint's
          // fail-streak circuit breaker guards repeated failures) - the
          // compaction just runs unanchored, as before the fix. If the run
          // already ended while the checkpoint was generating, this chain is
          // the only firing path (agent_end skipped on checkpointBusy).
          queueAutoCompact();
          tryFirePendingCompact(ctx);
        });
      } else {
        queueAutoCompact();
      }

      if (plan.handoffSuggest && Date.now() - e.lastHandoffSuggestAt > 10 * 60_000) {
        e.lastHandoffSuggestAt = Date.now();
        e.auditor.event("handoff_suggest", {
          pressure: analysis.pressure,
          compactions: e.state.compactionCount,
        });
        notify(
          ctx,
          `context pressure ${Math.round(analysis.pressure * 100)}% after ${e.state.compactionCount} compactions — consider /context handoff`,
          "warning",
        );
      }

      // High pressure display (only if no transient action is actively showing)
      if (!transientStatusTimer && ctx.hasUI) {
        const thresholds = resolveThresholds(e.config, model);
        if (analysis.pressure >= thresholds.checkpoint.enter) {
          ctx.ui.setStatus(ENGINE_ID, `ctx: ${Math.round(analysis.pressure * 100)}%`);
        } else {
          ctx.ui.setStatus(ENGINE_ID, undefined);
        }
      }

      e.lastPressure = analysis.pressure; // transient guidance band (§14)

      if (messages !== (event.messages as AnyMessage[])) {
        return { messages: messages as unknown as AgentMessage[] };
      }
    } catch (err) {
      // Fail-open: an engine bug must never block the agent (spec §36).
      e?.auditor.event("error", { where: "context", error: String(err) });
    }
  });

  // agent_end = the run is about to go idle (pi awaits these listeners
  // before settling, and ctx.compact()'s internal waitForIdle then resolves
  // immediately). This is the safe point to fire a queued auto compact:
  // abort() is a no-op and no turn is interrupted. agent_end fires on
  // completed, failed, AND aborted runs (pi-agent-core handleRunFailure).
  pi.on("agent_end", (_event, ctx) => {
    const e = engine;
    if (!e) return;
    e.agentRunning = false;
    try {
      tryFirePendingCompact(ctx);
    } catch {
      // fail-open
    }
  });

  // Transient per-turn system-prompt guidance (pi-native-recall spec §14).
  // The text is byte-stable per (band, hasFolded, compactImminent) template
  // and is NEVER persisted — it is re-derived from in-memory engine state
  // every turn and disappears on session switch/shutdown.
  pi.on("before_agent_start", (event, ctx) => {
    const e = engine;
    if (!e || !e.config.enabled) return;
    try {
      const model = toModelInfo(ctx.model);
      const thresholds = resolveThresholds(e.config, model);
      const compactEnter = thresholds.compact.enter + (e.state.adaptiveCompactEnterDelta ?? 0);
      const guidance = buildTransientGuidance(
        {
          pressure: e.lastPressure,
          hasFolded: e.hasFoldedContent,
          compactImminent: e.compactPending !== null || e.lastPressure >= compactEnter,
        },
        {
          enabled: e.config.transientGuidance.enabled,
          minPressure: e.config.transientGuidance.minPressure,
          maxTokens: e.config.transientGuidance.maxTokens,
          compactEnter,
        },
      );
      if (!guidance) return;
      e.auditor.event("transient_guidance", {
        template: guidance.templateId,
        band: guidance.band,
      });
      return { systemPrompt: `${event.systemPrompt}\n\n${guidance.text}` };
    } catch (err) {
      // fail-open: no injection, the agent runs normally (spec §18)
      try {
        e.auditor.event("error", { where: "before_agent_start", error: String(err) });
      } catch {
        // fail-open
      }
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const e = engine;
    if (!e || !e.config.enabled) return;
    try {
      const usage = ctx.getContextUsage();
      if (usage?.tokens != null) {
        e.auditor.metric({
          context_tokens: usage.tokens,
          percent: usage.percent,
          compactions: e.state.compactionCount,
          checkpoints: e.state.checkpointCount,
        });
      }
      if (typeof usage?.percent === "number") {
        e.lastPressure = usage.percent / 100; // transient guidance band (§14)
      }
      if (!transientStatusTimer && ctx.hasUI && usage?.percent != null) {
        const model = toModelInfo(ctx.model);
        const thresholds = resolveThresholds(e.config, model);
        if (usage.percent / 100 >= thresholds.checkpoint.enter) {
          ctx.ui.setStatus(ENGINE_ID, `ctx: ${Math.round(usage.percent)}%`);
        } else {
          ctx.ui.setStatus(ENGINE_ID, undefined);
        }
      }
    } catch {
      // fail-open
    }
  });

  pi.on("session_compact", (_event, ctx) => {
    const e = engine;
    if (!e) return;
    // Defensive: a successful compaction always clears the in-flight flag,
    // even if the ctx.compact() onComplete callback was somehow lost. Any
    // compaction (pi's own included) also satisfies a queued auto request.
    e.compactBusy = false;
    e.compactPending = null;
    e.hasFoldedContent = false; // context rebuilt; stubs gone (§14.2)
    try {
      e.state.compactionCount += 1;
      persistState(e);
      e.auditor.event("compact", { triggered: "pi" });
    } catch {
      // fail-open
    }
  });

  pi.registerCommand("context", {
    description:
      "Context engine: /context [status|enable|disable|clean|search|checkpoint|compact|handoff|pin|pins|unpin|history]",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const sub = (prefix ?? "").split(" ")[0].toLowerCase();
      const items: AutocompleteItem[] = [
        "",
        "status",
        "enable",
        "disable",
        "clean",
        "search ",
        "checkpoint",
        "compact",
        "handoff",
        "pin ",
        "pin-last",
        "pin-file ",
        "pins",
        "unpin ",
        "history",
      ]
        .filter((c) => c === "" || c.startsWith(sub))
        .map((c) => ({ value: c, label: c || "status" }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        if (!engine) {
          engine = createEngine(ctx as ExtensionContext);
        }
        const raw = (args ?? "").trim();
        const sub = raw.split(/\s+/)[0].toLowerCase();
        const rest = raw.length ? raw.slice(sub.length).trim() : "";
        switch (sub) {
          case "":
          case "status":
            await cmdStatus(ctx);
            break;
          case "enable":
            await cmdEnable(ctx);
            break;
          case "disable":
            await cmdDisable(ctx);
            break;
          case "clean":
            await cmdClean(ctx);
            break;
          case "search":
            await cmdSearch(ctx, rest);
            break;
          case "checkpoint":
            await cmdCheckpoint(ctx);
            break;
          case "compact":
            await cmdCompact(ctx);
            break;
          case "handoff":
            await cmdHandoff(ctx);
            break;
          case "pin":
            await cmdPin(ctx, rest);
            break;
          case "pin-last":
            await cmdPinLast(ctx);
            break;
          case "pin-file":
            await cmdPinFile(ctx, rest);
            break;
          case "pins":
            await cmdPins(ctx);
            break;
          case "unpin":
            await cmdUnpin(ctx, (args ?? "").trim().slice(5).trim());
            break;
          case "history":
            await cmdHistory(ctx);
            break;
          default:
            notify(
              ctx,
              `unknown subcommand "${sub}" — use: status | enable | disable | clean | search | checkpoint | compact | handoff | pin | pins | unpin | history`,
              "error",
            );
        }
      } catch (err) {
        notify(ctx, `context command failed: ${String(err)}`, "error");
      }
    },
  });
}
