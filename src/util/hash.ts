/**
 * Small shared utilities: path normalization, text normalization, ids.
 */

import { randomBytes } from "node:crypto";

/** Normalize a path for grouping: lowercase, strip ./ and trailing slashes. */
export function normalizePathLike(p: string): string {
  return (p ?? "").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

/** Collapse whitespace for text comparison. */
export function normalizeText(t: string): string {
  return (t ?? "").replace(/\s+/g, " ").trim();
}

/** Short unique id for pins/checkpoints. */
export function shortId(bytes = 6): string {
  return randomBytes(bytes).toString("hex").slice(0, bytes * 2);
}
