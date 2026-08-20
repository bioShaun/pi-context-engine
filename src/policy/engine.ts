/**
 * Policy Engine (spec §43 "Better Policy", §21 decision matrix).
 *
 * Decisions consider pressure AND quality together, and honor config
 * toggles (auto.prune / auto.checkpoint / auto.compact, handoff.mode).
 */

import type {
  ContextAnalysis,
  ContextPolicyDecision,
  EngineState,
} from "../types.ts";
import type { ContextEngineConfig } from "../config.ts";
import { resolveThresholds } from "../config.ts";
import type { ModelInfo } from "../observer/context-observer.ts";

export interface DecideInputs {
  analysis: ContextAnalysis;
  state: EngineState;
  config: ContextEngineConfig;
  model?: ModelInfo | null;
  /** Is there a fresh (recently written) checkpoint? */
  checkpointFresh: boolean;
  now?: number;
}

/** Handoff gate (spec §17, §27): pressure + compact history + quality. */
export function shouldHandoff(inputs: DecideInputs): boolean {
  const t = resolveThresholds(inputs.config, inputs.model);
  const a = inputs.analysis;
  return (
    a.pressure >= t.handoff &&
    inputs.state.compactionCount >= 2 &&
    a.quality < 0.5
  );
}

export function decide(inputs: DecideInputs): ContextPolicyDecision {
  const { analysis: a, state, config } = inputs;
  const t = resolveThresholds(config, inputs.model);
  const now = inputs.now ?? Date.now();

  const base = (action: ContextPolicyDecision["action"], reason: string, after?: number) =>
    ({ action, reason, pressureBefore: a.pressure, estimatedPressureAfter: after }) as const;

  // 1. Low pressure + healthy quality → do nothing.
  if (a.pressure < config.pressure.green && a.quality > 0.6) {
    return base("none", "pressure low and quality healthy");
  }

  // 2. Enough reclaimable garbage → prune (cheap, non-destructive).
  if (a.pressure >= t.prune && a.reclaimableTokens > 5_000) {
    const after = Math.max(0, (a.totalTokens - a.reclaimableTokens) / a.usableTokens);
    return base("prune", `pressure ${pct(a.pressure)} with ~${Math.round(a.reclaimableTokens)} reclaimable tokens`, after);
  }

  // 3. High pressure without a fresh checkpoint → checkpoint first.
  if (a.pressure >= t.checkpoint && !inputs.checkpointFresh) {
    return base("checkpoint", `pressure ${pct(a.pressure)} and no fresh checkpoint`);
  }

  // 4. Repeated compactions + poor quality → handoff outranks compact
  //    (handoff resets cognitive state; compact would only re-pack noise).
  if (shouldHandoff(inputs)) {
    return base("handoff", `pressure ${pct(a.pressure)}, ${state.compactionCount} compactions, quality ${pct(a.quality)}`);
  }

  // 5. Very high → compact.
  if (a.pressure >= t.compact) {
    return base("compact", `pressure ${pct(a.pressure)} past compact threshold`);
  }

  return base("none", `within policy (pressure ${pct(a.pressure)}, quality ${pct(a.quality)})`);
}

/**
 * Sequence of automatic steps for the `context` event (spec §42, §26).
 * Each step is guarded by config toggles and cooldowns.
 */
export interface AutoPlan {
  prune: boolean;
  checkpoint: boolean;
  compact: boolean;
  handoffSuggest: boolean;
  decision: ContextPolicyDecision;
}

export function planAutomatic(
  inputs: DecideInputs,
  state: EngineState,
  now: number = Date.now(),
): AutoPlan {
  const decision = decide(inputs);
  const cfg = inputs.config;
  return {
    prune:
      decision.action === "prune" &&
      cfg.auto.prune &&
      now - state.lastPruneAt >= cfg.cooldowns.pruneMs,
    checkpoint:
      (decision.action === "checkpoint" || decision.action === "compact") &&
      cfg.auto.checkpoint &&
      !inputs.checkpointFresh,
    compact:
      decision.action === "compact" &&
      cfg.auto.compact &&
      now - state.lastCompactAt >= cfg.cooldowns.compactMs,
    handoffSuggest: decision.action === "handoff",
    decision,
  };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
