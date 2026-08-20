import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, planAutomatic, shouldHandoff } from "../src/policy/engine.ts";
import { resolveThresholds, loadConfig } from "../src/config.ts";
import { bandLabel } from "../src/policy/thresholds.ts";
import { DEFAULT_STATE } from "../src/state.ts";
import type { ContextAnalysis, EngineState } from "../src/types.ts";

function makeAnalysis(pressure: number, quality: number, reclaimable = 0): ContextAnalysis {
  return {
    totalTokens: Math.round(pressure * 200_000),
    usableTokens: 200_000,
    pressure,
    criticalTokens: Math.round(quality * pressure * 200_000 * 0.5),
    workingTokens: Math.round(quality * pressure * 200_000 * 0.5),
    staleTokens: 0,
    disposableTokens: 0,
    quality,
    reclaimableTokens: reclaimable,
    items: [],
  };
}

function makeState(over: Partial<EngineState> = {}): EngineState {
  return { ...DEFAULT_STATE, ...over };
}

const config = loadConfig();

test("low pressure + good quality → none", () => {
  const d = decide({
    analysis: makeAnalysis(0.4, 0.8),
    state: makeState(),
    config,
    checkpointFresh: false,
  });
  assert.equal(d.action, "none");
});

test("high pressure + reclaimable → prune", () => {
  const d = decide({
    analysis: makeAnalysis(0.7, 0.6, 30_000),
    state: makeState(),
    config,
    checkpointFresh: true,
  });
  assert.equal(d.action, "prune");
  assert.ok(d.estimatedPressureAfter !== undefined && d.estimatedPressureAfter < 0.7);
});

test("no reclaimable garbage at high pressure → checkpoint", () => {
  const d = decide({
    analysis: makeAnalysis(0.85, 0.6, 0),
    state: makeState(),
    config,
    checkpointFresh: false,
  });
  assert.equal(d.action, "checkpoint");
});

test("fresh checkpoint + very high pressure → compact", () => {
  const d = decide({
    analysis: makeAnalysis(0.92, 0.6, 0),
    state: makeState(),
    config,
    checkpointFresh: true,
  });
  assert.equal(d.action, "compact");
});

test("handoff gate: pressure + compactions + poor quality", () => {
  const state = makeState({ compactionCount: 2 });
  const inputs = {
    analysis: makeAnalysis(0.95, 0.3, 0),
    state,
    config,
    checkpointFresh: true,
  };
  assert.ok(shouldHandoff(inputs));
  const d = decide(inputs);
  assert.equal(d.action, "handoff");

  // Only one compaction → not enough.
  assert.ok(!shouldHandoff({ ...inputs, state: makeState({ compactionCount: 1 }) }));
  // Good quality → not enough.
  assert.ok(!shouldHandoff({ ...inputs, analysis: makeAnalysis(0.95, 0.6) }));
});

test("planAutomatic honors auto.* toggles", () => {
  const noPrune = { ...config, auto: { ...config.auto, prune: false } };
  const plan = planAutomatic(
    {
      analysis: makeAnalysis(0.7, 0.6, 30_000),
      state: makeState(),
      config: noPrune,
      checkpointFresh: true,
    },
    makeState(),
    Date.now(),
  );
  assert.equal(plan.prune, false);
  assert.equal(plan.decision.action, "prune", "decision still prune, execution gated");

  const plan2 = planAutomatic(
    {
      analysis: makeAnalysis(0.7, 0.6, 30_000),
      state: makeState(),
      config,
      checkpointFresh: true,
    },
    makeState(),
    Date.now(),
  );
  assert.equal(plan2.prune, true);
});

test("planAutomatic prune cooldown respected", () => {
  const now = 1_000_000;
  const plan = planAutomatic(
    {
      analysis: makeAnalysis(0.7, 0.6, 30_000),
      state: makeState(),
      config,
      checkpointFresh: true,
    },
    makeState({ lastPruneAt: now - 1000 }), // 1s ago < cooldown
    now,
  );
  assert.equal(plan.prune, false);
});

test("resolveThresholds applies model globs", () => {
  const cfg = {
    ...config,
    models: {
      "qwen*": { prune: 0.5, compact: 0.7 },
      "testprovider/testmodel": { prune: 0.42 },
    },
  };
  assert.equal(resolveThresholds(cfg, { provider: "qwen", id: "qwen3-coder" }).prune, 0.5);
  assert.equal(resolveThresholds(cfg, { provider: "qwen", id: "qwen3-coder" }).compact, 0.7);
  assert.equal(resolveThresholds(cfg, { provider: "testprovider", id: "testmodel" }).prune, 0.42);
  assert.equal(resolveThresholds(cfg, { provider: "other", id: "model" }).prune, config.thresholds.prune);
});

test("bandLabel matches spec bands", () => {
  assert.equal(bandLabel(0.5), "green");
  assert.equal(bandLabel(0.6), "yellow");
  assert.equal(bandLabel(0.75), "orange");
  assert.equal(bandLabel(0.85), "red");
  assert.equal(bandLabel(0.95), "critical");
});
