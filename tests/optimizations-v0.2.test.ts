/**
 * Comprehensive tests for v0.2 auto mode optimizations (§12).
 * Covers T1-T6 regression tests for defects D1-D8 and S1-S5 scenario tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeAndMigrateConfig,
  compileModelRules,
  patternSpecificity,
  resolveThresholds,
  resolveReclaimableMin,
  DEFAULT_CONFIG,
} from "../src/config.ts";
import { estimateTextTokens } from "../src/observer/token-estimator.ts";
import { analyzeContext, TokenCalibrator } from "../src/observer/context-observer.ts";
import { ensurePinsInContext } from "../src/pins/pins.ts";
import { classifyMessages } from "../src/classifier/classifier.ts";
import { computeSupersession } from "../src/pruning/supersession.ts";
import { foldBashOutput } from "../src/pruning/bash.ts";
import { serializeConversation } from "../src/checkpoint/checkpoint.ts";
import {
  decide,
  planAutomatic,
  isCheckpointFresh,
  updateHysteresisBands,
  markBandActive,
} from "../src/policy/engine.ts";
import { DEFAULT_STATE } from "../src/state.ts";
import type { AnyMessage, ContextAnalysis, EngineState, Pin, ResolvedToolCall } from "../src/types.ts";
import {
  userMsg,
  assistantText,
  assistantToolCall,
  toolResult,
  bashExecution,
  bigText,
  nextId,
} from "./factory.ts";

// ===========================================================================
// 12.1 Regression Tests (T1 - T6)
// ===========================================================================

test("T1 (D1): one auto compact increments compactionCount exactly once", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tmp = mkdtempSync(join(tmpdir(), "pce-t1-"));
  const stateDir = join(tmp, "state");
  const cfgPath = join(tmp, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      enabled: true,
      stateDir,
      auto: { prune: true, checkpoint: true, compact: true },
      thresholds: DEFAULT_CONFIG.thresholds,
      policy: DEFAULT_CONFIG.policy,
      checkpoint: { ...DEFAULT_CONFIG.checkpoint, model: null },
    }),
  );
  process.env.PI_CONTEXT_ENGINE_CONFIG = cfgPath;

  try {
    const { default: extensionFactory } = await import("../src/index.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      on: (ev: string, fn: (event: unknown, ctx: unknown) => unknown) => void handlers.set(ev, fn),
      registerCommand: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensionFactory(pi as any);

    const VALID_CP = JSON.stringify({
      version: 1,
      created_at: new Date().toISOString(),
      task: { goal: "test goal", phase: "p", status: "in_progress" },
      requirements: [],
      constraints: [],
      decisions: [],
      files: { inspected: [], modified: [], created: [], deleted: [] },
      verification: { passed: [], failed: [], pending: [] },
      issues: [],
      next_actions: [],
    });

    const compactCalls: unknown[] = [];
    const usage = { tokens: 92_000, contextWindow: 100_000, percent: 92 };
    const ctx = {
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
        getSessionId: () => "t1-session",
        getBranch: () => [],
        getLeafId: () => "leaf-1",
        buildContextEntries: () => [],
        getSessionFile: () => join(tmp, "session.jsonl"),
      },
      getContextUsage: () => usage,
      ui: { notify: () => {}, setStatus: () => {} },
      compact: (opts: { onComplete?: () => void }) => {
        compactCalls.push(opts);
        opts.onComplete?.();
      },
    };

    const messages = [userMsg("do the task"), assistantText("working on it")];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.get("session_start")?.({}, ctx as any);
    // Event 1: pressure ~1.05, no fresh checkpoint → auto checkpoint (fire-and-forget)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.get("context")?.({ messages }, ctx as any);

    const stateFile = join(stateDir, "sessions", "t1-session", "state.json");
    const readState = (): { checkpointCount?: number; compactionCount?: number } => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8")).state ?? {};
      } catch {
        return {};
      }
    };
    for (let i = 0; i < 200 && !(readState().checkpointCount ?? 0); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok((readState().checkpointCount ?? 0) >= 1, "auto checkpoint should complete");

    // Event 2: checkpoint now fresh; pressure ≥ compact.enter → compact queued
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.get("context")?.({ messages }, ctx as any);
    assert.equal(
      compactCalls.length,
      0,
      "auto compact must not fire mid-run (its abort() would kill the turn)",
    );
    // The run ends → the queued compact fires.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.get("agent_end")?.({}, ctx as any);
    assert.equal(compactCalls.length, 1, "auto compact fires exactly once, at run end");

    // Pi emits session_compact for extension-triggered compactions too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.get("session_compact")?.({}, ctx as any);
    assert.equal(
      readState().compactionCount,
      1,
      "session_compact handler must be the single counting source (D1)",
    );
    assert.equal(readState().checkpointCount, 1, "no extra checkpoint for a fresh compact");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handlers.get("session_shutdown")?.({}, ctx as any);
  } finally {
    delete process.env.PI_CONTEXT_ENGINE_CONFIG;
  }
});

test("T7 (G4 race): auto compact waits for the checkpoint to settle", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Before the fix, the context handler fired the checkpoint with `void` and
  // called ctx.compact() in the same tick; pi's compact() starts with
  // `await this.abort()`, which killed the in-flight checkpoint LLM call
  // (empty raw -> "checkpoint must be a JSON object") and left the compaction
  // unanchored. The fix chains compact after the checkpoint settles.
  const setup = async (
    sessionId: string,
    complete: () => Promise<unknown>,
  ): Promise<{
    handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
    ctx: Record<string, unknown>;
    compactCalls: Array<{ customInstructions?: string }>;
    stateFile: string;
    cleanup: () => Promise<void>;
  }> => {
    const tmp = mkdtempSync(join(tmpdir(), "pce-t7-"));
    const stateDir = join(tmp, "state");
    const cfgPath = join(tmp, "config.json");
    // Reproduce the incident band: compact.enter BELOW checkpoint.enter
    // (as the qwen* model override does: 0.78 < 0.80). In that window
    // decide() returns action "compact" while the checkpoint is stale, so
    // planAutomatic plans BOTH checkpoint and compact - the race condition.
    writeFileSync(
      cfgPath,
      JSON.stringify({
        enabled: true,
        stateDir,
        auto: { prune: true, checkpoint: true, compact: true },
        thresholds: {
          prune: { enter: 0.65, exit: 0.55 },
          checkpoint: { enter: 0.86, exit: 0.70 },
          compact: { enter: 0.80, exit: 0.70 },
          handoff: { enter: 0.94 },
        },
        policy: DEFAULT_CONFIG.policy,
        checkpoint: { ...DEFAULT_CONFIG.checkpoint, model: null },
      }),
    );
    process.env.PI_CONTEXT_ENGINE_CONFIG = cfgPath;

    const { default: extensionFactory } = await import("../src/index.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      on: (ev: string, fn: (event: unknown, ctx: unknown) => unknown) => void handlers.set(ev, fn),
      registerCommand: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensionFactory(pi as any);

    const compactCalls: Array<{ customInstructions?: string }> = [];
    // ~72k tokens against ~87.7k usable -> pressure ≈ 0.82, inside the
    // inverted band [compact.enter 0.80, checkpoint.enter 0.86).
    const usage = { tokens: 72_000, contextWindow: 100_000, percent: 72 };
    const ctx = {
      cwd: tmp,
      hasUI: true,
      mode: "print",
      model: { provider: "test", id: "test-model", contextWindow: 100_000, maxTokens: 8192 },
      modelRegistry: { complete },
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => [],
        getLeafId: () => "leaf-1",
        buildContextEntries: () => [],
        getSessionFile: () => join(tmp, "session.jsonl"),
      },
      getContextUsage: () => usage,
      ui: { notify: () => {}, setStatus: () => {} },
      compact: (opts: { customInstructions?: string; onComplete?: () => void }) => {
        compactCalls.push(opts);
        opts.onComplete?.();
      },
    };
    return {
      handlers,
      ctx,
      compactCalls,
      stateFile: join(stateDir, "sessions", sessionId, "state.json"),
      cleanup: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handlers.get("session_shutdown")?.({}, ctx as any);
        delete process.env.PI_CONTEXT_ENGINE_CONFIG;
      },
    };
  };

  const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
    for (let i = 0; i < ms / 10 && !pred(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const VALID_CP = JSON.stringify({
    version: 1,
    created_at: new Date().toISOString(),
    task: { goal: "migrate the database safely", phase: "p", status: "in_progress" },
    requirements: [],
    constraints: ["never drop the prod table"],
    decisions: [],
    files: { inspected: [], modified: [], created: [], deleted: [] },
    verification: { passed: [], failed: [], pending: [] },
    issues: [],
    next_actions: ["run the migration dry-run"],
  });
  const readState = (
    file: string,
  ): { checkpointCount?: number; checkpointFailStreak?: number } => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).state ?? {};
    } catch {
      return {};
    }
  };

  // Scenario A: checkpoint succeeds -> compact is chained after it and anchored.
  {
    const s = await setup("t7a-session", async () => {
      await new Promise((r) => setTimeout(r, 30)); // simulate LLM latency
      return { stopReason: "stop", content: [{ type: "text", text: VALID_CP }] };
    });
    try {
      const messages = [userMsg("do the task"), assistantText("working on it")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("session_start")?.({}, s.ctx as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("context")?.({ messages }, s.ctx as any);

      // The compact must NOT fire in the same tick as the context event:
      // the checkpoint LLM call is still in flight.
      assert.equal(s.compactCalls.length, 0, "compact must wait for the checkpoint");

      await waitFor(() => (readState(s.stateFile).checkpointCount ?? 0) >= 1);
      assert.ok(
        (readState(s.stateFile).checkpointCount ?? 0) >= 1,
        "auto checkpoint should complete first",
      );
      assert.equal(
        s.compactCalls.length,
        0,
        "compact stays queued while the run is active, even after the checkpoint settles",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("agent_end")?.({}, s.ctx as any);
      assert.equal(s.compactCalls.length, 1, "compact fires exactly once, at run end");
      const instructions = s.compactCalls[0]?.customInstructions ?? "";
      assert.ok(
        instructions.includes("never drop the prod table"),
        "compaction instructions must be anchored by the fresh checkpoint (constraint)",
      );
      assert.ok(
        instructions.includes("run the migration dry-run"),
        "compaction instructions must carry the checkpoint's next action",
      );
    } finally {
      await s.cleanup();
    }
  }

  // Scenario B: checkpoint fails -> compact still fires (pressure relief), unanchored.
  {
    const s = await setup("t7b-session", async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "not json at all" }],
    }));
    try {
      const messages = [userMsg("do the task"), assistantText("working on it")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("session_start")?.({}, s.ctx as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("context")?.({ messages }, s.ctx as any);

      await waitFor(() => readState(s.stateFile).checkpointFailStreak === 1);
      assert.equal(
        readState(s.stateFile).checkpointFailStreak,
        1,
        "checkpoint failure is recorded for the circuit breaker",
      );
      assert.equal(s.compactCalls.length, 0, "compact stays queued mid-run");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("agent_end")?.({}, s.ctx as any);
      assert.equal(
        s.compactCalls.length,
        1,
        "failed checkpoint must not block pressure relief",
      );
      assert.ok(
        typeof s.compactCalls[0]?.customInstructions === "string",
        "unanchored compaction still carries base instructions",
      );
    } finally {
      await s.cleanup();
    }
  }
});

test("T8 (concurrency): one compact in flight; checkpoint survives session abort", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Reproduces the 2026-08-22 incident: two context events in the same turn
  // each reached ctx.compact() 2ms apart (one direct via the else branch while
  // checkpointBusy, one chained after the checkpoint failed). Pi core's
  // AgentSession.compact() has no reentrancy guard, so the two calls raced on
  // the shared _compactionAbortController and the loser crashed with
  // "Cannot read properties of undefined (reading 'signal')". The direct
  // compact's abort() also killed the in-flight checkpoint, which used to run
  // on the shared session signal.
  type CompactOpts = {
    customInstructions?: string;
    onComplete?: () => void;
    onError?: (err: Error) => void;
  };
  type CompleteOpts = { signal?: AbortSignal };

  const VALID_CP = JSON.stringify({
    version: 1,
    created_at: new Date().toISOString(),
    task: { goal: "migrate the database safely", phase: "p", status: "in_progress" },
    requirements: [],
    constraints: ["never drop the prod table"],
    decisions: [],
    files: { inspected: [], modified: [], created: [], deleted: [] },
    verification: { passed: [], failed: [], pending: [] },
    issues: [],
    next_actions: ["run the migration dry-run"],
  });

  const setup = async (
    sessionId: string,
    complete: (opts?: CompleteOpts) => Promise<unknown>,
  ) => {
    const tmp = mkdtempSync(join(tmpdir(), "pce-t8-"));
    const stateDir = join(tmp, "state");
    const cfgPath = join(tmp, "config.json");
    // Same inverted band as T7: compact.enter 0.80 < checkpoint.enter 0.86,
    // so pressure ~0.82 plans BOTH checkpoint and compact.
    writeFileSync(
      cfgPath,
      JSON.stringify({
        enabled: true,
        stateDir,
        auto: { prune: true, checkpoint: true, compact: true },
        thresholds: {
          prune: { enter: 0.65, exit: 0.55 },
          checkpoint: { enter: 0.86, exit: 0.70 },
          compact: { enter: 0.80, exit: 0.70 },
          handoff: { enter: 0.94 },
        },
        policy: DEFAULT_CONFIG.policy,
        checkpoint: { ...DEFAULT_CONFIG.checkpoint, model: null },
      }),
    );
    process.env.PI_CONTEXT_ENGINE_CONFIG = cfgPath;

    const { default: extensionFactory } = await import("../src/index.ts");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = {
      on: (ev: string, fn: (event: unknown, ctx: unknown) => unknown) => void handlers.set(ev, fn),
      registerCommand: () => {},
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extensionFactory(pi as any);

    const compactCalls: CompactOpts[] = [];
    const sessionAbort = new AbortController();
    const usage = { tokens: 72_000, contextWindow: 100_000, percent: 72 };
    const ctx = {
      cwd: tmp,
      hasUI: true,
      mode: "print",
      model: { provider: "test", id: "test-model", contextWindow: 100_000, maxTokens: 8192 },
      modelRegistry: {
        complete: (_model: unknown, _params: unknown, opts?: CompleteOpts) => complete(opts),
      },
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => [],
        getLeafId: () => "leaf-1",
        buildContextEntries: () => [],
        getSessionFile: () => join(tmp, "session.jsonl"),
      },
      getContextUsage: () => usage,
      signal: sessionAbort.signal,
      ui: { notify: () => {}, setStatus: () => {} },
      compact: (opts: CompactOpts) => {
        compactCalls.push(opts);
        opts.onComplete?.();
      },
    };
    return {
      handlers,
      ctx,
      compactCalls,
      sessionAbort,
      stateFile: join(stateDir, "sessions", sessionId, "state.json"),
      cleanup: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handlers.get("session_shutdown")?.({}, ctx as any);
        delete process.env.PI_CONTEXT_ENGINE_CONFIG;
      },
    };
  };

  const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
    for (let i = 0; i < ms / 10 && !pred(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const readState = (
    file: string,
  ): { checkpointCount?: number; checkpointFailStreak?: number } => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).state ?? {};
    } catch {
      return {};
    }
  };

  // Scenario A: two context events in one turn -> exactly one compact, fired
  // once, chained after the checkpoint, and the checkpoint is not aborted.
  {
    const capturedSignals: Array<AbortSignal | undefined> = [];
    const s = await setup("t8a-session", async (opts) => {
      capturedSignals.push(opts?.signal);
      await new Promise((r) => setTimeout(r, 30)); // simulate LLM latency
      return { stopReason: "stop", content: [{ type: "text", text: VALID_CP }] };
    });
    try {
      const messages = [userMsg("do the task"), assistantText("working on it")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("session_start")?.({}, s.ctx as any);
      // Event 1: plans checkpoint + compact; checkpoint starts (in flight),
      // compact is chained after it (G4).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("context")?.({ messages }, s.ctx as any);
      // Event 2, same turn (2ms later in the incident): checkpoint still in
      // flight. Pre-fix this fired a second ctx.compact() whose abort() killed
      // the checkpoint; the post-checkpoint chain then fired a third compact
      // and the two raced inside pi core.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("context")?.({ messages }, s.ctx as any);
      assert.equal(
        s.compactCalls.length,
        0,
        "no compact may start while the checkpoint is in flight",
      );

      await waitFor(() => (readState(s.stateFile).checkpointCount ?? 0) >= 1);
      assert.equal(
        readState(s.stateFile).checkpointCount ?? 0,
        1,
        "checkpoint must complete (not aborted by a concurrent compact)",
      );
      assert.equal(readState(s.stateFile).checkpointFailStreak ?? 0, 0);
      assert.equal(
        s.compactCalls.length,
        0,
        "compact stays queued while the run is active (firing would abort the turn)",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("agent_end")?.({}, s.ctx as any);
      assert.equal(
        s.compactCalls.length,
        1,
        "exactly one compact fires at run end, anchored by the settled checkpoint",
      );
      assert.ok(
        (s.compactCalls[0]?.customInstructions ?? "").includes("never drop the prod table"),
        "the chained compact is anchored by the fresh checkpoint",
      );
      assert.ok(capturedSignals.length >= 1, "checkpoint LLM call captured");
      assert.notEqual(
        capturedSignals[0],
        s.ctx.signal,
        "checkpoint must not run on the shared session abort signal",
      );
    } finally {
      await s.cleanup();
    }
  }

  // Scenario B: a pi-side session abort (user Esc, or pi's own compact())
  // lands while a checkpoint LLM call is in flight. The checkpoint runs on
  // its own AbortController, so it still completes.
  {
    const capturedSignals: Array<AbortSignal | undefined> = [];
    const s = await setup("t8b-session", async (opts) => {
      capturedSignals.push(opts?.signal);
      await new Promise((r) => setTimeout(r, 50));
      if (opts?.signal?.aborted) {
        // providers honor the abort signal, surfacing stopReason "aborted"
        return { stopReason: "aborted", content: [] };
      }
      return { stopReason: "stop", content: [{ type: "text", text: VALID_CP }] };
    });
    try {
      const messages = [userMsg("do the task"), assistantText("working on it")];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("session_start")?.({}, s.ctx as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("context")?.({ messages }, s.ctx as any);
      // Abort the shared session signal mid-checkpoint (Esc / pi compact()).
      s.sessionAbort.abort();

      await waitFor(() => (readState(s.stateFile).checkpointCount ?? 0) >= 1);
      assert.equal(
        readState(s.stateFile).checkpointCount ?? 0,
        1,
        "checkpoint survives a session-level abort",
      );
      assert.equal(readState(s.stateFile).checkpointFailStreak ?? 0, 0);
      assert.ok(
        capturedSignals[0] && !capturedSignals[0].aborted,
        "the checkpoint's own signal is unaffected by the session abort",
      );
      // Pressure relief still fires the compact once the (aborted) run ends.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.handlers.get("agent_end")?.({}, s.ctx as any);
      assert.equal(s.compactCalls.length, 1);
    } finally {
      await s.cleanup();
    }
  }
});

test("T2 (D2): Pin matching case normalization", () => {
  // Case A: text pin "CRITICAL_PATH" matched against lowercase text in message
  const textPin: Pin = {
    id: "pin-text",
    type: "constraint",
    content: "CRITICAL_PATH",
    active: true,
    createdAt: Date.now(),
    expires: "session",
  };

  const msgs1 = [userMsg("critical_path is here and must not change")];
  const ensured1 = ensurePinsInContext(msgs1, [textPin]);
  assert.equal(
    ensured1.injected.length,
    0,
    "should recognize existing pin regardless of case",
  );

  // Case B: file pin "/abs/path/to/File.TS" matched against lowercase toolResult path
  const filePin: Pin = {
    id: "pin-file",
    type: "file",
    content: "/abs/path/to/File.TS",
    active: true,
    createdAt: Date.now(),
    expires: "session",
  };

  const readCallId = nextId();
  const msgs2: AnyMessage[] = [
    assistantToolCall("read", { path: "/abs/path/to/file.ts" }, readCallId),
    toolResult("read", "const x = 1;", { id: readCallId }),
  ];

  const classified = classifyMessages(msgs2, { pins: [filePin] });
  const readItem = classified.items.find((i) => i.source === "read");
  assert.ok(readItem, "read item should exist");
  assert.equal(readItem.pinned, true, "classifier should match file pin case-insensitively");

  const ensured2 = ensurePinsInContext(msgs2, [filePin]);
  assert.equal(
    ensured2.injected.length,
    0,
    "should recognize existing file pin in context",
  );

  // Case C (spec T2): text pin "Don't modify X" marks the matching item critical
  const dontPin: Pin = {
    id: "pin-dont",
    type: "constraint",
    content: "Don't modify src/config.ts",
    active: true,
    createdAt: Date.now(),
    expires: "session",
  };
  const msgs3 = [userMsg("remember: don't modify src/config.ts ever"), assistantText("ok")];
  const classified3 = classifyMessages(msgs3, { pins: [dontPin] });
  assert.equal(classified3.items[0].pinned, true, "text pin should mark the matching item");
  assert.equal(classified3.items[0].class, "critical", "pinned item must become critical");

  // Case D (spec T2): two consecutive passes inject the pins message at most once
  const pinOnlyMsgs: AnyMessage[] = [userMsg("hello")];
  const pass1 = ensurePinsInContext(pinOnlyMsgs, [filePin]);
  assert.equal(pass1.injected.length, 1, "first pass injects the missing file pin");
  const pass2 = ensurePinsInContext(pass1.messages, [filePin]);
  assert.equal(pass2.injected.length, 0, "second pass must not re-inject (idempotent)");
});

test("T3 (D3): Checkpoint exponential backoff and circuit breaker", () => {
  const config = { ...DEFAULT_CONFIG };
  const now = Date.now();

  const state1: EngineState = {
    ...DEFAULT_STATE,
    checkpointFailStreak: 1,
    lastCheckpointAttemptAt: now - 5_000, // 5s ago, backoff is 30s
  };

  const dummyAnalysis: ContextAnalysis = {
    totalTokens: 85_000,
    usableTokens: 100_000,
    pressure: 0.85,
    quality: 0.7,
    criticalTokens: 5000,
    workingTokens: 75_000,
    staleTokens: 0,
    disposableTokens: 5000,
    reclaimableTokens: 0,
    items: [],
  };

  // Turn with 1 failure in backoff interval -> checkpoint should NOT be attempted
  const plan1 = planAutomatic(
    { analysis: dummyAnalysis, state: state1, config, checkpointFresh: false, now },
    state1,
    now,
  );
  assert.equal(plan1.checkpoint, false, "should be throttled by backoff after 1 failure");

  // After backoff elapsed (35s > 30s) -> checkpoint is allowed
  const plan2 = planAutomatic(
    { analysis: dummyAnalysis, state: state1, config, checkpointFresh: false, now: now + 35_000 },
    state1,
    now + 35_000,
  );
  assert.equal(plan2.checkpoint, true, "should be allowed after backoff elapses");

  // Circuit breaker: 3 consecutive failures -> circuit broken
  const state3: EngineState = {
    ...DEFAULT_STATE,
    checkpointFailStreak: 3,
    checkpointCircuitBroken: true,
    lastCheckpointAttemptAt: now - 100_000,
  };

  const plan3 = planAutomatic(
    { analysis: dummyAnalysis, state: state3, config, checkpointFresh: false, now: now + 200_000 },
    state3,
    now + 200_000,
  );
  assert.equal(plan3.checkpoint, false, "circuit breaker must disable subsequent checkpoints");
});

test("T4 (D4): Checkpoint freshness multi-factor evaluation", () => {
  const config = { ...DEFAULT_CONFIG };
  const now = Date.now();

  const freshState: EngineState = {
    ...DEFAULT_STATE,
    lastCheckpointAt: now - 60_000, // 1 min ago (< 10min)
    tokensAtLastCheckpoint: 50_000,
    messagesAtLastCheckpoint: 20,
  };

  // Case 1: Fresh (1 min, 5K tokens, 10 messages)
  assert.equal(
    isCheckpointFresh(freshState, config, 55_000, 30, now),
    true,
    "should be fresh",
  );

  // Case 2: Stale because 35 messages elapsed (staleMessages = 30)
  assert.equal(
    isCheckpointFresh(freshState, config, 55_000, 55, now),
    false,
    "should be stale when messages threshold exceeded",
  );

  // Case 3: Stale because 25K tokens grew (staleTokens = 20K)
  assert.equal(
    isCheckpointFresh(freshState, config, 76_000, 25, now),
    false,
    "should be stale when tokens growth threshold exceeded",
  );

  // Case 4: Stale because wall clock elapsed (> 10min)
  assert.equal(
    isCheckpointFresh(freshState, config, 55_000, 25, now + 700_000),
    false,
    "should be stale when wall clock threshold exceeded",
  );
});

test("T5 (D7): Read supersession with offset/limit range awareness", () => {
  const file = "src/example.ts";

  // 1. Disjoint reads: [0, 99] and [200, 299]
  const id1 = nextId();
  const id2 = nextId();
  const msgsDisjoint: AnyMessage[] = [
    assistantToolCall("read", { path: file, offset: 0, limit: 100 }, id1),
    toolResult("read", "lines 0-99", { id: id1 }),
    assistantToolCall("read", { path: file, offset: 200, limit: 100 }, id2),
    toolResult("read", "lines 200-299", { id: id2 }),
  ];
  const toolCallsDisjoint = new Map<string, ResolvedToolCall>([
    [id1, { toolCallId: id1, name: "read", args: { path: file, offset: 0, limit: 100 } }],
    [id2, { toolCallId: id2, name: "read", args: { path: file, offset: 200, limit: 100 } }],
  ]);
  const superDisjoint = computeSupersession(msgsDisjoint, toolCallsDisjoint);
  assert.equal(superDisjoint.superseded.size, 0, "disjoint reads must not supersede each other");

  // 2. Overlapping reads: [0, 99] and [50, 149]
  const id3 = nextId();
  const id4 = nextId();
  const msgsOverlap: AnyMessage[] = [
    assistantToolCall("read", { path: file, offset: 0, limit: 100 }, id3),
    toolResult("read", "lines 0-99", { id: id3 }),
    assistantToolCall("read", { path: file, offset: 50, limit: 100 }, id4),
    toolResult("read", "lines 50-149", { id: id4 }),
  ];
  const toolCallsOverlap = new Map<string, ResolvedToolCall>([
    [id3, { toolCallId: id3, name: "read", args: { path: file, offset: 0, limit: 100 } }],
    [id4, { toolCallId: id4, name: "read", args: { path: file, offset: 50, limit: 100 } }],
  ]);
  const superOverlap = computeSupersession(msgsOverlap, toolCallsOverlap);
  assert.equal(superOverlap.superseded.size, 1, "overlapping read must supersede earlier read");
  assert.ok(superOverlap.superseded.has(1), "first read (msg index 1) is superseded");

  // 3. Full-file read supersedes earlier partial read
  const id5 = nextId();
  const id6 = nextId();
  const msgsFull: AnyMessage[] = [
    assistantToolCall("read", { path: file, offset: 0, limit: 100 }, id5),
    toolResult("read", "lines 0-99", { id: id5 }),
    assistantToolCall("read", { path: file }, id6),
    toolResult("read", "all file content", { id: id6 }),
  ];
  const toolCallsFull = new Map<string, ResolvedToolCall>([
    [id5, { toolCallId: id5, name: "read", args: { path: file, offset: 0, limit: 100 } }],
    [id6, { toolCallId: id6, name: "read", args: { path: file } }],
  ]);
  const superFull = computeSupersession(msgsFull, toolCallsFull);
  assert.equal(superFull.superseded.size, 1, "full-file read must supersede earlier partial read");
});

test("T6 (D8): Conversation serialization preserves head goal and pins", () => {
  const initialGoal = "Fix the memory leak in worker connection pool and implement graceful reconnect";
  const messages: AnyMessage[] = [
    userMsg(initialGoal),
    assistantText("Understood. I will start by inspecting the worker connection pool."),
  ];

  // Add 60 large messages to exceed 120K chars
  for (let i = 0; i < 60; i++) {
    messages.push(bashExecution(`test_command_${i}`, bigText(40, `output_chunk_${i}_`)));
  }

  messages.push(assistantText("Final message near the tail of the conversation"));

  const pins: Pin[] = [
    { id: "p1", type: "constraint", content: "Do not modify public API signatures", active: true, createdAt: Date.now(), expires: "session" },
  ];

  const serialized = serializeConversation(messages, { maxTotalChars: 20_000, pins });

  assert.ok(
    serialized.includes("User (Initial Goal): Fix the memory leak"),
    "serialized text must preserve the initial user goal",
  );
  assert.ok(
    serialized.includes("Do not modify public API signatures"),
    "serialized text must preserve active pins",
  );
  assert.ok(
    serialized.includes("Final message near the tail"),
    "serialized text must preserve the tail conversation window",
  );
  assert.ok(
    serialized.length <= 22_000,
    "serialized text should respect the character limit budget",
  );
});

// ===========================================================================
// 12.2 Scenario Integration Tests (S1 - S5)
// ===========================================================================

test("S1: Lifecycle pressure escalation stages", () => {
  const config = { ...DEFAULT_CONFIG };
  const state: EngineState = { ...DEFAULT_STATE };

  const makeAnalysis = (pressure: number, reclaimable: number, quality = 0.8): ContextAnalysis => ({
    totalTokens: Math.round(pressure * 100_000),
    usableTokens: 100_000,
    pressure,
    quality,
    criticalTokens: 5000,
    workingTokens: Math.round(pressure * 100_000) - reclaimable - 5000,
    staleTokens: reclaimable,
    disposableTokens: 0,
    reclaimableTokens: reclaimable,
    items: [],
  });

  // Stage 1: 40% pressure -> none
  const d1 = decide({
    analysis: makeAnalysis(0.40, 1000),
    state,
    config,
    checkpointFresh: true,
  });
  assert.equal(d1.action, "none");

  // Stage 2: 70% pressure + 8K reclaimable -> prune
  const d2 = decide({
    analysis: makeAnalysis(0.70, 8000),
    state,
    config,
    checkpointFresh: true,
  });
  assert.equal(d2.action, "prune");

  // Stage 3: 82% pressure + 0 reclaimable + no fresh checkpoint -> checkpoint
  const d3 = decide({
    analysis: makeAnalysis(0.82, 0),
    state,
    config,
    checkpointFresh: false,
  });
  assert.equal(d3.action, "checkpoint");

  // Stage 4: 90% pressure + fresh checkpoint -> compact
  const d4 = decide({
    analysis: makeAnalysis(0.90, 0),
    state,
    config,
    checkpointFresh: true,
  });
  assert.equal(d4.action, "compact");

  // Stage 5: 96% pressure + 2 compactions + low quality (0.4) -> handoff
  const stateHandoff: EngineState = { ...state, compactionCount: 2 };
  const d5 = decide({
    analysis: makeAnalysis(0.96, 0, 0.4),
    state: stateHandoff,
    config,
    checkpointFresh: true,
  });
  assert.equal(d5.action, "handoff");
});

test("S2: Action rate limiting (max 3 actions per 10 turns)", () => {
  const config = { ...DEFAULT_CONFIG };
  const now = Date.now();

  const dummyAnalysis: ContextAnalysis = {
    totalTokens: 70_000,
    usableTokens: 100_000,
    pressure: 0.70,
    quality: 0.8,
    criticalTokens: 5000,
    workingTokens: 55_000,
    staleTokens: 10_000,
    disposableTokens: 0,
    reclaimableTokens: 10_000,
    items: [],
  };

  // State with 3 recent prunes in action history
  const state: EngineState = {
    ...DEFAULT_STATE,
    actionHistory: [
      { action: "prune", timestamp: now - 30_000 },
      { action: "prune", timestamp: now - 20_000 },
      { action: "prune", timestamp: now - 10_000 },
    ],
  };

  const plan = planAutomatic(
    { analysis: dummyAnalysis, state, config, checkpointFresh: true, now },
    state,
    now,
  );

  assert.equal(plan.prune, false, "prune should be throttled after 3 triggers");
  assert.deepEqual(plan.throttledActions, ["prune"], "throttledActions should include prune");
});

test("S3: Degradation protection and adaptive thresholds", () => {
  const config = { ...DEFAULT_CONFIG };
  const state: EngineState = {
    ...DEFAULT_STATE,
    consecutiveIneffectiveCompacts: 2,
    adaptiveCompactEnterDelta: 0.08,
  };

  // Default compact enter is 0.88, with adaptive delta 0.08 it becomes 0.96
  const analysis92: ContextAnalysis = {
    totalTokens: 92_000,
    usableTokens: 100_000,
    pressure: 0.92,
    quality: 0.8,
    criticalTokens: 5000,
    workingTokens: 87_000,
    staleTokens: 0,
    disposableTokens: 0,
    reclaimableTokens: 0,
    items: [],
  };

  const d = decide({
    analysis: analysis92,
    state,
    config,
    checkpointFresh: true,
  });

  // At 0.92 pressure, default compact (0.88) would trigger, but adaptive threshold (0.96) defers it
  assert.equal(d.action, "none", "adaptive threshold should defer compact when previous were ineffective");
});

test("S4: CJK token estimation accuracy", () => {
  // Pure English: 12 chars -> ~3 tokens (ceil(12/4))
  const en = "Hello world!";
  assert.equal(estimateTextTokens(en), 3);

  // Pure CJK: 6 characters -> 4 tokens (ceil(6 / 1.5))
  const cjk = "你好，世界！";
  assert.equal(estimateTextTokens(cjk), 4);

  // Mixed CJK and English: 6 CJK chars + 12 English chars -> 4 + 3 = 7 tokens
  const mixed = "Hello world! 你好世界！";
  const estimated = estimateTextTokens(mixed);
  assert.ok(estimated >= 6 && estimated <= 8, `estimated ${estimated} should be around 7`);
});

test("S5: Configuration migration and specificity sorting", () => {
  // 1. Migration of flat thresholds to enter/exit pairs
  const rawFlatConfig = {
    thresholds: {
      prune: 0.60,
      checkpoint: 0.75,
      compact: 0.85,
      handoff: 0.92,
    },
  };

  const { config: migrated, events } = sanitizeAndMigrateConfig(rawFlatConfig);
  assert.equal(migrated.thresholds.prune.enter, 0.60);
  assert.equal(migrated.thresholds.prune.exit, 0.50);
  assert.equal(migrated.thresholds.checkpoint.enter, 0.75);
  assert.equal(migrated.thresholds.checkpoint.exit, 0.65);
  assert.equal(migrated.thresholds.compact.enter, 0.85);
  assert.equal(migrated.thresholds.compact.exit, 0.75);
  assert.equal(migrated.thresholds.handoff.enter, 0.92);
  assert.ok(events.some((e) => e.action === "config_migrated"));

  // 2. Pattern specificity ranking: exact match > long prefix > *
  const specExact = patternSpecificity("openai/gpt-4o");
  const specPrefix = patternSpecificity("openai/*");
  const specAll = patternSpecificity("*");

  assert.ok(specExact.rank > specPrefix.rank, "exact rank > prefix rank");
  assert.ok(specPrefix.rank > specAll.rank, "prefix rank > wildcard rank");

  const rules = compileModelRules({
    "*": { prune: 0.5 },
    "anthropic/claude-3-5-sonnet": { prune: 0.7 },
    "anthropic/*": { prune: 0.6 },
  });

  assert.equal(rules[0].pattern, "anthropic/claude-3-5-sonnet", "exact match should be first");
  assert.equal(rules[1].pattern, "anthropic/*", "prefix match should be second");
  assert.equal(rules[2].pattern, "*", "wildcard match should be last");
});

test("Bash output folding ±2 context window around error lines (§8.3)", () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    if (i === 25) {
      lines.push("FAILED test_login: assertion error");
    } else {
      lines.push(`info line ${i}: normal execution log`);
    }
  }

  const folded = foldBashOutput("npm test", lines.join("\n"), true);
  assert.ok(folded.includes("FAILED test_login"), "should include error line");
  assert.ok(folded.includes("info line 23"), "should include line -2 before error");
  assert.ok(folded.includes("info line 24"), "should include line -1 before error");
  assert.ok(folded.includes("info line 26"), "should include line +1 after error");
  assert.ok(folded.includes("info line 27"), "should include line +2 after error");
});

// ===========================================================================
// Wrap-up regression tests (review findings B1/B2/B3)
// ===========================================================================

test("D5: recompute reflects pruned tokens even when Pi usage is available", () => {
  const config = { ...DEFAULT_CONFIG };
  const calibrator = new TokenCalibrator(20);
  const messages = [
    userMsg("task"),
    toolResult("bash", bigText(200, "y")),
    assistantText("done"),
  ];
  const usage = { tokens: 100_000, contextWindow: 200_000 };
  const { analysis, meter } = analyzeContext({
    messages,
    usage,
    model: { provider: "t", id: "m", contextWindow: 200_000 },
    config,
    calibrator,
  });
  assert.equal(analysis.totalTokens, 100_000, "usage.tokens is authoritative pre-prune");

  // Simulate a prune result: the big tool result is replaced by a tiny stub.
  const pruned: AnyMessage[] = [
    messages[0],
    { ...messages[1], content: [{ type: "text", text: "[stub]" }] },
    messages[2],
  ];
  const re = meter.recompute(analysis, {
    context: pruned,
    removedTokens: 50_000,
    preservedTokens: 100,
    actions: [],
  });
  assert.ok(
    re.totalTokens < 100_000,
    `post-prune total must not be the stale pre-prune usage value (got ${re.totalTokens})`,
  );
  assert.ok(
    re.pressure < analysis.pressure,
    `post-prune pressure (${re.pressure}) must drop below pre-prune (${analysis.pressure})`,
  );
});

test("§10.4: resolveThresholds — most specific matching pattern wins", () => {
  const { config } = sanitizeAndMigrateConfig({
    models: {
      "*": { prune: 0.5 },
      "qwen*": { prune: 0.6 },
      "qwen/qwen3-coder": { prune: 0.7 },
    },
  });
  assert.equal(
    resolveThresholds(config, { provider: "qwen", id: "qwen3-coder" }).prune.enter,
    0.7,
    "exact match beats prefix and wildcard",
  );
  assert.equal(
    resolveThresholds(config, { provider: "qwen", id: "qwen2" }).prune.enter,
    0.6,
    "prefix beats wildcard",
  );
  assert.equal(
    resolveThresholds(config, { provider: "other", id: "x" }).prune.enter,
    0.5,
    "wildcard applies when nothing else matches",
  );
});

test("§5.2/D6: reclaimableMin honors model-specific override", () => {
  const { config } = sanitizeAndMigrateConfig({
    policy: { reclaimableMin: 5000 },
    models: { "qwen*": { reclaimableMin: 1234 } },
  });
  assert.equal(resolveReclaimableMin(config, { provider: "qwen", id: "a" }), 1234);
  assert.equal(resolveReclaimableMin(config, { provider: "other", id: "b" }), 5000);
  assert.equal(resolveReclaimableMin(config, null), 5000);
});

test("§6 hysteresis: latched band resets only after 2 consecutive turns below exit", () => {
  const config = { ...DEFAULT_CONFIG };
  const state: EngineState = { ...DEFAULT_STATE };
  const t = resolveThresholds(config, null);

  markBandActive(state, "compact");
  assert.equal(state.bandActive?.compact, true);

  updateHysteresisBands(state, 0.70, t); // below exit 0.78, streak 1
  assert.equal(state.bandActive?.compact, true, "one low turn is not enough");
  updateHysteresisBands(state, 0.70, t); // streak 2 → release
  assert.equal(state.bandActive?.compact, false, "two consecutive low turns reset the latch");

  // A turn back above exit resets the streak (not the latch).
  markBandActive(state, "compact");
  updateHysteresisBands(state, 0.70, t); // streak 1
  updateHysteresisBands(state, 0.80, t); // above exit → streak reset
  updateHysteresisBands(state, 0.70, t); // streak 1 again
  assert.equal(state.bandActive?.compact, true, "streak interrupted by high turn");
  updateHysteresisBands(state, 0.70, t); // streak 2 → release
  assert.equal(state.bandActive?.compact, false);

  // Mutation must not leak into DEFAULT_STATE (shared reference guard).
  assert.equal(DEFAULT_STATE.bandActive?.compact, false);
});

test("§6 hysteresis: latched band suppresses re-entry in decide", () => {
  const config = { ...DEFAULT_CONFIG };
  const analysis: ContextAnalysis = {
    totalTokens: 90_000,
    usableTokens: 100_000,
    pressure: 0.90,
    quality: 0.8,
    criticalTokens: 5000,
    workingTokens: 85_000,
    staleTokens: 0,
    disposableTokens: 0,
    reclaimableTokens: 0,
    items: [],
  };

  const latched: EngineState = {
    ...DEFAULT_STATE,
    bandActive: { prune: false, checkpoint: false, compact: true },
  };
  const d1 = decide({ analysis, state: latched, config, checkpointFresh: true });
  assert.notEqual(d1.action, "compact", "latched compact band must not re-enter");

  const unlatched: EngineState = { ...DEFAULT_STATE };
  const d2 = decide({ analysis, state: unlatched, config, checkpointFresh: true });
  assert.equal(d2.action, "compact", "unlatched band enters normally");
});
