/**
 * Tests for the session-local enable/disable toggle (/context enable|disable).
 *
 * Semantics under test:
 *  - enable/disable only mutates engine.config.enabled in memory (no config
 *    file writes; a fresh session reloads from config);
 *  - disable skips the context / before_agent_start / turn_end pipeline and
 *    cancels a queued auto compact (compactPending) so it never fires;
 *  - enable immediately restores the pipeline, including the queued-compact
 *    → agent_end firing path;
 *  - repeated toggles are idempotent and do not emit extra audit events;
 *  - /context status visibly distinguishes enabled/disabled.
 *
 * Isolation: each test boots its own extension instance against a config file
 * in a fresh system temp dir (mkdtemp), sets PI_CONTEXT_ENGINE_CONFIG, and
 * removes it in finally — tests never depend on execution order.
 *
 * Note: audit metrics are batched (5s flush); each test ends the session via
 * the session_shutdown handler before reading metrics.jsonl to force a flush.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { userMsg, assistantText } from "./factory.ts";

// ---------------------------------------------------------------------------
// Pi mock
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RegisteredCommand {
  name: string;
  description: string;
  getArgumentCompletions: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface Ctx {
  cwd: string;
  hasUI: boolean;
  mode: string;
  model: unknown;
  modelRegistry: unknown;
  sessionManager: unknown;
  getContextUsage: () => unknown;
  ui: { notify: (text: string, kind?: string) => void; setStatus: (id: string, t: string | undefined) => void };
  compact: (opts: { onComplete?: () => void; onError?: (err: Error) => void }) => void;
}

interface Boot {
  tmp: string;
  stateDir: string;
  handlers: Map<string, Handler>;
  commands: Map<string, RegisteredCommand>;
  makeCtx: (sessionId: string) => {
    ctx: Ctx;
    compactCalls: Array<Record<string, unknown>>;
    notifications: Array<{ text: string; kind?: string }>;
    statusCalls: string[];
  };
  readState: (sessionId: string) => Record<string, unknown>;
  readMetrics: (sessionId: string) => Array<Record<string, unknown>>;
  run: (sessionId: string, args: string, ctx: Ctx) => Promise<void>;
  shutdown: (ctx: Ctx) => Promise<void>;
  cleanup: () => void;
}

function boot(opts: { enabled: boolean }): Boot {
  const tmp = mkdtempSync(join(tmpdir(), "pce-toggle-"));
  const stateDir = join(tmp, "state");
  const cfgPath = join(tmp, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      enabled: opts.enabled,
      stateDir,
      auto: DEFAULT_CONFIG.auto,
      thresholds: DEFAULT_CONFIG.thresholds,
      policy: DEFAULT_CONFIG.policy,
      checkpoint: { ...DEFAULT_CONFIG.checkpoint, model: null },
      cooldowns: DEFAULT_CONFIG.cooldowns,
    }),
  );

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, RegisteredCommand>();

  const bootObj: Boot = {
    tmp,
    stateDir,
    handlers,
    commands,
    makeCtx(sessionId: string) {
      const VALID_CP = JSON.stringify({
        version: 1,
        created_at: new Date().toISOString(),
        task: { goal: "toggle test goal", phase: "p", status: "in_progress" },
        requirements: [],
        constraints: [],
        decisions: [],
        files: { inspected: [], modified: [], created: [], deleted: [] },
        verification: { passed: [], failed: [], pending: [] },
        issues: [],
        next_actions: [],
      });
      const compactCalls: Array<Record<string, unknown>> = [];
      const notifications: Array<{ text: string; kind?: string }> = [];
      const statusCalls: string[] = [];
      const usage = { tokens: 92_000, contextWindow: 100_000, percent: 92 };
      const ctx: Ctx = {
        cwd: tmp,
        hasUI: true,
        mode: "print",
        model: { provider: "test", id: "test-model", contextWindow: 100_000, maxTokens: 8192 },
        modelRegistry: {
          complete: async () => ({
            stopReason: "stop",
            content: [{ type: "text", text: VALID_CP }],
          }),
        },
        sessionManager: {
          getSessionId: () => sessionId,
          getBranch: () => [],
          getLeafId: () => "leaf-1",
          buildContextEntries: () => [],
          getSessionFile: () => join(tmp, "session.jsonl"),
        },
        getContextUsage: () => usage,
        ui: {
          notify: (text: string, kind?: string) => void notifications.push({ text, kind }),
          setStatus: (id: string, t: string | undefined) => {
            if (id === "pi-context-engine") statusCalls.push(t ?? "(clear)");
          },
        },
        compact: (o) => {
          compactCalls.push(o);
          o.onComplete?.();
        },
      };
      return { ctx, compactCalls, notifications, statusCalls };
    },
    readState(sessionId: string) {
      try {
        const parsed = JSON.parse(
          readFileSync(join(stateDir, "sessions", sessionId, "state.json"), "utf8"),
        ) as { state?: Record<string, unknown> } & Record<string, unknown>;
        return (parsed.state ?? parsed) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    readMetrics(sessionId: string) {
      const f = join(stateDir, "sessions", sessionId, "metrics.jsonl");
      if (!existsSync(f)) return [];
      return readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    async run(sessionId: string, args: string, ctx: Ctx) {
      const cmd = commands.get("context");
      assert.ok(cmd, "/context command must be registered");
      await cmd.handler(args, ctx);
    },
    async shutdown(ctx: Ctx) {
      // Flushes the batched audit log (Auditor.flush on session_shutdown).
      await handlers.get("session_shutdown")?.({}, ctx);
    },
    cleanup() {
      delete process.env.PI_CONTEXT_ENGINE_CONFIG;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  return bootObj;
}

async function startSession(bootObj: Boot, ctx: Ctx): Promise<void> {
  process.env.PI_CONTEXT_ENGINE_CONFIG = join(bootObj.tmp, "config.json");
  const { default: extensionFactory } = await import("../src/index.ts");
  const pi = {
    on: (ev: string, fn: Handler) => void bootObj.handlers.set(ev, fn),
    registerCommand: (name: string, cmd: RegisteredCommand) => void bootObj.commands.set(name, cmd),
    registerTool: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extensionFactory(pi as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await bootObj.handlers.get("session_start")?.({}, ctx as any);
}

async function poll(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return fn();
}

const messages = [userMsg("do the task"), assistantText("working on it")];

const VALID_CP_JSON = JSON.stringify({
  version: 1,
  created_at: new Date().toISOString(),
  task: { goal: "race test goal", phase: "p", status: "in_progress" },
  requirements: [],
  constraints: [],
  decisions: [],
  files: { inspected: [], modified: [], created: [], deleted: [] },
  verification: { passed: [], failed: [], pending: [] },
  issues: [],
  next_actions: [],
});

/** Deterministic microtask/macrotask drain (no timed sleeps). */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("toggle: initial disabled — /context enable works and restores the pipeline", async () => {
  const b = boot({ enabled: false });
  try {
    const { ctx, notifications } = b.makeCtx("toggle-enable");
    await startSession(b, ctx);
    const cmd = b.commands.get("context")!;

    // While disabled the turn_end pipeline is skipped: no metric events.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("turn_end")?.({}, ctx as any);

    // Enable from the initial disabled state.
    await b.run("toggle-enable", "enable", ctx);
    assert.ok(
      notifications.some((n) => /enabled/i.test(n.text) && !/already/.test(n.text)),
      `expected an "enabled" notification, got: ${JSON.stringify(notifications)}`,
    );

    // Pipeline is immediately back on: turn_end records metrics again.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("turn_end")?.({}, ctx as any);

    // Description + completions advertise the new subcommands.
    assert.ok(/enable\|disable/.test(cmd.description));
    const completions = cmd.getArgumentCompletions("") as Array<{ value: string }>;
    const values = completions.map((c) => c.value.trim());
    assert.ok(values.includes("enable"), `completions missing "enable": ${values}`);
    assert.ok(values.includes("disable"), `completions missing "disable": ${values}`);

    await b.shutdown(ctx);

    // Flushed metrics: exactly one turn_end metric (only after enable) and
    // exactly one real switch audited.
    const metrics = b.readMetrics("toggle-enable");
    assert.equal(metrics.filter((e) => e.action === "metric").length, 1);
    const toggles = metrics.filter((e) => e.action === "engine_toggled");
    assert.equal(toggles.length, 1);
    assert.equal(toggles[0].enabled, true);
    assert.equal(toggles[0].reason, "manual");
  } finally {
    b.cleanup();
  }
});

test("toggle: disable skips the pipeline and cancels a queued compact", async () => {
  const b = boot({ enabled: true });
  try {
    const { ctx, compactCalls, notifications } = b.makeCtx("toggle-disable");
    await startSession(b, ctx);

    // Drive pressure to ~105%: event 1 plans an auto checkpoint (no fresh
    // checkpoint yet); once it lands, event 2 plans the compact → queued
    // (fires only once the run goes idle, i.e. at agent_end).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("context")?.({ messages }, ctx as any);
    assert.ok(
      await poll(() => Number(b.readState("toggle-disable").checkpointCount ?? 0) >= 1),
      "auto checkpoint should complete",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("context")?.({ messages }, ctx as any);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(compactCalls.length, 0, "queued compact must not fire mid-run");

    // While still enabled, before_agent_start injects high-pressure guidance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guidanceBefore = await b.handlers.get("before_agent_start")?.(
      { systemPrompt: "base" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any,
    );
    assert.ok(
      guidanceBefore && (guidanceBefore as { systemPrompt?: string }).systemPrompt !== "base",
      "guidance should be injected while enabled at high pressure",
    );

    // Disable: cancel the queued compact + transient state.
    await b.run("toggle-disable", "disable", ctx);
    assert.ok(
      notifications.some((n) => /disabled/i.test(n.text) && !/already/.test(n.text)),
      `expected a "disabled" notification, got: ${JSON.stringify(notifications)}`,
    );

    // Pipeline is skipped while disabled.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guidanceAfter = await b.handlers.get("before_agent_start")?.(
      { systemPrompt: "base" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any,
    );
    assert.equal(guidanceAfter, undefined, "no guidance injection while disabled");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("agent_end")?.({}, ctx as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("turn_end")?.({}, ctx as any);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(
      compactCalls.length,
      0,
      "the queued compact must be cancelled by disable, never fired",
    );

    await b.shutdown(ctx);

    const metrics = b.readMetrics("toggle-disable");
    // The compact WAS queued before disable (audit event, appended earlier).
    assert.ok(
      metrics.some((e) => e.action === "compact_queued"),
      "compact_queued should have been audited before disable",
    );
    // ...and never fired: no auto compact event after the toggle.
    assert.ok(
      !metrics.some((e) => e.action === "compact" && e.triggered === "auto"),
      "no auto compact may run after disable",
    );
    assert.ok(
      !metrics.some((e) => e.action === "metric"),
      "turn_end should not record metrics while disabled",
    );
    const toggles = metrics.filter((e) => e.action === "engine_toggled");
    assert.equal(toggles.length, 1);
    assert.equal(toggles[0].enabled, false);
  } finally {
    b.cleanup();
  }
});

test("toggle: re-enable restores the pipeline including queued compact firing", async () => {
  const b = boot({ enabled: true });
  try {
    const { ctx, compactCalls } = b.makeCtx("toggle-reenable");
    await startSession(b, ctx);

    // disable → enable (restore within the same session).
    await b.run("toggle-reenable", "disable", ctx);
    await b.run("toggle-reenable", "enable", ctx);

    // Pipeline fully restored: high pressure queues a compact again and it
    // fires at agent_end. Event 1 re-checkpoints, event 2 queues the compact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("context")?.({ messages }, ctx as any);
    assert.ok(
      await poll(() => Number(b.readState("toggle-reenable").checkpointCount ?? 0) >= 1),
      "auto checkpoint should complete after re-enable",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("context")?.({ messages }, ctx as any);
    await new Promise((r) => setTimeout(r, 50));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("agent_end")?.({}, ctx as any);
    assert.ok(
      await poll(() => compactCalls.length > 0),
      "queued compact should fire at agent_end after re-enable",
    );
    const instructions = compactCalls[0]?.customInstructions;
    assert.equal(typeof instructions, "string");
    assert.ok(
      String(instructions).includes("recovery state"),
      "compact should use checkpoint-anchored instructions",
    );

    // turn_end records metrics again.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("turn_end")?.({}, ctx as any);

    await b.shutdown(ctx);

    const metrics = b.readMetrics("toggle-reenable");
    assert.ok(
      metrics.some((e) => e.action === "compact" && e.triggered === "auto"),
      "auto compact should have run after re-enable",
    );
    assert.ok(metrics.some((e) => e.action === "metric"));
    // Two real switches audited (disable + enable), no extras.
    const toggles = metrics.filter((e) => e.action === "engine_toggled");
    assert.equal(toggles.length, 2);
    assert.deepEqual(toggles.map((t) => t.enabled), [false, true]);
  } finally {
    b.cleanup();
  }
});

test("toggle: repeated enable/disable is idempotent; status distinguishes state; help lists toggle", async () => {
  const b = boot({ enabled: true });
  try {
    const { ctx, notifications } = b.makeCtx("toggle-idem");
    await startSession(b, ctx);

    // Real switch 1: enabled → disabled.
    await b.run("toggle-idem", "disable", ctx);
    // Repeated disable: idempotent, explicit notice, no extra audit event.
    await b.run("toggle-idem", "disable", ctx);
    assert.match(notifications.at(-1)!.text, /already disabled/i);
    // Real switch 2: back on.
    await b.run("toggle-idem", "enable", ctx);
    // Repeated enable: idempotent.
    await b.run("toggle-idem", "enable", ctx);
    assert.match(notifications.at(-1)!.text, /already enabled/i);

    // Status distinguishes the two states observably.
    await b.run("toggle-idem", "status", ctx);
    assert.ok(
      notifications.some((n) => n.text.includes("State: ENABLED")),
      `status should show ENABLED, got: ${JSON.stringify(notifications)}`,
    );
    // Real switch 3: off again for the DISABLED status check.
    await b.run("toggle-idem", "disable", ctx);
    await b.run("toggle-idem", "status", ctx);
    assert.ok(
      notifications.some((n) => n.text.includes("State: DISABLED")),
      `status should show DISABLED, got: ${JSON.stringify(notifications)}`,
    );

    // Unknown subcommand help mentions the new subcommands.
    await b.run("toggle-idem", "bogus", ctx);
    assert.ok(
      notifications.at(-1)!.text.includes("enable") &&
        notifications.at(-1)!.text.includes("disable"),
      `unknown-command help should list enable|disable, got: ${notifications.at(-1)!.text}`,
    );

    await b.shutdown(ctx);

    const toggles = b.readMetrics("toggle-idem").filter((e) => e.action === "engine_toggled");
    assert.equal(toggles.length, 3, "only actual switches are audited");
    assert.deepEqual(toggles.map((t) => t.enabled), [false, true, false]);
  } finally {
    b.cleanup();
  }
});

test("toggle: disable while an auto checkpoint is in flight suppresses its completion UI and compact chain", async () => {
  const b = boot({ enabled: true });
  try {
    const { ctx, compactCalls, notifications, statusCalls } = b.makeCtx("toggle-race");
    await startSession(b, ctx);

    // Controllable checkpoint LLM call: keep the auto checkpoint promise
    // pending until we resolve it AFTER disable.
    let releaseCheckpoint: (raw: string) => void = () => {};
    const checkpointGate = new Promise<string>((resolve) => {
      releaseCheckpoint = resolve;
    });
    ctx.modelRegistry = {
      complete: async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: await checkpointGate }],
      }),
    };

    // Drive pressure to ~105% → auto checkpoint planned, promise pending.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await b.handlers.get("context")?.({ messages }, ctx as any);
    // The checkpoint has started (busy flag observable via state action
    // history persisted in the context event) but not completed.
    assert.equal(
      (b.readState("toggle-race").checkpointCount ?? 0) || 0,
      0,
      "checkpoint must still be pending",
    );

    // Disable mid-flight: clears transient state (including any status).
    await b.run("toggle-race", "disable", ctx);
    const notificationsAtDisable = notifications.length;
    const statusCallsAtDisable = statusCalls.length;

    // Now let the checkpoint settle. Persistence/audit inside runCheckpoint
    // still happen; the post-completion .then chain must be suppressed.
    releaseCheckpoint(VALID_CP_JSON);
    assert.ok(
      await poll(() => Number(b.readState("toggle-race").checkpointCount ?? 0) >= 1),
      "checkpoint persistence should still complete after disable",
    );
    // Deterministic drain of the completion chain's micro/macrotasks —
    // no fixed sleep that could mask the race.
    await drain();

    // No completion status or notification surfaced after disable.
    assert.equal(
      statusCalls.length,
      statusCallsAtDisable,
      `no setStatus after disable, got: ${JSON.stringify(statusCalls.slice(statusCallsAtDisable))}`,
    );
    assert.equal(
      notifications.length,
      notificationsAtDisable,
      `no notification after disable, got: ${JSON.stringify(notifications.slice(notificationsAtDisable))}`,
    );
    assert.equal(compactCalls.length, 0, "no compact may fire after disable");

    await b.shutdown(ctx);

    // The checkpoint result itself is kept (persisted + audited).
    const metrics = b.readMetrics("toggle-race");
    assert.equal(
      metrics.filter((e) => e.action === "checkpoint").length,
      1,
      "the completed checkpoint stays audited",
    );
    assert.ok(
      metrics.some((e) => e.action === "engine_toggled" && e.enabled === false),
    );
    // And it never escalated into a queued compact afterwards.
    assert.ok(!metrics.some((e) => e.action === "compact_queued"));
    assert.ok(!metrics.some((e) => e.action === "compact" && e.triggered === "auto"));
  } finally {
    b.cleanup();
  }
});
