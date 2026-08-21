/**
 * Unified Token Meter (spec §4, §10).
 *
 * Implements the single-meter principle (P2):
 * - One authoritative meter for pressure, quality, reclaimable, never-enlarge, and post-prune recompute.
 * - Single-turn memoization for fast-path performance (< 20ms).
 * - Calibration tracking with moving-average ratio over a 20-turn window.
 */

import type { AnyMessage, ContextAnalysis, ContextItem, Meter, PruneResult } from "../types.ts";
import { estimateMessageTokens, estimateTextTokens, messageText } from "./token-estimator.ts";
import type { ContextEngineConfig } from "../config.ts";

export interface UsageInfo {
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

const STUB_COST = 80;
const FOLD_COST = 260;

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

export class TokenCalibrator {
  private ratios: number[] = [];
  private readonly windowSize: number;

  constructor(windowSize = 20) {
    this.windowSize = windowSize;
  }

  record(reported: number, estimated: number): void {
    if (estimated <= 0 || reported <= 0) return;
    const ratio = reported / estimated;
    this.ratios.push(ratio);
    if (this.ratios.length > this.windowSize) {
      this.ratios.shift();
    }
  }

  getRatio(): number {
    if (this.ratios.length === 0) return 1.0;
    const sum = this.ratios.reduce((a, b) => a + b, 0);
    return sum / this.ratios.length;
  }

  clear(): void {
    this.ratios = [];
  }
}

export interface MeterOptions {
  usage?: UsageInfo | null;
  model?: ModelInfo | null;
  config: ContextEngineConfig;
  customEstimator?: (msg: AnyMessage) => number;
  calibrator?: TokenCalibrator;
}

export class ContextMeter implements Meter {
  readonly usage?: UsageInfo | null;
  readonly model?: ModelInfo | null;
  readonly config: ContextEngineConfig;
  readonly customEstimator?: (msg: AnyMessage) => number;
  readonly calibrator?: TokenCalibrator;

  // Single-turn memoization caches (spec §10.2)
  private readonly msgTokenCache = new WeakMap<AnyMessage, number>();
  private readonly msgTextCache = new WeakMap<AnyMessage, string>();
  /** Raw per-message estimate sum from the latest total() call (for calibrate()). */
  private lastRawSum = 0;

  constructor(options: MeterOptions) {
    this.usage = options.usage;
    this.model = options.model;
    this.config = options.config;
    this.customEstimator = options.customEstimator;
    this.calibrator = options.calibrator;
  }

  messageText(msg: AnyMessage): string {
    let text = this.msgTextCache.get(msg);
    if (text === undefined) {
      text = messageText(msg);
      this.msgTextCache.set(msg, text);
    }
    return text;
  }

  tokens(msg: AnyMessage): number {
    let count = this.msgTokenCache.get(msg);
    if (count !== undefined) return count;

    if (this.customEstimator) {
      try {
        count = this.customEstimator(msg);
      } catch {
        count = estimateMessageTokens(msg);
      }
    } else {
      count = estimateMessageTokens(msg);
    }

    this.msgTokenCache.set(msg, count);
    return count;
  }

  textTokens(text: string): number {
    return estimateTextTokens(text);
  }

  total(messages: readonly AnyMessage[]): number {
    let rawEstimatedSum = 0;
    for (const msg of messages) {
      rawEstimatedSum += this.tokens(msg);
    }
    this.lastRawSum = rawEstimatedSum;

    // 1. Authoritative Pi-reported usage
    if (this.usage?.tokens != null && this.usage.tokens > 0) {
      if (this.calibrator) {
        this.calibrator.record(this.usage.tokens, rawEstimatedSum);
      }
      return this.usage.tokens;
    }

    // 2. Calibrated estimation (spec §4.3)
    return this.calibratedTotal(rawEstimatedSum);
  }

  private calibratedTotal(rawEstimatedSum: number): number {
    const ratio = this.calibrator ? this.calibrator.getRatio() : 1.0;
    const calibrated = Math.round(rawEstimatedSum * ratio);
    return Math.max(1, calibrated + this.config.reserves.system);
  }

  /**
   * Estimated total WITHOUT the Pi-usage override and WITHOUT recording a
   * calibration sample. Used by recompute() for post-prune re-estimation:
   * `usage.tokens` was measured by Pi *before* this context event and cannot
   * reflect the prune, so routing recompute through total() would make
   * post-prune pressure equal pre-prune pressure (D5, spec §3).
   */
  estimatedTotal(messages: readonly AnyMessage[]): number {
    let rawEstimatedSum = 0;
    for (const msg of messages) {
      rawEstimatedSum += this.tokens(msg);
    }
    return this.calibratedTotal(rawEstimatedSum);
  }

  calibrate(reported: number): void {
    // Record a sample against the most recent raw estimate. total() already
    // auto-calibrates when usage is present; this entry point exists for
    // callers that obtain a reported total out of band (spec §4.1).
    if (this.calibrator && reported > 0 && this.lastRawSum > 0) {
      this.calibrator.record(reported, this.lastRawSum);
    }
  }

  getUsableTokens(): number {
    const window = this.usage?.contextWindow ?? this.model?.contextWindow ?? 200_000;
    const outputReserve =
      this.model?.maxTokens && this.model.maxTokens > 0
        ? Math.min(this.config.reserves.output, this.model.maxTokens)
        : this.config.reserves.output;
    return Math.max(1024, window - outputReserve - this.config.reserves.safety);
  }

  recompute(a: ContextAnalysis, r: PruneResult): ContextAnalysis {
    const usableTokens = a.usableTokens;
    const totalTokens = Math.max(1, this.estimatedTotal(r.context));
    const pressure = Math.max(0, Math.min(2, totalTokens / usableTokens));

    let criticalTokens = 0;
    let workingTokens = 0;
    let staleTokens = 0;
    let disposableTokens = 0;

    const items: ContextItem[] = [];
    for (let i = 0; i < r.context.length; i++) {
      const origItem = a.items[i];
      const newMsg = r.context[i];
      const newTokens = this.tokens(newMsg);

      if (origItem) {
        const updatedItem: ContextItem = {
          ...origItem,
          estimatedTokens: newTokens,
        };
        items.push(updatedItem);

        switch (updatedItem.class) {
          case "critical":
            criticalTokens += newTokens;
            break;
          case "working":
            workingTokens += newTokens;
            break;
          case "stale":
            staleTokens += newTokens;
            break;
          case "disposable":
            disposableTokens += newTokens;
            break;
        }
      }
    }

    const signalTokens = criticalTokens + workingTokens;
    const allTokens = criticalTokens + workingTokens + staleTokens + disposableTokens;
    const quality = allTokens > 0 ? Math.max(0, Math.min(1, signalTokens / allTokens)) : 1;

    const reclaimableTokens = items.reduce(
      (sum, it) => sum + itemReclaimable(it, this.config.limits.stubMinTokens),
      0,
    );

    return {
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
    };
  }
}
