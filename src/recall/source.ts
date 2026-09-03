/**
 * Recall source (pi-native-recall spec §8, §11.1).
 *
 * Pure adapter from a Pi session branch (array of entries) to the list of
 * L0 SearchDocuments that `context_search` scans.
 *
 * Source boundaries (spec §8.1, §11.1):
 *  - ONLY tool output is a search document: bashExecution entries and
 *    toolResult messages. user/assistant/custom/branchSummary entries are
 *    never documents.
 *  - The engine's own `context_search` tool results are excluded (no
 *    feedback loop).
 *  - Any message carrying the engine marker (stub/fold text persisted into
 *    the session) is excluded — documents must be L0 originals.
 *  - Pre-compaction entries are still L0 originals and remain searchable;
 *    they are flagged `preCompaction` and coverage is reported (§11.1).
 *
 * Prune metadata: prune-log records are matched back onto documents via
 * their RecoveryRef (resolution priority §6.2). A record that cannot be
 * resolved to exactly one document degrades the metadata (never produces a
 * wrong association, §11.1).
 */

import type { RecoveryRef, SearchDocument } from "../types.ts";
import { ENGINE_ID } from "../types.ts";
import { messageText, estimateTextTokens } from "../observer/token-estimator.ts";
import { buildRecoveryRef, resolveRecoveryRef } from "./recovery.ts";

// ---------------------------------------------------------------------------
// Structural view of a Pi session entry (no runtime pi import).
// ---------------------------------------------------------------------------

export interface BranchEntryLike {
  type: string;
  id?: string;
  timestamp?: string;
  /** message entries */
  message?: {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    command?: string;
    output?: string;
    exitCode?: number | null;
    cancelled?: boolean;
    isError?: boolean;
    details?: unknown;
    [key: string]: unknown;
  };
}

/**
 * One prune-log.jsonl record as consumed here. `recovery` is present on
 * v0.3 records; v0.2 and older records only have `item_id` (content
 * fingerprint of the message text) which CANNOT be matched against branch
 * positions reliably → they degrade the metadata instead.
 */
export interface PruneLogRecord {
  time?: string;
  action?: string; // "fold" | "stub"
  item_id?: string;
  tool?: string;
  reason?: string;
  recovery?: {
    sessionId?: string;
    branchEntryId?: string;
    toolCallId?: string;
    messageTimestamp?: number;
    contentHash?: string;
  };
}

export interface SourceResult {
  docs: SearchDocument[];
  /** true when some prune record could not be resolved (or lacks recovery). */
  pruneMetadataUnavailable: boolean;
  /** true when a compaction exists but the branch exposes no pre-compaction docs. */
  partialCoverage: boolean;
  compactionSeen: boolean;
  preCompactionDocs: number;
}

// ---------------------------------------------------------------------------

function entryTimestamp(entry: BranchEntryLike): number {
  // Prefer the MESSAGE timestamp: RecoveryRefs built by the pruner carry
  // msg.timestamp (creation time), and priority-3 resolution
  // (messageTimestamp + contentHash, §6.2) compares for exact equality.
  // The entry-level timestamp is the append time — a different clock read —
  // and would silently break that resolution path.
  const m = entry.message;
  if (m && typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) return m.timestamp;
  if (typeof entry.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function isEngineStub(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  return (details as Record<string, unknown>).engine === ENGINE_ID;
}

function makeDoc(
  sessionId: string,
  opts: {
    tool: string;
    content: string;
    entryId?: string;
    toolCallId?: string;
    command?: string;
    argsText?: string;
    timestamp: number;
  },
): SearchDocument | null {
  if (!opts.content) return null; // empty output is not searchable
  const ref = buildRecoveryRef({
    sessionId,
    toolCallId: opts.toolCallId,
    messageTimestamp: opts.timestamp,
    branchEntryId: opts.entryId,
    content: opts.content,
  });
  if (!ref) return null;
  return {
    recovery: ref,
    entryId: opts.entryId,
    toolCallId: opts.toolCallId,
    tool: opts.tool,
    command: opts.command,
    argsText: opts.argsText,
    content: opts.content,
    timestamp: opts.timestamp,
    estimatedTokens: 0, // filled in by the caller (token estimator is shared)
  };
}

/**
 * Build the L0 search documents for the current branch.
 *
 * @param entries  full branch path (sessionManager.getBranch() shape). When
 *                 the caller could not obtain the full path (e.g. only
 *                 buildContextEntries() was available), pass that instead —
 *                 coverage is then conservative (pre-compaction entries are
 *                 absent, so coverage degrades to "partial").
 * @param pruneLog prune-log.jsonl records (oldest → newest).
 */
export function buildSearchDocuments(
  entries: readonly BranchEntryLike[],
  sessionId: string,
  pruneLog: readonly PruneLogRecord[],
): SourceResult {
  const docs: SearchDocument[] = [];

  // Pass 1: assistant tool-call args (by explicit toolCallId — §35).
  const toolCallArgs = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "toolCall") continue;
      const id = typeof b.id === "string" ? b.id : undefined;
      if (!id) continue;
      toolCallArgs.set(id, {
        name: typeof b.name === "string" ? b.name : "unknown",
        args: (b.arguments as Record<string, unknown> | undefined) ?? {},
      });
    }
  }

  // Pass 2: documents. Locate the compaction boundary FIRST — a forward-only
  // scan would process pre-compaction entries before ever seeing the
  // compaction entry, so they could never be flagged (§8.3).
  let lastCompactionIndex = -1;
  entries.forEach((entry, i) => {
    if (entry.type === "compaction") lastCompactionIndex = i;
  });
  const compactionSeen = lastCompactionIndex >= 0;

  entries.forEach((entry, i) => {
    if (entry.type === "compaction") return;
    if (entry.type !== "message") return; // custom/branchSummary/session: never L0 docs
    const msg = entry.message;
    if (!msg) return;
    if (isEngineStub(msg.details)) return; // defensive: no stubs as L0

    const preCompaction = compactionSeen && i < lastCompactionIndex;
    const ts = entryTimestamp(entry);

    if (msg.role === "bashExecution") {
      const output = typeof msg.output === "string" ? msg.output : "";
      const doc = makeDoc(sessionId, {
        tool: "bash",
        content: output,
        entryId: entry.id,
        command: typeof msg.command === "string" ? msg.command : undefined,
        timestamp: ts,
      });
      if (doc) {
        doc.preCompaction = preCompaction || undefined;
        docs.push(doc);
      }
      return;
    }

    if (msg.role === "toolResult") {
      const tool = typeof msg.toolName === "string" ? msg.toolName : "unknown";
      if (tool === "context_search") return; // engine's own results (§11.1)
      const text = messageText(msg);
      if (!text) return;
      const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
      const call = toolCallId ? toolCallArgs.get(toolCallId) : undefined;
      const argsText = call ? safeJson(call.args) : undefined;
      const command =
        tool === "bash" && call && typeof call.args.command === "string"
          ? (call.args.command as string)
          : undefined;
      const doc = makeDoc(sessionId, {
        tool: call?.name ?? tool,
        content: text,
        entryId: entry.id,
        toolCallId,
        command,
        argsText,
        timestamp: ts,
      });
      if (doc) {
        doc.preCompaction = preCompaction || undefined;
        docs.push(doc);
      }
      return;
    }
    // user / assistant / other: not search documents (§8.1)
  });

  // Coverage (spec §11.1): with a compaction, pre-compaction L0 must still be
  // reachable for "complete" coverage. If the branch exposes none, we cannot
  // verify reachability → partial (conservative).
  const preCompactionDocs = docs.filter((d) => d.preCompaction).length;
  const partialCoverage = compactionSeen && preCompactionDocs === 0;

  // Prune metadata (spec §11.1, §6.2): resolve each record's RecoveryRef.
  let pruneMetadataUnavailable = false;
  for (const rec of pruneLog) {
    if (rec.action !== "stub" && rec.action !== "fold") continue;
    const r = rec.recovery;
    if (!r || typeof r.contentHash !== "string" || !r.sessionId) {
      // v0.2/older record: item_id hash only — must not be guessed.
      pruneMetadataUnavailable = true;
      continue;
    }
    const ref: RecoveryRef = {
      version: 1,
      sessionId: r.sessionId,
      branchEntryId: typeof r.branchEntryId === "string" ? r.branchEntryId : undefined,
      toolCallId: typeof r.toolCallId === "string" ? r.toolCallId : undefined,
      messageTimestamp: typeof r.messageTimestamp === "number" ? r.messageTimestamp : undefined,
      contentHash: r.contentHash,
    };
    const res = resolveRecoveryRef(ref, docs, sessionId);
    if (res.status === "ok") {
      res.doc.prune = {
        kind: rec.action === "fold" ? "fold" : "stub",
        reason: typeof rec.reason === "string" ? rec.reason : "",
        at: typeof rec.time === "string" ? rec.time : "",
      };
    } else {
      // not-found / ambiguous / session-mismatch → degrade, never mis-associate
      pruneMetadataUnavailable = true;
    }
  }

  // fill estimated tokens
  for (const d of docs) d.estimatedTokens = estimateTextTokens(d.content);

  return {
    docs,
    pruneMetadataUnavailable,
    partialCoverage,
    compactionSeen,
    preCompactionDocs,
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}
