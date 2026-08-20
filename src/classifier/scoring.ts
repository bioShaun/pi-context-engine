/**
 * Importance scoring (spec §8): simple, rule-based, no black box.
 */

import type { ContextClass } from "../types.ts";

export const BASE_IMPORTANCE: Record<ContextClass, number> = {
  critical: 100,
  working: 60,
  stale: 25,
  disposable: 10,
};

export const SPEC_TABLE = {
  system: 100,
  latestUser: 100,
  pinned: 100,
  activeFailure: 90,
  activeDiff: 85,
  recentFileRead: 70,
  assistantReasoning: 60,
  successfulTool: 30,
  duplicateTool: 10,
  noise: 5,
} as const;

/**
 * importance = base(class) + bonuses - penalties, clamped to [0, 100].
 */
export function scoreImportance(
  base: number,
  opts: {
    recencyBonus?: number;
    failureBonus?: number;
    pinBonus?: number;
    duplicatePenalty?: number;
    supersededPenalty?: number;
    verbosityPenalty?: number;
  } = {},
): number {
  let n =
    base +
    (opts.recencyBonus ?? 0) +
    (opts.failureBonus ?? 0) +
    (opts.pinBonus ?? 0) -
    (opts.duplicatePenalty ?? 0) -
    (opts.supersededPenalty ?? 0) -
    (opts.verbosityPenalty ?? 0);
  return Math.max(0, Math.min(100, n));
}
