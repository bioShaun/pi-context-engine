/**
 * Context Observer (spec §5 layer 2, §41, §20).
 *
 * Combines token estimation + rule classification into a single
 * ContextAnalysis. Fast path target: < 20 ms/turn (spec §37).
 */

import type {
  AnyMessage,
  ContextAnalysis,
  ContextItem,
  Pin,
} from "../types.ts";
import type { RuleOptions } from "../classifier/rules.ts";
import { classifyMessages, type ClassifyResult } from "../classifier/classifier.ts";
import { estimateContextTokens } from "./token-estimator.ts";
import type { ContextEngineConfig } from "../config.ts";

export interface UsageInfo {
  /** Pi-reported context tokens (null = unknown, e.g. right after compaction). */
  tokens: number | null;
  contextWindow: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens?: number;
}

export interface ObserverInputs {
  messages: readonly AnyMessage[];
  usage?: UsageInfo | null;
  model?: ModelInfo | null;
  config: ContextEngineConfig;
  pins?: Pin[];
  /**
   * Optional accurate estimator (e.g. Pi's own estimateTokens). When absent,
   * the fast char-based heuristic is used (spec §32: prefer pi usage when
   * available; estimates are fine otherwise).
   */
  tokenEstimator?: (msg: AnyMessage) => number;
}

const STUB_COST = 80; // measured size of a typical stub line
const FOLD_COST = 260;

/**
 * Estimate how many tokens an item would cost after pruning:
 *  - stale/disposable → stub cost
 *  - oversized working → fold cost
 *  - otherwise → unchanged (reclaimable 0)
 */
export function itemReclaimable(item: ContextItem, minTokens: number): number {
  if (item.engineStub || item.pinned || item.class === "critical") return 0;
  if (item.type !== "tool-result" && item.type !== "bash") return 0;
  if (item.estimatedTokens < minTokens) return 0;
  if (item.class === "stale" || item.class === "disposable") {
    return Math.max(0, item.estimatedTokens - STUB_COST);
  }
  if (item.class === "working" && item.tags.includes("oversized")) {
    return Math.max(0, item.estimatedTokens - FOLD_COST);
  }
  return 0;
}

export interface AnalysisResult {
  analysis: ContextAnalysis;
  classify: ClassifyResult;
}

export function analyzeContext(inputs: ObserverInputs): AnalysisResult {
  const { messages, usage, model, config, pins, tokenEstimator } = inputs;
  const rules: Required<RuleOptions> = {
    oversizedTokens: config.limits.oversizedTokens,
    recentWindow: config.limits.recentWindow,
  };

  const classify = classifyMessages(messages, { rules, pins, tokenEstimator });
  const items = classify.items;

  const criticalTokens = sumBy(items, "critical");
  const workingTokens = sumBy(items, "working");
  const staleTokens = sumBy(items, "stale");
  const disposableTokens = sumBy(items, "disposable");
  const estimatedTotal = tokenEstimator
    ? messages.reduce((sum, m) => sum + tokenEstimator(m), 0)
    : estimateContextTokens(messages);

  const window = usage?.contextWindow ?? model?.contextWindow ?? 200_000;
  const outputReserve =
    model?.maxTokens && model.maxTokens > 0
      ? Math.min(config.reserves.output, model.maxTokens)
      : config.reserves.output;
  const usableTokens = Math.max(1024, window - outputReserve - config.reserves.safety);

  // Prefer pi-reported usage; fall back to estimates + system reserve.
  const currentTokens =
    usage?.tokens != null ? usage.tokens : estimatedTotal + config.reserves.system;

  const totalTokens = Math.max(currentTokens, 1);
  const pressure = clamp(totalTokens / usableTokens, 0, 2);

  const signalTokens = criticalTokens + workingTokens;
  const quality =
    criticalTokens + workingTokens + staleTokens + disposableTokens > 0
      ? clamp(signalTokens / (criticalTokens + workingTokens + staleTokens + disposableTokens), 0, 1)
      : 1;

  const reclaimableTokens = items.reduce(
    (sum, it) => sum + itemReclaimable(it, config.limits.stubMinTokens),
    0,
  );

  return {
    analysis: {
      totalTokens,
      usableTokens,
      pressure,
      criticalTokens,
      workingTokens,
      staleTokens,
      disposableTokens,
      quality,
      reclaimableTokens,
      items,
    },
    classify,
  };
}

function sumBy(items: ContextItem[], cls: ContextItem["class"]): number {
  let n = 0;
  for (const it of items) if (it.class === cls) n += it.estimatedTokens;
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
