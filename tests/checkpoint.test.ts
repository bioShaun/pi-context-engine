import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { validateCheckpoint, checkpointSystemPrompt } from "../src/checkpoint/schema.ts";
import {
  generateCheckpoint,
  serializeConversation,
  extractJson,
} from "../src/checkpoint/checkpoint.ts";
import { SessionStore } from "../src/checkpoint/store.ts";
import type { AnyMessage, Checkpoint } from "../src/types.ts";
import { userMsg, assistantText, toolResult, assistantToolCall } from "./factory.ts";

const VALID: Record<string, unknown> = {
  version: 1,
  created_at: "2026-08-20T20:00:00+08:00",
  task: { goal: "Fix the SNP filter module", phase: "verification", status: "in_progress" },
  requirements: ["DP >= 10"],
  constraints: ["Do not modify input VCF"],
  decisions: [{ decision: "use bcftools", reason: "no new deps", status: "active" }],
  files: { inspected: ["main.nf"], modified: ["filter.nf"], created: [], deleted: [] },
  verification: { passed: ["config"], failed: [], pending: ["test dataset"] },
  issues: [{ description: "missing DP handling", status: "open" }],
  next_actions: ["Handle missing DP"],
};

test("validateCheckpoint accepts a valid checkpoint", () => {
  const r = validateCheckpoint(VALID);
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(r.checkpoint!.task.goal, "Fix the SNP filter module");
  assert.equal(r.checkpoint!.constraints[0], "Do not modify input VCF");
});

test("validateCheckpoint rejects missing goal", () => {
  const bad = { ...VALID, task: { goal: "", phase: "x", status: "y" } };
  const r = validateCheckpoint(bad);
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes("task.goal")));
});

test("validateCheckpoint rejects non-object input", () => {
  assert.ok(!validateCheckpoint("nope").ok);
  assert.ok(!validateCheckpoint([1, 2]).ok);
  assert.ok(!validateCheckpoint(null).ok);
});

test("validateCheckpoint: valid enums accepted, absent optional defaults applied", () => {
  const r = validateCheckpoint(
    {
      ...VALID,
      decisions: [
        { decision: "d1" }, // status absent → defaults to active
        { decision: "d2", reason: "r", status: "superseded" },
      ],
      issues: [{ description: "real" }], // status absent → defaults to open
    },
  );
  assert.ok(r.ok, r.errors.join("; "));
  const cp = r.checkpoint!;
  assert.equal(cp.decisions.length, 2);
  assert.equal(cp.decisions[0].status, "active");
  assert.equal(cp.decisions[1].status, "superseded");
  assert.equal(cp.issues.length, 1);
  assert.equal(cp.issues[0].status, "open");
});

test("validateCheckpoint: invalid enum values are rejected (not normalized)", () => {
  const r1 = validateCheckpoint({
    ...VALID,
    decisions: [{ decision: "d1", status: "weird-status" }],
  });
  assert.ok(!r1.ok);
  assert.ok(r1.errors.some((e) => e.includes("decisions[0].status")));

  const r2 = validateCheckpoint({
    ...VALID,
    issues: [{ description: "real", status: "bogus" }],
  });
  assert.ok(!r2.ok);
  assert.ok(r2.errors.some((e) => e.includes("issues[0].status")));

  const r3 = validateCheckpoint({
    ...VALID,
    decisions: [{ decision: "   " }],
  });
  assert.ok(!r3.ok);
  assert.ok(r3.errors.some((e) => e.includes("decisions[0].decision")));
});

test("extractJson handles raw, fenced, and prose-wrapped JSON", () => {
  const a = extractJson('{"x": 1}');
  assert.deepEqual(a, { x: 1 });
  const b = extractJson('Here you go:\n```json\n{"y": 2}\n```\ndone');
  assert.deepEqual(b, { y: 2 });
  const c = extractJson("prefix text {\"z\": [1,2]} suffix");
  assert.deepEqual(c, { z: [1, 2] });
  assert.equal(extractJson("no json here"), undefined);
});

test("serializeConversation includes user, assistant, tool calls, truncated results", () => {
  const id = "s1";
  const msgs: AnyMessage[] = [
    userMsg("do the thing"),
    assistantToolCall("bash", { command: "npm test" }, id),
    toolResult("bash", "x".repeat(5000), { id }),
    assistantText("all good"),
  ];
  const text = serializeConversation(msgs, { maxToolChars: 100 });
  assert.ok(text.includes("User: do the thing"));
  assert.ok(text.includes("Tool bash"));
  assert.ok(text.includes("Result(bash)"));
  assert.ok(text.includes("[truncated]"));
  assert.ok(text.includes("Assistant: all good"));
  assert.ok(text.length < 500); // tool output truncated
});

test("generateCheckpoint validates and saves via store; meta attached", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".test-tmp-store-"));
  try {
    const store = new SessionStore(dir, "sess-1");
    const msgs: AnyMessage[] = [userMsg("fix the parser"), assistantText("ok, on it")];
    const complete = async (_sys: string, _user: string) =>
      JSON.stringify(VALID);
    const r = await generateCheckpoint(
      {
        messages: msgs,
        complete,
        sessionId: "sess-1",
        tokensBefore: 12345,
        source: "manual",
      },
      { saveCheckpoint: (cp) => store.saveCheckpoint(cp) },
    );
    assert.ok(r.ok, r.errors.join("; "));
    assert.equal(r.checkpoint!.meta?.source, "manual");
    assert.equal(r.checkpoint!.meta?.tokens_before, 12345);
    assert.ok(store.loadLatestCheckpoint());
    assert.equal(store.listCheckpoints()[0], "cp-0001.json");

    // Second checkpoint increments the number.
    const r2 = await generateCheckpoint(
      { messages: msgs, complete, sessionId: "sess-1", source: "auto" },
      { saveCheckpoint: (cp) => store.saveCheckpoint(cp) },
    );
    assert.ok(r2.ok);
    assert.equal(store.listCheckpoints().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generateCheckpoint rejects invalid LLM output with errors", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".test-tmp-store2-"));
  try {
    const store = new SessionStore(dir, "sess-2");
    const r = await generateCheckpoint(
      {
        messages: [userMsg("hi")],
        complete: async () => "I cannot produce JSON, sorry",
        sessionId: "sess-2",
        source: "manual",
      },
      { saveCheckpoint: (cp) => store.saveCheckpoint(cp) },
    );
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.equal(store.listCheckpoints().length, 0, "nothing saved on failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpointSystemPrompt mandates the exact schema and forbids prose", () => {
  const p = checkpointSystemPrompt();
  assert.ok(p.includes("exactly the JSON schema"));
  assert.ok(p.includes("task.goal"));
  assert.ok(p.includes("constraints"));
  assert.ok(!/summarize the conversation/i.test(p));
});

test("strict validation: rejects wrong version and malformed elements", () => {
  const badVersion = { ...VALID, version: 2 };
  assert.ok(!validateCheckpoint(badVersion).ok);
  assert.ok(validateCheckpoint({ ...VALID, version: undefined }).ok, "absent version defaults to 1");

  const badArray = { ...VALID, constraints: ["ok", 42, null] };
  const r = validateCheckpoint(badArray);
  assert.ok(!r.ok, "non-string array elements rejected");
  assert.ok(r.errors.some((e) => e.includes("constraints[1]")));

  const badStatus = { ...VALID, task: { ...(VALID.task as Record<string, unknown>), status: "exploding" } };
  assert.ok(!validateCheckpoint(badStatus).ok);

  const badIssue = { ...VALID, issues: ["not-an-object"] };
  assert.ok(!validateCheckpoint(badIssue).ok);

  const badDate = { ...VALID, created_at: "not-a-date" };
  assert.ok(!validateCheckpoint(badDate).ok);

  const badDecision = { ...VALID, decisions: [{ decision: "  " }] };
  assert.ok(!validateCheckpoint(badDecision).ok);
});
