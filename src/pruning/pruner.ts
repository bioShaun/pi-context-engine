/**
 * Context pruner (spec §10, §33, §34).
 *
 * Safety rules:
 *  - Only `toolResult` / `bashExecution` messages are ever touched.
 *    User, assistant, summary, and pinned messages are NEVER modified.
 *  - Tool results are *replaced in place* (same role/toolCallId/toolName)
 *    so provider tool-call pairing always holds. Nothing is dropped.
 *  - Idempotent: replacements carry `details.engine === ENGINE_ID` and are
 *    skipped on subsequent passes (§34).
 *  - Read-only input: builds a new array; the source is not mutated (§33).
 */

import type {
  AnyMessage,
  ContextAnalysis,
  ContextItem,
  PruneAction,
  PruneResult,
} from "../types.ts";
import { ENGINE_ID } from "../types.ts";
import { estimateTextTokens, messageText } from "../observer/token-estimator.ts";
import { foldBashOutput } from "./bash.ts";

export interface PruneOptions {
  stubMinTokens: number;
  foldMaxChars: number;
  /** "auto" = policy-driven; "manual" = /context clean (more aggressive). */
  mode: "auto" | "manual";
}

export const AUTO_PRUNE_OPTS: PruneOptions = {
  stubMinTokens: 50,
  foldMaxChars: 2200,
  mode: "auto",
};

export const MANUAL_PRUNE_OPTS: PruneOptions = {
  stubMinTokens: 30,
  foldMaxChars: 1600,
  mode: "manual",
};

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

function stubText(tool: string, originalTokens: number, reason: string): string {
  const k = originalTokens >= 1000 ? `${(originalTokens / 1000).toFixed(1)}K` : `${originalTokens}`;
  return (
    `[${ENGINE_ID}] ${tool} result pruned (~${k} tokens) — ${reason}. ` +
    `The original output is preserved in session history; re-run the command ` +
    `or re-read the file if you need it again.`
  );
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
): Record<string, unknown> {
  return {
    engine: ENGINE_ID,
    kind,
    tool,
    reason: item.reason ?? "",
    originalTokens: item.estimatedTokens,
    at: new Date().toISOString(),
  };
}

export interface PruneInputs {
  messages: readonly AnyMessage[];
  analysis: ContextAnalysis;
  /** toolCallId → { name, args } for command lookup (§35 id correlation). */
  toolCalls: Map<string, { name: string; args: Record<string, unknown> }>;
  opts?: PruneOptions;
}

/**
 * Apply a classification pass to the message list.
 * Returns a new array; the input array and its messages are not mutated.
 */
export function pruneContext({
  messages,
  analysis,
  toolCalls,
  opts = AUTO_PRUNE_OPTS,
}: PruneInputs): PruneResult {
  const out: AnyMessage[] = messages.slice();
  const actions: PruneAction[] = [];
  let removedTokens = 0;
  let preservedTokens = 0;

  const commandFor = (i: number): string => {
    const msg = messages[i];
    if (msg.role === "bashExecution") return String(msg.command ?? "");
    const id = msg.toolCallId;
    const call = id ? toolCalls.get(id) : undefined;
    if (call?.name === "bash") return String(call.args.command ?? "");
    return "";
  };

  for (let i = 0; i < messages.length; i++) {
    const item = analysis.items[i];
    if (!item) continue;
    const plan = planForItem(item, opts);
    if (plan === "keep") continue;

    const msg = messages[i];
    const tool = item.source ?? msg.toolName ?? "tool";
    const command = commandFor(i);
    const text =
      plan === "fold"
        ? msg.role === "bashExecution"
          ? foldBashOutput(command, String(msg.output ?? ""), false, { maxChars: opts.foldMaxChars })
          : foldText(msg, tool, command, opts)
        : stubText(tool, item.estimatedTokens, item.reason ?? "low-value output");

    // Never enlarge: if the replacement costs more than the original, keep
    // the original (spec §51: token savings must not beat correctness).
    if (estimateTextTokens(text) + 24 >= item.estimatedTokens) continue;

    const details = engineDetails(plan, tool, item);
    if (msg.role === "toolResult") {
      out[i] = {
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
      out[i] = {
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
    } else {
      continue;
    }

    const replacementTokens = estimateTextTokens(text) + 24;
    removedTokens += Math.max(0, item.estimatedTokens - replacementTokens);
    preservedTokens += replacementTokens;
    actions.push({
      kind: plan,
      messageIndex: i,
      messageId: item.id,
      tool,
      originalTokens: item.estimatedTokens,
      replacementTokens,
      reason: item.reason ?? plan,
      tags: item.tags,
      preview: text.slice(0, 160),
    });
  }

  return { context: out, removedTokens, preservedTokens, actions };
}
