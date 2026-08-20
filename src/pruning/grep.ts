/**
 * grep / find / ls search-dedup rules (spec §11).
 *
 * Repeated near-identical searches: keep the most recent, fold older ones.
 * We key on tool + pattern + scope so a *different* query is never merged.
 */

import type { ResolvedToolCall } from "../types.ts";

function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/**
 * Group key for a search-ish tool call. Returns undefined when the call has
 * no usable identifying arguments (then it is treated as unique).
 */
export function searchGroupKey(call: ResolvedToolCall): string | undefined {
  const a = call.args;
  const tool = call.name;
  if (tool === "grep") {
    const pattern = norm(a.pattern);
    if (!pattern) return undefined;
    const scope = norm(a.path) || norm(a.glob);
    return `grep:${pattern}${scope ? `@${scope}` : ""}`;
  }
  if (tool === "find") {
    const pattern = norm(a.pattern);
    if (!pattern) return undefined;
    const scope = norm(a.path);
    return `find:${pattern}${scope ? `@${scope}` : ""}`;
  }
  if (tool === "ls") {
    const scope = norm(a.path) || ".";
    return `ls:${scope}`;
  }
  return undefined;
}

export function searchLabel(call: ResolvedToolCall): string {
  const key = searchGroupKey(call);
  return key ?? `${call.name}:${JSON.stringify(call.args).slice(0, 60)}`;
}
