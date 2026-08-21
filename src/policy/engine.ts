/**
 * Policy Engine (spec v0.2: §5 decision state machine, §6 hysteresis,
 * §7 checkpoint freshness & backoff, §8 prune bands, §9 compact/handoff).
 */

import type {
  AutoPlan,
  ContextAnalysis,
  ContextPolicyDecision,
  EngineState,
  PruneOptions,
} from "../types.ts";
import type { ContextEngineConfig } from "../config.ts";
import { resolveThresholds, resolveReclaimableMin } from "../config.ts";
import type { ModelInfo } from "../observer/context-observer.ts";
import { getPruneOptsForPressure } from "../pruning/pruner.ts";

export type { AutoPlan };

export interface DecideInputs {
  analysis: ContextAnalysis;
  state: EngineState;
  config: ContextEngineConfig;
  model?: ModelInfo | null;
  /** Is there a fresh (recently written) checkpoint? */
  checkpointFresh: boolean;
  now?: number;
}

/**
 * Checkpoint Freshness Check (spec §7.1, D4).
 * A checkpoint is fresh iff:
 *  - wallClockAge < checkpointFreshMs (default 10min)
 *  - AND tokensSinceCheckpoint < checkpointStaleTokens (default 20K)
 *  - AND messagesSinceCheckpoint < checkpointStaleMessages (default 30)
 */
export function isCheckpointFresh(
  state: EngineState,
  config: ContextEngineConfig,
  currentTokens?: number,
  currentMessagesCount?: number,
  now: number = Date.now(),
): boolean {
  if (!state.lastCheckpointAt || state.lastCheckpointAt <= 0) return false;

  const wallClockAge = now - state.lastCheckpointAt;
  const freshMs = config.checkpoint?.freshMs ?? config.cooldowns.checkpointFreshMs;
  if (wallClockAge >= freshMs) return false;

  const staleTokens = config.checkpoint?.staleTokens ?? 20_000;
  if (
    currentTokens !== undefined &&
    state.tokensAtLastCheckpoint !== undefined &&
    state.tokensAtLastCheckpoint > 0
  ) {
    const tokensSince = Math.max(0, currentTokens - state.tokensAtLastCheckpoint);
    if (tokensSince >= staleTokens) return false;
  }

  const staleMessages = config.checkpoint?.staleMessages ?? 30;
  if (
    currentMessagesCount !== undefined &&
    state.messagesAtLastCheckpoint !== undefined &&
    state.messagesAtLastCheckpoint > 0
  ) {
    const messagesSince = Math.max(0, currentMessagesCount - state.messagesAtLastCheckpoint);
    if (messagesSince >= staleMessages) return false;
  }

  return true;
}

/** Handoff gate (spec §9.2, §17, §27): pressure + fresh checkpoint + (compactions or decaying returns). */
export function shouldHandoff(inputs: DecideInputs): boolean {
  const t = resolveThresholds(inputs.config, inputs.model);
  const a = inputs.analysis;
  const state = inputs.state;

  if (a.pressure < t.handoff.enter) return false;
  if (!inputs.checkpointFresh) return false;

  const standardGate = state.compactionCount >= 2 && a.quality < 0.5;
  const ineffectiveCompactGate = (state.consecutiveIneffectiveCompacts ?? 0) >= 1;

  return standardGate || ineffectiveCompactGate;
}

const BAND_ACTIONS = ["prune", "checkpoint", "compact"] as const;

type BandAction = (typeof BAND_ACTIONS)[number];

/**
 * Hysteresis band tracking (spec §6): once an action fires, its band stays
 * ACTIVE (latched) — the action cannot re-enter — until pressure stays below
 * the band's exit threshold for 2 consecutive turns.
 *
 * Called once per context event, BEFORE planAutomatic. Mutates fresh copies
 * on `state` (never mutates shared nested objects in place). Returns true
 * when a latch changed state (worth persisting).
 */
export function updateHysteresisBands(
  state: EngineState,
  pressure: number,
  thresholds: ContextEngineConfig["thresholds"],
): boolean {
  const band = { prune: false, checkpoint: false, compact: false, ...(state.bandActive ?? {}) };
  const streak = { prune: 0, checkpoint: 0, compact: 0, ...(state.lowPressureStreak ?? {}) };
  let changed = false;

  for (const action of BAND_ACTIONS) {
    if (!band[action]) {
      if (streak[action] !== 0) {
        streak[action] = 0;
        changed = true;
      }
      continue;
    }
    if (pressure < thresholds[action].exit) {
      streak[action] += 1;
      if (streak[action] >= 2) {
        band[action] = false;
        streak[action] = 0;
        changed = true;
      }
    } else if (streak[action] !== 0) {
      streak[action] = 0;
      changed = true;
    }
  }

  state.bandActive = band;
  state.lowPressureStreak = streak;
  return changed;
}

/** Latch an action's band after it fires (spec §6). */
export function markBandActive(state: EngineState, action: BandAction): void {
  state.bandActive = {
    prune: false,
    checkpoint: false,
    compact: false,
    ...(state.bandActive ?? {}),
    [action]: true,
  };
  state.lowPressureStreak = {
    prune: 0,
    checkpoint: 0,
    compact: 0,
    ...(state.lowPressureStreak ?? {}),
    [action]: 0,
  };
}

export function decide(inputs: DecideInputs): ContextPolicyDecision {
  const { analysis: a, state, config } = inputs;
  const t = resolveThresholds(config, inputs.model);
  const reclaimableMin = resolveReclaimableMin(config, inputs.model);
  const band = state.bandActive;

  const adaptivePruneDelta = config.policy?.adaptiveThresholds
    ? state.adaptivePruneEnterDelta ?? 0
    : 0;
  const pruneEnter = Math.min(0.99, t.prune.enter + adaptivePruneDelta);

  const adaptiveCompactDelta = config.policy?.adaptiveThresholds
    ? state.adaptiveCompactEnterDelta ?? 0
    : 0;
  const compactEnter = Math.min(0.99, t.compact.enter + adaptiveCompactDelta);

  const base = (
    action: ContextPolicyDecision["action"],
    reason: string,
    after?: number,
  ) =>
    ({
      action,
      reason,
      pressureBefore: a.pressure,
      estimatedPressureAfter: after,
    } as const);

  // 1. Low pressure + healthy quality → do nothing (fast path)
  if (a.pressure < config.pressure.green && a.quality > 0.6) {
    return base("none", "pressure low and quality healthy");
  }

  // 2. Enough reclaimable garbage → prune (cheap, non-destructive).
  //     Suppressed while its hysteresis band is latched (§6).
  if (!band?.prune && a.pressure >= pruneEnter && a.reclaimableTokens >= reclaimableMin) {
    const after = Math.max(0, (a.totalTokens - a.reclaimableTokens) / a.usableTokens);
    return base(
      "prune",
      `pressure ${pct(a.pressure)} with ~${Math.round(a.reclaimableTokens)} reclaimable tokens`,
      after,
    );
  }

  // 3. High pressure without a fresh checkpoint → checkpoint first
  if (!band?.checkpoint && a.pressure >= t.checkpoint.enter && !inputs.checkpointFresh) {
    return base("checkpoint", `pressure ${pct(a.pressure)} and no fresh checkpoint`);
  }

  // 4. Repeated compactions / decaying returns + poor quality → handoff outranks compact
  if (shouldHandoff(inputs)) {
    return base(
      "handoff",
      `pressure ${pct(a.pressure)}, ${state.compactionCount} compactions, quality ${pct(a.quality)}`,
    );
  }

  // 5. Very high → compact (with prerequisite fresh checkpoint)
  if (!band?.compact && a.pressure >= compactEnter) {
    return base("compact", `pressure ${pct(a.pressure)} past compact threshold`);
  }

  return base(
    "none",
    `within policy (pressure ${pct(a.pressure)}, quality ${pct(a.quality)})`,
  );
}

/**
 * Count how many times an action fired within the last `window` TURNS
 * (spec §6: "每动作每 10 轮最多触发 3 次"). Entries recorded before the
 * `turn` field existed (or before a restart reset turnCount) are counted
 * only when they carry no turn info — conservative fail-open.
 */
function recentActionCount(
  history:
    | Array<{ action: "prune" | "checkpoint" | "compact"; timestamp: number; turn?: number }>
    | undefined,
  action: "prune" | "checkpoint" | "compact",
  currentTurn: number,
  window = 10,
): number {
  if (!history || !history.length) return 0;
  return history.filter(
    (h) => h.action === action && (h.turn === undefined || h.turn >= currentTurn - window + 1),
  ).length;
}

/**
 * Check if checkpointing is allowed given backoff and failure streaks (spec §7.2, §7.4).
 */
function canAttemptCheckpoint(
  state: EngineState,
  config: ContextEngineConfig,
  now: number,
): { allowed: boolean; reason?: string } {
  if (state.checkpointCircuitBroken) {
    return { allowed: false, reason: state.checkpointDisabledReason ?? "circuit broken" };
  }

  const maxPerSession = config.checkpoint?.maxPerSession ?? 20;
  if (state.checkpointCount >= maxPerSession) {
    return { allowed: false, reason: `max per session limit reached (${maxPerSession})` };
  }

  const maxFailStreak = config.checkpoint?.maxFailStreak ?? 3;
  if ((state.checkpointFailStreak ?? 0) >= maxFailStreak) {
    return { allowed: false, reason: `failed ${state.checkpointFailStreak} times consecutively (circuit broken)` };
  }

  const streak = state.checkpointFailStreak ?? 0;
  if (streak > 0 && state.lastCheckpointAttemptAt) {
    const backoffList = config.checkpoint?.backoffMs ?? [30_000, 60_000, 120_000];
    const MAX_BACKOFF_MS = 600_000; // spec §7.2: exponential, capped at 10min
    const steps = streak - 1;
    let backoffMs: number;
    if (steps < backoffList.length) {
      backoffMs = backoffList[steps] ?? 30_000;
    } else {
      // Beyond the configured list, keep doubling the last entry (§7.2 "…").
      const last = backoffList[backoffList.length - 1] ?? 30_000;
      backoffMs = Math.min(MAX_BACKOFF_MS, last * 2 ** (steps - backoffList.length + 1));
    }
    if (now - state.lastCheckpointAttemptAt < backoffMs) {
      return { allowed: false, reason: `in exponential backoff (${Math.round((backoffMs - (now - state.lastCheckpointAttemptAt)) / 1000)}s remaining)` };
    }
  }

  return { allowed: true };
}

export function planAutomatic(
  inputs: DecideInputs,
  state: EngineState,
  now: number = Date.now(),
): AutoPlan {
  const decision = decide(inputs);
  const cfg = inputs.config;
  const maxActions10 = cfg.policy?.maxActionsPer10Turns ?? 3;
  const currentTurn = state.turnCount ?? 0;

  const throttledActions: Array<"prune" | "checkpoint" | "compact"> = [];

  // Prune check
  const pruneThrottled =
    recentActionCount(state.actionHistory, "prune", currentTurn) >= maxActions10;
  if (decision.action === "prune" && pruneThrottled) {
    throttledActions.push("prune");
  }
  const pruneAllowed =
    decision.action === "prune" &&
    cfg.auto.prune &&
    !pruneThrottled &&
    now - state.lastPruneAt >= cfg.cooldowns.pruneMs;

  const pruneOpts: PruneOptions = getPruneOptsForPressure(
    inputs.analysis.pressure,
    cfg,
    "auto",
  );

  // Checkpoint check
  const cpCheck = canAttemptCheckpoint(state, cfg, now);
  const cpThrottled =
    recentActionCount(state.actionHistory, "checkpoint", currentTurn) >= maxActions10;
  if ((decision.action === "checkpoint" || decision.action === "compact") && cpThrottled) {
    throttledActions.push("checkpoint");
  }
  const checkpointAllowed =
    (decision.action === "checkpoint" || decision.action === "compact") &&
    cfg.auto.checkpoint &&
    !inputs.checkpointFresh &&
    !cpThrottled &&
    cpCheck.allowed;

  // Compact check
  const compactThrottled =
    recentActionCount(state.actionHistory, "compact", currentTurn) >= maxActions10;
  if (decision.action === "compact" && compactThrottled) {
    throttledActions.push("compact");
  }
  const compactAllowed =
    decision.action === "compact" &&
    cfg.auto.compact &&
    !compactThrottled &&
    now - state.lastCompactAt >= cfg.cooldowns.compactMs;

  return {
    prune: pruneAllowed,
    pruneOpts,
    checkpoint: checkpointAllowed,
    compact: compactAllowed,
    handoffSuggest: decision.action === "handoff",
    reason: decision.reason,
    decision,
    throttledActions: throttledActions.length ? throttledActions : undefined,
  };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
