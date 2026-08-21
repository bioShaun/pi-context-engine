import type {
  AnyMessage,
  ContextAnalysis,
  ContextItem,
  Pin,
} from "../types.ts";
import type { RuleOptions } from "../classifier/rules.ts";
import { classifyMessages, type ClassifyResult } from "../classifier/classifier.ts";
import type { ContextEngineConfig } from "../config.ts";
import {
  ContextMeter,
  TokenCalibrator,
  itemReclaimable,
  type UsageInfo,
  type ModelInfo,
} from "./meter.ts";

export { itemReclaimable, TokenCalibrator, ContextMeter, type UsageInfo, type ModelInfo };

export interface ObserverInputs {
  messages: readonly AnyMessage[];
  usage?: UsageInfo | null;
  model?: ModelInfo | null;
  config: ContextEngineConfig;
  pins?: Pin[];
  tokenEstimator?: (msg: AnyMessage) => number;
  meter?: ContextMeter;
  calibrator?: TokenCalibrator;
}

export interface AnalysisResult {
  analysis: ContextAnalysis;
  classify: ClassifyResult;
  meter: ContextMeter;
}

export function analyzeContext(inputs: ObserverInputs): AnalysisResult {
  const { messages, usage, model, config, pins, tokenEstimator, calibrator } = inputs;
  const meter =
    inputs.meter ??
    new ContextMeter({
      usage,
      model,
      config,
      customEstimator: tokenEstimator,
      calibrator,
    });

  const rules: Required<RuleOptions> = {
    oversizedTokens: config.limits.oversizedTokens,
    recentWindow: config.limits.recentWindow,
  };

  const classify = classifyMessages(messages, {
    rules,
    pins,
    tokenEstimator: (msg) => meter.tokens(msg),
  });
  const items = classify.items;

  const criticalTokens = sumBy(items, "critical");
  const workingTokens = sumBy(items, "working");
  const staleTokens = sumBy(items, "stale");
  const disposableTokens = sumBy(items, "disposable");

  const usableTokens = meter.getUsableTokens();
  const totalTokens = Math.max(meter.total(messages), 1);
  const pressure = clamp(totalTokens / usableTokens, 0, 2);

  const signalTokens = criticalTokens + workingTokens;
  const allTokens = criticalTokens + workingTokens + staleTokens + disposableTokens;
  const quality = allTokens > 0 ? clamp(signalTokens / allTokens, 0, 1) : 1;

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
    meter,
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

