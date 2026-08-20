/**
 * Read-tool supersession rules (spec §11: read A@v1 → edit A → read A@v2 ⇒ v1 stale).
 */

import type { ResolvedToolCall } from "../types.ts";

function normalizePath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  return p.replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Group key for file reads. We key on the path only (ignoring offset/limit):
 * any newer read of the same file supersedes earlier reads of it, because a
 * full-file read re-covers the content and partial reads of the same file are
 * usually re-verification. (Precision > recall: this errs toward keeping the
 * *latest* read, never the only read.)
 */
export function readGroupKey(call: ResolvedToolCall): string | undefined {
  const path = normalizePath(call.args.path);
  if (!path) return undefined;
  return `read:${path}`;
}

/** Human label for reports. */
export function readLabel(call: ResolvedToolCall): string {
  const path = normalizePath(call.args.path) ?? "?";
  return `read:${path}`;
}
