/**
 * Read-tool supersession rules (spec §11: read A@v1 → edit A → read A@v2 ⇒ v1 stale).
 */

import type { ResolvedToolCall } from "../types.ts";

function normalizePath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  return p.replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

export interface ReadRange {
  start: number;
  end: number;
  isFull: boolean;
}

export function getReadRange(call: ResolvedToolCall): ReadRange {
  const args = call.args ?? {};
  const offset =
    typeof args.offset === "number"
      ? args.offset
      : typeof args.start_line === "number"
      ? args.start_line
      : typeof args.line_start === "number"
      ? args.line_start
      : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  const endLine =
    typeof args.end_line === "number"
      ? args.end_line
      : typeof args.line_end === "number"
      ? args.line_end
      : undefined;

  if (offset === undefined && limit === undefined && endLine === undefined) {
    return { start: 0, end: Infinity, isFull: true };
  }

  const start = offset ?? 1;
  let end = Infinity;
  if (limit !== undefined) {
    end = start + Math.max(0, limit - 1);
  } else if (endLine !== undefined) {
    end = endLine;
  }
  return { start, end, isFull: false };
}

export function readRangesOverlap(a: ReadRange, b: ReadRange): boolean {
  if (a.isFull || b.isFull) return true;
  return Math.max(a.start, b.start) <= Math.min(a.end, b.end);
}

/**
 * Group key for file reads.
 */
export function readGroupKey(call: ResolvedToolCall): string | undefined {
  const path = normalizePath(call.args.path ?? call.args.file_path);
  if (!path) return undefined;
  return `read:${path}`;
}

/** Human label for reports. */
export function readLabel(call: ResolvedToolCall): string {
  const path = normalizePath(call.args.path ?? call.args.file_path) ?? "?";
  return `read:${path}`;
}
