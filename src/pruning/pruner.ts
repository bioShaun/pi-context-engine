/**
 * Context pruner (spec §10, §33, §34; v0.3 §6, §7, §12, §13).
 *
 * Safety rules:
 *  - Only `toolResult` / `bashExecution` messages are ever touched.
 *    User, assistant, summary, and pinned messages are NEVER modified.
 *  - Tool results are *replaced in place* (same role/toolCallId/toolName)
 *    so provider tool-call pairing always holds. Nothing is dropped.
 *  - Idempotent: replacements carry `details.engine === ENGINE_ID` and are
 *    skipped on subsequent passes (§34).
 *  - Read-only input: builds a new array; the source is not mutated (§33).
 *
 * v0.3 (pi-native-recall spec):
 *  - Every applied prune action carries a RecoveryRef into the session
 *    branch (§6.3) plus `level` (1 = fold, 3 = stub; §13).
 *  - Stubs use the enhanced deterministic format when enabled (§7), with
 *    the legacy generic stub as fallback.
 *  - Optional prefix-cache-aware candidate ordering (§12) — a pure,
 *    exported, testable function (`orderPruneCandidates`).
 *  - The pruner stays PURE: it computes refs/facts/fields; auditing happens
 *    in the caller (index.ts).
 */

import type {
  AnyMessage,
  ContextAnalysis,
  ContextItem,
  PruneAction,
  PruneOptions,
  PruneResult,
  RecoveryRef,
} from "../types.ts";
import { ENGINE_ID } from "../types.ts";
import { estimateTextTokens, messageText } from "../observer/token-estimator.ts";
import { foldBashOutput } from "./bash.ts";
import { extractStubFacts, renderStub } from "./stub-summary.ts";
import type { StubFacts } from "../types.ts";
import { buildRecoveryRef, recoveryShortId } from "../recall/recovery.ts";
import type { ContextEngineConfig } from "../config.ts";

export type { PruneOptions };

export const AUTO_PRUNE_OPTS: PruneOptions = {
  stubMinTokens: 50,
  foldMaxChars: 2200,
  mode: "auto",
};

export const MANUAL_PRUNE_OPTS: PruneOptions = {
  stubMinTokens: 20,
  foldMaxChars: 1200,
  mode: "manual",
};

export function getPruneOptsForPressure(
  pressure: number,
  config: ContextEngineConfig,
  mode: "auto" | "manual" = "auto",
): PruneOptions {
  if (mode === "manual") {
    const sorted = [...config.prune.bands].sort((a, b) => b.pressureGte - a.pressureGte);
    const aggressive = sorted[0];
    return {
      stubMinTokens: aggressive ? aggressive.stubMinTokens : 20,
      foldMaxChars: aggressive ? aggressive.foldMaxChars : 1200,
      mode: "manual",
    };
  }

  const sortedBands = [...config.prune.bands].sort((a, b) => b.pressureGte - a.pressureGte);
  for (const band of sortedBands) {
    if (pressure >= band.pressureGte) {
      return {
        stubMinTokens: band.stubMinTokens,
        foldMaxChars: band.foldMaxChars,
        mode: "auto",
      };
    }
  }

  return {
    stubMinTokens: config.limits.stubMinTokens,
    foldMaxChars: config.limits.foldMaxChars,
    mode: "auto",
  };
}

// ---------------------------------------------------------------------------
// Planning (unchanged from v0.2 — precision over recall)
// ---------------------------------------------------------------------------

type Plan = "keep" | "stub" | "fold";

/**
 * Decide the action for one classified item.
 * Precision > recall: when unsure, keep.
 */
export function planForItem(item: ContextItem, opts: PruneOptions): Plan {
  if (item.engineStub) return "keep"; // idempotency (§34)
  if (item.pinned) return "keep"; // pins survive (§15, §46)
  if (item.class === "critical") return "keep";
  if (item.type !== "tool-result" && item.type !== "bash") return "keep";
  if (item.estimatedTokens < opts.stubMinTokens) return "keep";

  const tagSet = new Set(item.tags);

  if (item.class === "disposable" || item.class === "stale") {
    return "stub";
  }

  if (item.class === "working") {
    const oversized = tagSet.has("oversized");
    if (!oversized) return "keep";
    if (tagSet.has("active-failure")) return "fold"; // keep failure summary
    if (item.source === "bash" || item.source === "read" || item.source === "grep" || item.source === "find")
      return "fold";
    return "keep";
  }

  return "keep";
}

// ---------------------------------------------------------------------------
// Replacement text (fold unchanged; stub enhanced, §7)
// ---------------------------------------------------------------------------

function stubText(tool: string, originalTokens: number, reason: string): string {
  const k = originalTokens >= 1000 ? `${(originalTokens / 1000).toFixed(1)}K` : `${originalTokens}`;
  return (
    `[${ENGINE_ID}] ${tool} result pruned (~${k} tokens) — ${reason}. ` +
    `The original output is preserved in session history; re-run the command ` +
    `or re-read the file if you need it again.`
  );
}

/** Enhanced stub per §7 (falls back to the generic stub when facts are empty). */
function enhancedStub(
  tool: string,
  facts: StubFacts,
  originalTokens: number,
  originalChars: number,
  reason: string,
  recoveryId: string | undefined,
  stubCfg: StubConfig,
): { text: string; fields: string[] } {
  const rendered = renderStub({
    tool,
    facts,
    originalTokens,
    originalChars,
    reason,
    recoveryId,
    maxChars: stubCfg.maxChars,
    includeRecoveryRef: stubCfg.includeRecoveryRef,
  });
  // §7.3: empty facts → generic stub (no empty fields)
  if (rendered.empty) {
    return { text: stubText(tool, originalTokens, reason), fields: [] };
  }
  return { text: rendered.text, fields: rendered.factFields };
}

function foldText(msg: AnyMessage, tool: string, command: string, opts: PruneOptions): string {
  const text = messageText(msg);
  if (tool === "bash") {
    return foldBashOutput(command, text, false, { maxChars: opts.foldMaxChars });
  }
  // Generic fold for reads/searches: head + tail.
  const lines = text.split("\n");
  const keepHead = 40;
  const keepTail = 20;
  if (lines.length <= keepHead + keepTail + 3) return text;
  const folded =
    lines.slice(0, keepHead).join("\n") +
    `\n\n[${ENGINE_ID} … ${lines.length - keepHead - keepTail} lines folded …]\n\n` +
    lines.slice(-keepTail).join("\n");
  const cap = opts.foldMaxChars * 2;
  return folded.length > cap ? folded.slice(0, cap) : folded;
}

function engineDetails(
  kind: "stub" | "fold",
  tool: string,
  item: ContextItem,
  recovery: RecoveryRef | null,
  replacementTokens: number,
): Record<string, unknown> {
  const d: Record<string, unknown> = {
    engine: ENGINE_ID,
    kind,
    // L1 = fold, L3 = stub (§13); consumers treat missing level as 1.
    level: kind === "fold" ? 1 : 3,
    tool,
    reason: item.reason ?? "",
    originalTokens: item.estimatedTokens,
    replacementTokens,
    at: new Date().toISOString(),
  };
  if (recovery) d.recovery = recovery; // §6.3: stub/fold carries its ref
  return d;
}

// ---------------------------------------------------------------------------
// Prefix-cache-aware candidate ordering (spec §12)
// ---------------------------------------------------------------------------

export interface StubConfig {
  enhanced: boolean;
  maxChars: number;
  maxErrorChars: number;
  includeRecoveryRef: boolean;
}

/** Disposable-class weight for the §12.2 "reclaimable + disposability" term. */
export const DISPOSABILITY_WEIGHT: Record<string, number> = {
  critical: 4, // never a candidate
  disposable: 3,
  stale: 2,
  working: 1,
  unknown: 0,
};

/** §12.3 minimum-reclaim guard thresholds. */
export const MIN_RECLAIM_GUARD = 2000; // tokens
export const RECLAIM_GUARD_RATIO = 2; // ×

export interface PruneCandidate {
  /** 0-based position in the message array (branch order). */
  index: number;
  originalTokens: number;
  replacementTokens: number;
  class: "critical" | "working" | "stale" | "disposable" | "unknown";
  /** 1 = has toolCallId/branchEntryId, 0.5 = timestamp only, 0 = hash only / none. */
  recoveryConfidence: number;
  /** true when the caller already knows the ref could not be built. */
  recoveryUnavailable?: boolean;
}

export interface OrderCandidatesOptions {
  /** Stop after reaching this total reclaimable (0/undefined = apply all). */
  targetReclaimable?: number;
  /** Test seams for the §12.3 thresholds. */
  minReclaimGuard?: number;
  reclaimGuardRatio?: number;
}

function candidateReclaimable(c: PruneCandidate): number {
  return Math.max(0, c.originalTokens - c.replacementTokens);
}

function candidateValue(c: PruneCandidate): number {
  return candidateReclaimable(c) + (DISPOSABILITY_WEIGHT[c.class] ?? 0);
}

/**
 * Order prune candidates for application (spec §12.2, §12.3). Pure and
 * deterministic.
 *
 * Lexicographic with bounded weights:
 *  1. safety (all candidates already passed the gates — equal here)
 *  2. minimum-reclaim guard (§12.3): an EARLIER candidate that reclaims at
 *     least `minReclaimGuard` (2000) tokens MORE — or at least
 *     `reclaimGuardRatio` (2×) more — than a later one wins, even though the
 *     prefix cache prefers the later one.
 *  3. when the (reclaimable + disposability) values are close (below the
 *     guard), recoveryConfidence (desc), then cache locality: the LATER
 *     branch position wins.
 *  4. otherwise the higher (reclaimable + disposability) wins.
 *  5. stable tie-break: earlier index.
 *
 * The message index is NEVER a large-weight factor — it only breaks exact
 * ties and (within the guard band) decides cache locality.
 */
export function orderPruneCandidates(
  candidates: readonly PruneCandidate[],
  opts: OrderCandidatesOptions = {},
): PruneCandidate[] {
  const guard = opts.minReclaimGuard ?? MIN_RECLAIM_GUARD;
  const ratio = opts.reclaimGuardRatio ?? RECLAIM_GUARD_RATIO;

  const earlierWins = (a: PruneCandidate, b: PruneCandidate): boolean => {
    const diff = candidateReclaimable(a) - candidateReclaimable(b);
    return diff >= guard || diff >= ratio * candidateReclaimable(b);
  };

  const ordered = [...candidates].sort((a, b) => {
    // 2. §12.3 guard (only meaningful when the better candidate is EARLIER)
    if (a.index < b.index && earlierWins(a, b)) return -1;
    if (b.index < a.index && earlierWins(b, a)) return 1;

    const va = candidateValue(a);
    const vb = candidateValue(b);

    // 4. clearly different values → the better value wins
    if (Math.abs(va - vb) >= guard) return vb - va;

    // 3. close values (within the guard band):
    //    recoveryConfidence desc, then later position (cache locality)
    if (a.recoveryConfidence !== b.recoveryConfidence) {
      return b.recoveryConfidence - a.recoveryConfidence;
    }
    if (a.index !== b.index) return b.index - a.index;
    return 0;
  });

  // optional early stop at a reclaim target
  const target = opts.targetReclaimable ?? 0;
  if (target > 0) {
    let acc = 0;
    const out: PruneCandidate[] = [];
    for (const c of ordered) {
      out.push(c);
      acc += candidateReclaimable(c);
      if (acc >= target) break;
    }
    return out;
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface PruneInputs {
  messages: readonly AnyMessage[];
  analysis: ContextAnalysis;
  /** toolCallId → { name, args } for command lookup (§35 id correlation). */
  toolCalls: Map<string, { name: string; args: Record<string, unknown> }>;
  opts?: PruneOptions;
  /** Session id for RecoveryRef (absent → §6.4 failure path, refs omitted). */
  sessionId?: string;
  /** v0.3 stub config (defaults: enhanced on, 360 chars). */
  stub?: StubConfig;
  /** v0.3: enable prefix-cache-aware candidate ordering (§12). */
  cacheAware?: boolean;
  /**
   * v0.3 (§12.1): stop applying once this many tokens have been reclaimed.
   * 0/undefined = apply every planned candidate. Combined with cache-aware
   * ordering this selects the minimal prefix of ordered candidates (§12.3).
   */
  targetReclaimable?: number;
}

interface Candidate {
  index: number;
  item: ContextItem;
  plan: Exclude<Plan, "keep">;
  tool: string;
  command: string;
  text: string;
  replacementTokens: number;
  recovery: RecoveryRef | null;
  recoveryUnavailable?: string;
  stubFields: string[];
}

const DEFAULT_STUB_CFG: StubConfig = {
  enhanced: true,
  maxChars: 360,
  maxErrorChars: 180,
  includeRecoveryRef: true,
};

/**
 * Apply a classification pass to the message list.
 * Returns a new array; the input array and its messages are not mutated.
 */
export function pruneContext({
  messages,
  analysis,
  toolCalls,
  opts = AUTO_PRUNE_OPTS,
  sessionId,
  stub = DEFAULT_STUB_CFG,
  cacheAware = false,
  targetReclaimable = 0,
}: PruneInputs): PruneResult {
  const out: AnyMessage[] = messages.slice();
  const actions: PruneAction[] = [];
  let removedTokens = 0;
  let preservedTokens = 0;

  const n = messages.length;
  const commandFor = (i: number): string => {
    const msg = messages[i];
    if (msg.role === "bashExecution") return String(msg.command ?? "");
    const id = msg.toolCallId;
    const call = id ? toolCalls.get(id) : undefined;
    if (call?.name === "bash") return String(call.args.command ?? "");
    return "";
  };

  // Pass 1: collect candidates (pure decisions; no mutation yet).
  const candidates: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const item = analysis.items[i];
    if (!item) continue;
    const plan = planForItem(item, opts);
    if (plan === "keep") continue;

    const msg = messages[i];
    // bashExecution messages carry no toolName — the classifier's `source`
    // would fall through to the literal "tool" in stub text and audit records.
    const tool =
      msg.role === "bashExecution" ? "bash" : item.source ?? msg.toolName ?? "tool";
    const command = commandFor(i);
    const originalText =
      msg.role === "bashExecution" ? String(msg.output ?? "") : messageText(msg);

    let text: string;
    let stubFields: string[] = [];
    if (plan === "fold") {
      text =
        msg.role === "bashExecution"
          ? foldBashOutput(command, originalText, false, { maxChars: opts.foldMaxChars })
          : foldText(msg, tool, command, opts);
    } else {
      if (stub.enhanced) {
        const facts = extractStubFacts({
          tool,
          msg,
          call:
            msg.role === "toolResult" && msg.toolCallId
              ? (() => {
                  const c = toolCalls.get(msg.toolCallId);
                  return c ? { toolCallId: msg.toolCallId!, name: c.name, args: c.args } : undefined;
                })()
              : undefined,
          text: originalText,
          maxErrorChars: stub.maxErrorChars,
        });
        // Recovery ref FIRST (for the recover= id in the stub text, §7.3)
        const ref =
          sessionId && originalText
            ? buildRecoveryRef({
                sessionId,
                toolCallId:
                  msg.role === "toolResult" && msg.toolCallId ? msg.toolCallId : undefined,
                messageTimestamp:
                  typeof msg.timestamp === "number" ? msg.timestamp : undefined,
                content: originalText,
              })
            : null;
        const rendered = renderStub({
          tool,
          facts,
          originalTokens: item.estimatedTokens,
          originalChars: originalText.length,
          reason: item.reason ?? "low-value output",
          recoveryId: ref ? recoveryShortId(ref) : undefined,
          maxChars: stub.maxChars,
          includeRecoveryRef: stub.includeRecoveryRef,
        });
        text = rendered.empty
          ? stubText(tool, item.estimatedTokens, item.reason ?? "low-value output")
          : rendered.text;
        stubFields = rendered.factFields;
        // Never enlarge: if the replacement costs more than the original, keep
        // the original (token savings never beat correctness).
        const replacementTokens = estimateTextTokens(text) + 24;
        if (replacementTokens >= item.estimatedTokens) continue;
        candidates.push({
          index: i,
          item,
          plan,
          tool,
          command,
          text,
          replacementTokens,
          recovery: ref,
          recoveryUnavailable: ref ? undefined : sessionId ? "empty-content" : "no-session-id",
          stubFields,
        });
        continue;
      }
      text = stubText(tool, item.estimatedTokens, item.reason ?? "low-value output");
    }

    // Recovery ref for folds and legacy stubs
    const ref =
      sessionId && originalText
        ? buildRecoveryRef({
            sessionId,
            toolCallId:
              msg.role === "toolResult" && msg.toolCallId ? msg.toolCallId : undefined,
            messageTimestamp: typeof msg.timestamp === "number" ? msg.timestamp : undefined,
            content: originalText,
          })
        : null;

    // Never enlarge: if the replacement costs more than the original, keep
    // the original (token savings never beat correctness).
    const replacementTokens = estimateTextTokens(text) + 24;
    if (replacementTokens >= item.estimatedTokens) continue;

    candidates.push({
      index: i,
      item,
      plan,
      tool,
      command,
      text,
      replacementTokens,
      recovery: ref,
      recoveryUnavailable: ref ? undefined : sessionId ? "empty-content" : "no-session-id",
      stubFields: [],
    });
  }

  // Pass 2: order (cache-aware or positional) and apply. With a reclaim
  // target (§12.1) only the ordered prefix that meets it is applied — that is
  // what makes the §12.3 guard observable (Case R3).
  const ordered = cacheAware
    ? orderPruneCandidates(
        candidates.map((c) => ({
          index: c.index,
          originalTokens: c.item.estimatedTokens,
          replacementTokens: c.replacementTokens,
          class: c.item.class,
          recoveryConfidence: c.recovery
            ? c.recovery.toolCallId || c.recovery.branchEntryId
              ? 1
              : c.recovery.messageTimestamp !== undefined
                ? 0.5
                : 0
            : 0,
          recoveryUnavailable: c.recovery === null,
        })),
        { targetReclaimable: targetReclaimable },
      )
    : candidates.map((c) => ({
        index: c.index,
        originalTokens: c.item.estimatedTokens,
        replacementTokens: c.replacementTokens,
        class: c.item.class,
        recoveryConfidence: 0,
      }));

  const byIndex = new Map(candidates.map((c) => [c.index, c] as const));

  let accReclaimed = 0;
  ordered.forEach((oc, rank) => {
    if (!cacheAware && targetReclaimable > 0 && accReclaimed >= targetReclaimable) return;
    const c = byIndex.get(oc.index);
    if (!c) return;
    const msg = messages[c.index];
    const { item, plan, tool, text, replacementTokens } = c;

    const details = engineDetails(plan, tool, item, c.recovery, replacementTokens);
    let replaced: AnyMessage | null = null;
    if (msg.role === "toolResult") {
      replaced = {
        ...msg,
        role: "toolResult",
        toolCallId: msg.toolCallId,
        toolName: msg.toolName ?? tool,
        isError: msg.isError === true,
        content: [{ type: "text", text }],
        details,
        timestamp: msg.timestamp,
      };
    } else if (msg.role === "bashExecution") {
      replaced = {
        ...msg,
        role: "bashExecution",
        command: msg.command,
        output: text,
        exitCode: msg.exitCode,
        cancelled: msg.cancelled,
        truncated: false,
        fullOutputPath: msg.fullOutputPath,
        excludeFromContext: msg.excludeFromContext === true ? true : undefined,
        details,
        timestamp: msg.timestamp,
      };
    }
    if (!replaced) return;

    out[c.index] = replaced;
    const originalTokens = item.estimatedTokens;
    removedTokens += Math.max(0, originalTokens - replacementTokens);
    preservedTokens += replacementTokens;
    accReclaimed += Math.max(0, originalTokens - replacementTokens);
    actions.push({
      kind: plan,
      messageIndex: c.index,
      messageId: item.id,
      tool,
      originalTokens,
      replacementTokens,
      reason: item.reason ?? plan,
      tags: item.tags,
      preview: text.slice(0, 160),
      // v0.3 fields (§6.3, §12.4, §13)
      level: plan === "fold" ? 1 : 3,
      recovery: c.recovery ?? undefined,
      recoveryUnavailable: c.recoveryUnavailable,
      stubFacts: c.stubFields.length > 0 ? c.stubFields : undefined,
      toolCallId: msg.toolCallId,
      reclaimableTokens: Math.max(0, originalTokens - replacementTokens),
      cacheLocality: n > 1 ? c.index / (n - 1) : 1,
      selectedRank: rank + 1,
    });
  });

  return { context: out, removedTokens, preservedTokens, actions };
}
