/**
 * Stable recovery references (pi-native-recall spec §6).
 *
 * A fold/stub in the effective context carries a RecoveryRef pointing back to
 * the L0 original in the Pi session branch. The ref contains ONLY a session
 * id, an optional stable entry id / toolCallId / timestamp, and a content
 * hash — never paths, commands, or user content (§16).
 *
 * Resolution priority (§6.2):
 *   1. branchEntryId
 *   2. toolCallId + contentHash
 *   3. messageTimestamp + contentHash
 *   4. contentHash alone — only when it hits exactly one document
 */

import type { RecoveryRef, SearchDocument } from "../types.ts";
import { contentFingerprint } from "../observer/token-estimator.ts";

export interface BuildRecoveryRefInput {
  sessionId: string;
  toolCallId?: string;
  messageTimestamp?: number;
  /** The full original text (L0). */
  content: string;
  /** Present only when the builder already has the branch entry id. */
  branchEntryId?: string;
}

/**
 * Build a RecoveryRef from an L0 original message. Returns null when a stable
 * ref cannot be built (empty/missing content) — the caller then follows the
 * §6.4 failure path.
 */
export function buildRecoveryRef(input: BuildRecoveryRefInput): RecoveryRef | null {
  if (!input || typeof input.sessionId !== "string" || !input.sessionId) return null;
  if (typeof input.content !== "string" || input.content.length === 0) return null;
  return {
    version: 1,
    sessionId: input.sessionId,
    branchEntryId: input.branchEntryId,
    toolCallId:
      typeof input.toolCallId === "string" && input.toolCallId ? input.toolCallId : undefined,
    messageTimestamp:
      typeof input.messageTimestamp === "number" && Number.isFinite(input.messageTimestamp)
        ? input.messageTimestamp
        : undefined,
    contentHash: contentFingerprint(input.content),
  };
}

/**
 * Short, stable recovery id for stub text: `r:` + 6 hex chars of the content
 * hash. Contains no path/command/user content (§16).
 */
export function recoveryShortId(ref: RecoveryRef): string {
  const m = (ref?.contentHash ?? "").match(/:([0-9a-f]{3,})$/);
  const hex = m ? m[1] : "000000";
  return `r:${hex.slice(0, 6)}`;
}

export type RecoveryResolution =
  | { status: "ok"; doc: SearchDocument }
  | { status: "ambiguous"; candidates: number }
  | { status: "not-found" }
  | { status: "session-mismatch"; expected: string; actual: string };

/**
 * Resolve a RecoveryRef against a list of branch SearchDocuments (§6.2).
 * Pure function; deterministic.
 */
export function resolveRecoveryRef(
  ref: RecoveryRef,
  docs: readonly SearchDocument[],
  currentSessionId?: string,
): RecoveryResolution {
  if (!ref || typeof ref.contentHash !== "string") return { status: "not-found" };
  if (currentSessionId && ref.sessionId && ref.sessionId !== currentSessionId) {
    return {
      status: "session-mismatch",
      expected: ref.sessionId,
      actual: currentSessionId,
    };
  }

  // 1. branchEntryId
  if (ref.branchEntryId) {
    const hits = docs.filter((d) => d.entryId === ref.branchEntryId);
    if (hits.length === 1) return { status: "ok", doc: hits[0] };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
  }

  // 2. toolCallId + contentHash
  if (ref.toolCallId) {
    const hits = docs.filter(
      (d) => d.toolCallId === ref.toolCallId && d.recovery?.contentHash === ref.contentHash,
    );
    if (hits.length === 1) return { status: "ok", doc: hits[0] };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
  }

  // 3. messageTimestamp + contentHash
  if (ref.messageTimestamp !== undefined) {
    const hits = docs.filter(
      (d) => d.timestamp === ref.messageTimestamp && d.recovery?.contentHash === ref.contentHash,
    );
    if (hits.length === 1) return { status: "ok", doc: hits[0] };
    if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
  }

  // 4. contentHash alone — unique hit required
  const hits = docs.filter((d) => d.recovery?.contentHash === ref.contentHash);
  if (hits.length === 1) return { status: "ok", doc: hits[0] };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.length };
  return { status: "not-found" };
}

/**
 * Read the recovery ref out of an engine stub/fold message's `details`
 * (§6.3). Backward compatible: old stubs without `recovery` return null.
 */
export function recoveryFromDetails(details: unknown): RecoveryRef | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const r = d.recovery as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  if (typeof r.contentHash !== "string" || typeof r.sessionId !== "string") return null;
  return {
    version: 1,
    sessionId: r.sessionId,
    branchEntryId: typeof r.branchEntryId === "string" ? r.branchEntryId : undefined,
    toolCallId: typeof r.toolCallId === "string" ? r.toolCallId : undefined,
    messageTimestamp: typeof r.messageTimestamp === "number" ? r.messageTimestamp : undefined,
    contentHash: r.contentHash,
  };
}
