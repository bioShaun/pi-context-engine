/**
 * Message-level detection rules (spec §11, §12).
 */

import type { AnyMessage, ResolvedToolCall } from "../types.ts";
import { categorizeCommand } from "../pruning/bash.ts";

export interface RuleOptions {
  /** Tool results above this many estimated tokens are "oversized". */
  oversizedTokens: number;
  /** Messages within the last N toolish results count as "recent". */
  recentWindow: number;
}

export const DEFAULT_RULES: Required<RuleOptions> = {
  oversizedTokens: 1000,
  recentWindow: 8,
};

export function isOversized(tokens: number, opts: RuleOptions): boolean {
  return tokens >= (opts.oversizedTokens ?? DEFAULT_RULES.oversizedTokens);
}

/**
 * Detect test-run outcome from output text.
 * "fail" wins over "pass" when both appear (e.g. "3 failed, 214 passed").
 */
export function detectTestOutcome(text: string): "pass" | "fail" | "unknown" {
  if (!text) return "unknown";
  const failRe = /(\d+\s+(?:failed|failing|errors?)\b)|\bFAILED\b|\bTraceback\b|\bpanic(:| at)|AssertionError|Test\b.*\bfailed\b/i;
  const passRe = /(\d+\s+passed\b)|\bOK\b.*\(\d+\s+tests?\)|all tests? (?:passed|ok)/i;
  const hasFail = failRe.test(text);
  const hasPass = passRe.test(text);
  if (hasFail) return "fail";
  if (hasPass) return "pass";
  return "unknown";
}

export function commandOf(call: ResolvedToolCall | undefined): string {
  return call ? String(call.args.command ?? "") : "";
}

export function categoryOf(call: ResolvedToolCall | undefined): ReturnType<typeof categorizeCommand> {
  return categorizeCommand(commandOf(call));
}

/**
 * Resolve the tool call for a toolResult message via toolCallId (§35).
 */
export function resolveCall(
  msg: AnyMessage,
  toolCalls: Map<string, ResolvedToolCall>,
): ResolvedToolCall | undefined {
  if (msg.role !== "toolResult") return undefined;
  const id = msg.toolCallId;
  return typeof id === "string" && id ? toolCalls.get(id) : undefined;
}

/** Indices of "toolish" messages (tool results + bash executions). */
export function toolishIndexes(messages: readonly AnyMessage[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "toolResult" || role === "bashExecution") idx.push(i);
  }
  return idx;
}
