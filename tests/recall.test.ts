/**
 * Recall tests: RecoveryRef resolution (§19.2), lexical search (§19.3), and
 * the branch→SearchDocument source adapter (§8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRecoveryRef, resolveRecoveryRef, recoveryShortId, recoveryFromDetails } from "../src/recall/recovery.ts";
import { buildSearchDocuments, type BranchEntryLike } from "../src/recall/source.ts";
import {
  parseSearchQuery,
  searchDocuments,
  makeSnippet,
  renderSearchResult,
  type ParsedQuery,
} from "../src/recall/search.ts";
import type { SearchDocument } from "../src/types.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
function doc(partial: Partial<SearchDocument> & { content: string }): SearchDocument {
  idSeq += 1;
  return {
    recovery: buildRecoveryRef({ sessionId: "s1", content: partial.content })!,
    entryId: `e${idSeq}`,
    tool: "bash",
    timestamp: 1000 + idSeq,
    estimatedTokens: 10,
    ...partial,
  };
}

function q(text: string): ParsedQuery {
  const r = parseSearchQuery(text);
  if (!r.ok) throw new Error(`bad test query "${text}": ${r.error}`);
  return r;
}

function branchMessage(entry: Partial<BranchEntryLike> & { message: Record<string, unknown> }): BranchEntryLike {
  return { type: "message", id: `b${++idSeq}`, timestamp: new Date(1700000000000 + idSeq * 1000).toISOString(), ...entry };
}

// ---------------------------------------------------------------------------
// §19.2 RecoveryRef
// ---------------------------------------------------------------------------

test("buildRecoveryRef: rejects empty content / missing session", () => {
  assert.equal(buildRecoveryRef({ sessionId: "s", content: "" }), null);
  assert.equal(buildRecoveryRef({ sessionId: "", content: "x" }), null);
  const ref = buildRecoveryRef({ sessionId: "s", toolCallId: "t1", content: "hello" });
  assert.ok(ref);
  assert.equal(ref!.version, 1);
  assert.equal(ref!.toolCallId, "t1");
  assert.ok(ref!.contentHash.length > 0);
});

test("resolveRecoveryRef: branchEntryId has priority", () => {
  const a = doc({ content: "same text" });
  const b = doc({ content: "same text" }); // same hash, different entry
  const ref = { ...b.recovery, branchEntryId: b.entryId };
  // resolution by entryId even though both hashes match
  const r = resolveRecoveryRef(ref, [a, b], "s1");
  assert.equal(r.status, "ok");
  if (r.status === "ok") assert.equal(r.doc.entryId, b.entryId);
});

test("resolveRecoveryRef: toolCallId+hash fallback; hash conflict → ambiguous", () => {
  const a = doc({ content: "duplicate", toolCallId: "t-a" });
  const b = doc({ content: "duplicate", toolCallId: "t-b" });
  const ref = { version: 1 as const, sessionId: "s1", contentHash: a.recovery.contentHash };
  const r = resolveRecoveryRef(ref, [a, b], "s1");
  assert.equal(r.status, "ambiguous");
  if (r.status === "ambiguous") assert.equal(r.candidates, 2);

  const byTool = { ...ref, toolCallId: "t-b" };
  const r2 = resolveRecoveryRef(byTool, [a, b], "s1");
  assert.equal(r2.status, "ok");
});

test("resolveRecoveryRef: session mismatch rejected", () => {
  const a = doc({ content: "x" });
  const r = resolveRecoveryRef({ ...a.recovery, sessionId: "other" }, [a], "s1");
  assert.equal(r.status, "session-mismatch");
});

test("resolveRecoveryRef: compaction-safe (index-independent) via toolCallId", () => {
  // The doc list order/positions change after compaction; the toolCallId+hash
  // ref still resolves.
  const a = doc({ content: "stable original", toolCallId: "tc-9" });
  const reordered = [doc({ content: "new first" }), a, doc({ content: "new last" })];
  const r = resolveRecoveryRef(
    { version: 1, sessionId: "s1", toolCallId: "tc-9", contentHash: a.recovery.contentHash },
    reordered,
    "s1",
  );
  assert.equal(r.status, "ok");
});

test("recoveryFromDetails: backward compatible with old stubs", () => {
  assert.equal(recoveryFromDetails({ engine: "pi-context-engine" }), null);
  assert.equal(recoveryFromDetails(undefined), null);
  const ref = recoveryFromDetails({
    engine: "pi-context-engine",
    recovery: { sessionId: "s1", contentHash: "h:abcdef12" },
  });
  assert.ok(ref);
  assert.equal(ref!.sessionId, "s1");
});

test("recoveryShortId: r: + 6 hex chars, no user content", () => {
  const ref = buildRecoveryRef({ sessionId: "s", content: "whatever" })!;
  const id = recoveryShortId(ref);
  assert.match(id, /^r:[0-9a-f]{6}$/);
});

// ---------------------------------------------------------------------------
// §19.3 Search
// ---------------------------------------------------------------------------

test("parseSearchQuery: filters, phrases, errors", () => {
  const q = parseSearchQuery('tool:bash file:src/index.ts "error TS2322" build failed');
  assert.ok(q.ok);
  if (q.ok) {
    assert.equal(q.tool, "bash");
    assert.equal(q.file, "src/index.ts");
    assert.deepEqual(q.phrases, ["error ts2322"]);
    assert.ok(q.terms.includes("build"));
    assert.ok(q.terms.includes("failed"));
  }
  assert.equal(parseSearchQuery("").ok, false);
  assert.equal(parseSearchQuery("the of and").ok, false, "stopwords only → no terms");
  const long = "x".repeat(501);
  assert.equal(parseSearchQuery(long).ok, false);
});

test("parseSearchQuery: CJK unigram + bigram", () => {
  const q = parseSearchQuery("数据库连接失败");
  assert.ok(q.ok);
  if (q.ok) {
    assert.deepEqual(q.cjk, ["数据", "据库", "库连", "连接", "接失", "失败"]);
    assert.equal(q.terms.length, 0);
  }
  const single = parseSearchQuery("错");
  if (single.ok) assert.deepEqual(single.cjk, ["错"]);
});

test("search: AND semantics, quoted phrase gating, error-code weighting", () => {
  const docs = [
    doc({ content: "compiling project\nok" }),
    doc({ content: "src/index.ts:12: error TS2322: Type 'string' is not assignable to type 'number'" }),
    doc({ content: "TS2322 mentioned but no path here" }),
  ];
  const query1 = q('"is not assignable" TS2322');
  const r = searchDocuments({ query: query1, docs });
  assert.equal(r.hits.length, 1, "phrase gate eliminates the doc without the phrase");
  assert.equal(docs[r.hits[0].docIndex].content.startsWith("src/index.ts"), true);

  const query2 = q("TS2322 missingterm");
  const r2 = searchDocuments({ query: query2, docs });
  assert.equal(r2.hits.length, 0, "AND: any missing term eliminates the doc");
});

test("search: tool filter and file filter", () => {
  const docs = [
    doc({ tool: "bash", content: "error happened" }),
    doc({ tool: "read", content: "error happened in src/app.ts" }),
  ];
  const r = searchDocuments({ query: q("tool:bash error"), docs });
  assert.equal(r.hits.length, 1);
  assert.equal(docs[r.hits[0].docIndex].tool, "bash");

  const rf = searchDocuments({ query: q("file:src/app.ts error"), docs });
  assert.equal(rf.hits.length, 1);
  assert.equal(docs[rf.hits[0].docIndex].tool, "read");
});

test("search: structured tool param is case-insensitive like the inline filter", () => {
  const docs = [
    doc({ tool: "bash", content: "error happened" }),
    doc({ tool: "read", content: "error happened too" }),
  ];
  const parsed = parseSearchQuery("error", { tool: "Bash" });
  assert.ok(parsed.ok && parsed.tool === "bash", "opts.tool normalized");
  const r = searchDocuments({ query: parsed as ParsedQuery, docs });
  assert.equal(r.hits.length, 1);
  assert.equal(docs[r.hits[0].docIndex].tool, "bash");
});

test("search: CJK bigram match", () => {
  const docs = [doc({ content: "数据库连接失败，请检查配置" }), doc({ content: "all ascii here" })];
  const r = searchDocuments({ query: q("连接失败"), docs });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].docIndex, 0);
});

test("search: ranking stable and deterministic", () => {
  const docs = Array.from({ length: 5 }, (_, i) => doc({ content: `common error term ${i}` }));
  const query = q("common error");
  const r1 = searchDocuments({ query, docs });
  const r2 = searchDocuments({ query, docs });
  assert.deepEqual(
    r1.hits.map((h) => h.docIndex),
    r2.hits.map((h) => h.docIndex),
  );
});

test("search: tie-break — pruned first, then newer/later position", () => {
  const older = doc({ content: "identical error body", timestamp: 1 });
  const newer = doc({ content: "identical error body", timestamp: 2 });
  const prunedOld = doc({ content: "identical error body", timestamp: 1 });
  prunedOld.prune = { kind: "stub", reason: "old-output", at: "" };
  const r = searchDocuments({ query: q("error"), docs: [older, newer, prunedOld] });
  assert.equal(r.hits[0].docIndex, 2, "pruned wins the tie");
  assert.equal(r.hits[1].docIndex, 1, "newer before older");
});

test("search: AbortSignal stops scanning", () => {
  const docs = Array.from({ length: 100 }, (_, i) => doc({ content: `item ${i} error` }));
  let calls = 0;
  const r = searchDocuments({
    query: q("error"),
    docs,
    isAborted: () => ++calls > 3,
  });
  assert.equal(r.cancelled, true);
  assert.ok(r.scanned < 100 || r.hits.length < 100);
});

test("makeSnippet: window around the hit, original line numbers, redaction", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1} content`);
  lines[9] = "line 10 password: supersecretvalue123 the error is here";
  const d = doc({ content: lines.join("\n") });
  const s = makeSnippet(d, 9, 800);
  assert.ok(s.includes("8:"), "window starts 2 lines before the hit");
  assert.ok(s.includes("10:"), "hit line kept");
  assert.ok(s.includes("more lines"), "omitted count shown");
  assert.ok(!s.includes("supersecretvalue123"), "secret redacted in snippet");
});

test("renderSearchResult: token budget trims, no-results path, partial coverage", () => {
  const docs = Array.from({ length: 10 }, () =>
    doc({ content: Array.from({ length: 200 }, (_, i) => `error TS2322 line ${i}`).join("\n") }),
  );
  const r = searchDocuments({ query: q("TS2322"), docs });
  const out = renderSearchResult({
    query: q("TS2322"),
    result: r,
    docs,
    scope: "all",
    effectiveScope: "all",
    ms: 5,
    limit: 8,
    maxResultTokens: 150,
    maxSnippetChars: 800,
  });
  assert.ok(out.details.hits < 8, `budget trims result count (got ${out.details.hits})`);
  assert.ok(out.details.hits >= 1, "at least one result kept");
  assert.equal(out.details.trimmed, true);

  const none = renderSearchResult({
    query: q("TS2322"),
    result: { hits: [], scanned: 10, cancelled: false },
    docs,
    scope: "pruned",
    effectiveScope: "all",
    pruneMetadataUnavailable: true,
    partialCoverage: true,
    ms: 5,
    limit: 8,
    maxResultTokens: 3000,
    maxSnippetChars: 800,
  });
  assert.ok(none.text.includes("No results"));
  assert.ok(none.text.includes("prune metadata unavailable"));
  assert.ok(none.text.includes("partial"));
  assert.ok(none.text.includes("scope"));
});

// ---------------------------------------------------------------------------
// Source adapter (§8.2, §8.3)
// ---------------------------------------------------------------------------

test("buildSearchDocuments: tool outputs only; engine stubs and context_search excluded", () => {
  const entries: BranchEntryLike[] = [
    branchMessage({ message: { role: "user", content: "please build" } }),
    branchMessage({
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }],
      },
    }),
    branchMessage({
      message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "1 failed, 2 passed" }] },
    }),
    branchMessage({
      message: {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "context_search",
        content: [{ type: "text", text: "search results echo 1 failed" }],
      },
    }),
    branchMessage({
      message: {
        role: "toolResult",
        toolCallId: "call-3",
        toolName: "bash",
        content: [{ type: "text", text: "stubbed content" }],
        details: { engine: "pi-context-engine", kind: "stub" },
      },
    }),
  ];
  const out = buildSearchDocuments(entries, "s1", []);
  assert.equal(out.docs.length, 1, "user/assistant/context_search/engine-stub excluded");
  assert.equal(out.docs[0].tool, "bash");
  assert.equal(out.docs[0].command, "npm test", "args correlated via toolCallId");
  assert.equal(out.compactionSeen, false);
  assert.equal(out.partialCoverage, false);
});

test("buildSearchDocuments: bashExecution entries are documents", () => {
  const entries: BranchEntryLike[] = [
    branchMessage({ message: { role: "bashExecution", command: "make build", output: "BUILD FAILED with error X", exitCode: 2 } }),
  ];
  const out = buildSearchDocuments(entries, "s1", []);
  assert.equal(out.docs.length, 1);
  assert.equal(out.docs[0].tool, "bash");
  assert.ok(out.docs[0].content.includes("BUILD FAILED"));
});

test("buildSearchDocuments: compaction coverage + pre-compaction flags", () => {
  const entries: BranchEntryLike[] = [
    branchMessage({ message: { role: "bashExecution", command: "old", output: "pre-compaction output", exitCode: 0 } }),
    { type: "compaction" },
    branchMessage({ message: { role: "bashExecution", command: "new", output: "post-compaction output", exitCode: 0 } }),
  ];
  const out = buildSearchDocuments(entries, "s1", []);
  assert.equal(out.compactionSeen, true);
  assert.equal(out.docs.length, 2);
  assert.equal(out.docs.filter((d) => d.preCompaction).length, 1);
  assert.equal(out.partialCoverage, false, "pre-compaction L0 still reachable");

  // Compaction without reachable pre-compaction docs → partial
  const entries2: BranchEntryLike[] = [
    { type: "compaction" },
    branchMessage({ message: { role: "bashExecution", command: "new", output: "only new output", exitCode: 0 } }),
  ];
  const out2 = buildSearchDocuments(entries2, "s1", []);
  assert.equal(out2.partialCoverage, true);
});

test("buildSearchDocuments: prune metadata via RecoveryRef; legacy records degrade", () => {
  const entries: BranchEntryLike[] = [
    branchMessage({ message: { role: "bashExecution", command: "npm i", output: "added 900 packages", exitCode: 0 } }),
  ];
  const okLog = [
    {
      time: "2026-01-01T00:00:00.000Z",
      action: "stub",
      reason: "install noise",
      recovery: { sessionId: "s1", contentHash: buildRecoveryRef({ sessionId: "s1", content: "added 900 packages" })!.contentHash },
    },
  ];
  const out = buildSearchDocuments(entries, "s1", okLog);
  assert.equal(out.pruneMetadataUnavailable, false);
  assert.equal(out.docs[0].prune?.kind, "stub");
  assert.equal(out.docs[0].prune?.reason, "install noise");

  const legacyLog = [{ action: "stub", item_id: "old-hash", reason: "old" }];
  const out2 = buildSearchDocuments(entries, "s1", legacyLog);
  assert.equal(out2.pruneMetadataUnavailable, true, "v0.2 records without recovery degrade");
  assert.ok(!out2.docs[0].prune);

  const wrongSession = [
    {
      action: "stub",
      recovery: { sessionId: "other-session", contentHash: "x" },
    },
  ];
  const out3 = buildSearchDocuments(entries, "s1", wrongSession);
  assert.equal(out3.pruneMetadataUnavailable, true, "session mismatch never mis-associates");
});

test("regression: pruner refs resolve via messageTimestamp even when entry timestamps skew", () => {
  // The pruner builds refs from the EFFECTIVE message (msg.timestamp).
  // Branch entries carry an append-time timestamp that can differ by ms —
  // resolution must use the message timestamp (priority 3, §6.2).
  const content = Array.from({ length: 40 }, (_, i) => `install output ${i}`).join("\n");
  const ts = 1700000000000;
  const ref = buildRecoveryRef({ sessionId: "s1", messageTimestamp: ts, content })!;
  const entries: BranchEntryLike[] = [
    {
      type: "message",
      id: "e-skew",
      timestamp: new Date(ts + 7).toISOString(), // append time ≠ creation time
      message: {
        role: "bashExecution",
        command: "npm i",
        output: content,
        exitCode: 0,
        timestamp: ts,
      },
    },
  ];
  const out = buildSearchDocuments(entries, "s1", [
    {
      time: "2026-01-01T00:00:00.000Z",
      action: "stub",
      reason: "install noise",
      recovery: { sessionId: "s1", messageTimestamp: ts, contentHash: ref.contentHash },
    },
  ]);
  assert.equal(out.pruneMetadataUnavailable, false, "priority-3 resolution not skewed by entry timestamp");
  assert.equal(out.docs[0].prune?.kind, "stub");
});
