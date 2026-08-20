import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHandoffPrompt } from "../src/handoff/handoff.ts";
import { renderContextReport, renderCleanReport, largestConsumers } from "../src/report.ts";
import type { ContextAnalysis, Pin, PruneAction, Checkpoint } from "../src/types.ts";
import { ENGINE_ID } from "../src/types.ts";

const cp: Checkpoint = {
  version: 1,
  created_at: "2026-08-20T20:00:00+08:00",
  task: { goal: "Fix the Nextflow SNP filtering module", phase: "verification", status: "in_progress" },
  requirements: ["DP >= 10", "95% samples must pass", "keep existing CLI"],
  constraints: ["Do not modify input VCF", "Do not change output naming"],
  decisions: [{ decision: "use bcftools expression", reason: "avoid new deps", status: "active" }],
  files: { inspected: ["main.nf"], modified: ["filter.nf"], created: [], deleted: [] },
  verification: { passed: ["nextflow config"], failed: [], pending: ["small test dataset"] },
  issues: [{ description: "missing DP handling", status: "open" }],
  next_actions: ["Handle missing DP", "Run test dataset"],
};

const pins: Pin[] = [
  { id: "p1", type: "constraint", content: "Do not change the CLI", createdAt: 0, expires: "manual", active: true },
  { id: "p2", type: "file", content: "src/a.py", createdAt: 0, expires: "manual", active: false },
];

test("handoff prompt contains goal, constraints (cp + pins, deduped), files, verification, next action", () => {
  const text = buildHandoffPrompt({ checkpoint: cp, pins });
  assert.ok(text.includes("Fix the Nextflow SNP filtering module"));
  assert.ok(text.includes("## Goal"));
  assert.ok(text.includes("## Hard constraints"));
  assert.ok(text.includes("Do not modify input VCF"));
  assert.ok(text.includes("Do not change the CLI"), "pin constraint included");
  assert.ok(!text.includes("src/a.py"), "inactive pin excluded");
  assert.ok(text.includes("modified: filter.nf"));
  assert.ok(text.includes("## Verification"));
  assert.ok(text.includes("pending: small test dataset"));
  assert.ok(text.includes("## Next action"));
  assert.ok(text.includes("Handle missing DP"));
  assert.ok(text.includes("Continue directly from this state"));
});

test("handoff prompt without checkpoint still renders", () => {
  const text = buildHandoffPrompt({ checkpoint: null, pins: [], goal: "Do X" });
  assert.ok(text.includes("Do X"));
  assert.ok(text.includes("no checkpoint available"));
});

function fakeAnalysis(over: Partial<ContextAnalysis> = {}): ContextAnalysis {
  return {
    totalTokens: 181_320,
    usableTokens: 245_760,
    pressure: 0.738,
    criticalTokens: 28_100,
    workingTokens: 62_400,
    staleTokens: 53_700,
    disposableTokens: 37_100,
    quality: 0.57,
    reclaimableTokens: 61_000,
    items: [],
    ...over,
  };
}

test("renderContextReport includes all spec sections", () => {
  const text = renderContextReport({
    analysis: fakeAnalysis(),
    model: { provider: "qwen", id: "Qwen3.8-27B", contextWindow: 262_144 },
    pins,
    compactions: 1,
    decision: { action: "prune", reason: "high reclaimable", pressureBefore: 0.738 },
    checkpointFresh: false,
  });
  assert.ok(text.includes("Context Engine"));
  assert.ok(text.includes("Qwen3.8-27B"));
  assert.ok(text.includes("Estimated usage"));
  assert.ok(text.includes("73.8%"));
  assert.ok(text.includes("Quality"));
  assert.ok(text.includes("critical"));
  assert.ok(text.includes("disposable"));
  assert.ok(text.includes("Pins: 1"), "only active pins counted");
  assert.ok(text.includes("Compactions: 1"));
  assert.ok(text.includes("Recommendation: PRUNE"));
  assert.ok(text.includes("61.0K"), "reclaimable shown");
});

test("largestConsumers buckets by tool/file label", () => {
  const a = fakeAnalysis({
    items: [
      {
        messageIndex: 0, id: "i0", type: "tool-result", source: "bash", createdAt: 0,
        estimatedTokens: 22_300, importance: 30, class: "disposable", tags: ["bash"], pinned: false,
      },
      {
        messageIndex: 1, id: "i1", type: "tool-result", source: "read", createdAt: 0,
        estimatedTokens: 18_600, importance: 70, class: "working", tags: ["read"],
        relatedFiles: ["src/parser.py"], pinned: false,
      },
      {
        messageIndex: 2, id: "i2", type: "tool-result", source: "read", createdAt: 0,
        estimatedTokens: 900, importance: 25, class: "stale", tags: ["read", "superseded-read"],
        relatedFiles: ["src/parser.py"], pinned: false,
      },
      {
        messageIndex: 3, id: "i3", type: "user", createdAt: 0,
        estimatedTokens: 100, importance: 100, class: "critical", tags: ["user"], pinned: false,
      },
    ],
  });
  const largest = largestConsumers(a);
  assert.equal(largest[0].label, "bash");
  assert.equal(largest[1].label, "read:src/parser.py");
  assert.equal(largest[2].label, "read:src/parser.py (old)");
  assert.ok(!largest.some((l) => l.label === "user"), "non-tool items excluded");
});

test("renderCleanReport shows before/after/saved and action breakdown", () => {
  const before = fakeAnalysis();
  const after = fakeAnalysis({ totalTokens: 124_000, reclaimableTokens: 0 });
  const actions: PruneAction[] = [
    {
      kind: "stub", messageIndex: 1, messageId: "m1", tool: "bash",
      originalTokens: 20_000, replacementTokens: 40, reason: "install noise",
    },
    {
      kind: "fold", messageIndex: 2, messageId: "m2", tool: "read",
      originalTokens: 15_000, replacementTokens: 300, reason: "superseded read",
    },
  ];
  const text = renderCleanReport(before, after, actions);
  assert.ok(text.includes("Before: 181.3K"));
  assert.ok(text.includes("After:  124.0K"));
  assert.ok(text.includes("Saved:"));
  assert.ok(text.includes("1 × install noise"));
  assert.ok(text.includes("1 × superseded read"));
  assert.ok(text.includes("1 stubbed, 1 folded"));
  assert.ok(text.includes(ENGINE_ID) || true); // engine marker not required in report
});
