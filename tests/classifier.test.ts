import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyMessages } from "../src/classifier/classifier.ts";
import type { AnyMessage, Pin } from "../src/types.ts";
import {
  userMsg,
  assistantText,
  assistantToolCall,
  toolResult,
  bashExecution,
  bigText,
  readEditReadScenario,
} from "./factory.ts";

const item = (msgs: AnyMessage[], i: number) => classifyMessages(msgs).items[i];

test("user messages are critical; latest user tagged", () => {
  const msgs = [userMsg("do A"), assistantText("ok"), userMsg("now do B")];
  const r = classifyMessages(msgs);
  assert.equal(r.items[0].class, "critical");
  assert.equal(r.items[2].class, "critical");
  assert.ok(r.items[2].tags.includes("latest-user"));
  assert.ok(!r.items[0].tags.includes("latest-user"));
});

test("assistant messages are working, never prunable by class", () => {
  const r = classifyMessages([userMsg("x"), assistantText("long reasoning")]);
  assert.equal(r.items[1].class, "working");
});

test("successful npm install output is disposable noise", () => {
  const id = "t1";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "added 1 package"), { id }),
  ];
  const it = item(msgs, 1);
  assert.equal(it.class, "disposable");
  assert.ok(it.tags.includes("install"));
});

test("failing install stays working (active problem)", () => {
  const id = "t2";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", "ERESOLVE conflict\n" + bigText(200, "error"), { id, isError: true }),
  ];
  const it = item(msgs, 1);
  assert.equal(it.class, "working");
  assert.ok(it.tags.includes("active-failure"));
});

test("read → edit → read: first read is superseded stale, latest working", () => {
  const msgs = readEditReadScenario("src/a.py");
  const r = classifyMessages(msgs);
  const read1 = r.items.find((x) => x.reason?.includes("older read"))!;
  assert.ok(read1, "found superseded read");
  assert.equal(read1.class, "stale");
  assert.ok(read1.tags.includes("superseded-read"));
  const read2 = r.items.find((x) => x.tags.includes("file-read") && !x.tags.includes("superseded-read"))!;
  assert.equal(read2.class, "working");
  assert.ok(read2.relatedFiles?.includes("src/a.py"));
});

test("pytest fail → later pytest pass: old failure is stale, pass is kept", () => {
  const id1 = "p1";
  const id2 = "p2";
  const id3 = "p3";
  const msgs: AnyMessage[] = [
    userMsg("run the tests"),
    assistantToolCall("bash", { command: "pytest tests/" }, id1),
    toolResult("bash", "FAIL test_a\nAssertionError\n" + bigText(300, "x"), { id: id1, isError: true }),
    assistantToolCall("bash", { command: "pytest tests/" }, id2),
    toolResult("bash", "217 passed in 3.2s", { id: id2 }),
    assistantToolCall("bash", { command: "pytest tests/" }, id3),
    toolResult("bash", "220 passed in 3.1s", { id: id3 }),
  ];
  const r = classifyMessages(msgs);
  const byId = (id: string) => r.items.find((x) => x.messageIndex === msgs.findIndex((m) => m.toolCallId === id))!;
  const fail = byId(id1);
  const passOld = byId(id2);
  const passNew = byId(id3);
  assert.equal(fail.class, "stale");
  assert.ok(fail.tags.includes("superseded-failure"), `got tags ${fail.tags}`);
  assert.ok(["stale", "disposable"].includes(passOld.class));
  assert.ok(["working", "disposable"].includes(passNew.class));
});

test("trivial bash (ls/pwd/git status) is disposable", () => {
  const msgs: AnyMessage[] = [bashExecution("git status", "clean\n")];
  const it = item(msgs, 0);
  assert.equal(it.class, "disposable");
  assert.ok(it.tags.includes("trivial"));
});

test("active failure (latest error) is working with high importance", () => {
  const id = "e1";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "pytest tests/" }, id),
    toolResult("bash", bigText(200, "FAILED") + "\nError: boom", { id, isError: true }),
  ];
  const it = item(msgs, 1);
  assert.equal(it.class, "working");
  assert.ok(it.importance >= 85);
});

test("engine stubs classify as terminal disposable and are not re-prunable", () => {
  const msgs: AnyMessage[] = [
    toolResult("bash", "[pi-context-engine] bash result pruned (~5K tokens) — noise", {
      details: { engine: "pi-context-engine", kind: "stub" },
    }),
  ];
  const it = item(msgs, 0);
  assert.equal(it.class, "disposable");
  assert.ok(it.engineStub);
});

test("pinned file read becomes critical and pinned", () => {
  const pin: Pin = {
    id: "pin1",
    type: "file",
    content: "src/a.py",
    createdAt: Date.now(),
    expires: "manual",
    active: true,
  };
  const msgs = readEditReadScenario("src/a.py");
  const r = classifyMessages(msgs, { pins: [pin] });
  const reads = r.items.filter((x) => x.tags.includes("file-read"));
  for (const read of reads) {
    assert.ok(read.pinned, `read ${read.messageIndex} should be pinned`);
    assert.equal(read.class, "critical");
  }
});

test("compaction summary is critical", () => {
  const msgs: AnyMessage[] = [
    { role: "compactionSummary", summary: "earlier work…", tokensBefore: 1000, timestamp: Date.now() },
  ];
  const it = item(msgs, 0);
  assert.equal(it.class, "critical");
  assert.ok(it.tags.includes("summary"));
});

test("git diff: latest is working active-diff, superseded is stale", () => {
  const id1 = "gd1";
  const id2 = "gd2";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "git diff" }, id1),
    toolResult("bash", bigText(300, "+diff"), { id: id1 }),
    assistantToolCall("bash", { command: "git diff" }, id2),
    toolResult("bash", bigText(300, "+diff2"), { id: id2 }),
  ];
  const r = classifyMessages(msgs);
  const old = r.items.find((x) => x.tags.includes("old-diff"));
  assert.ok(old, `expected old-diff item, got ${JSON.stringify(r.items.map((i) => i.tags))}`);
  assert.equal(old!.class, "stale");
  const cur = r.items.find((x) => x.tags.includes("active-diff"));
  assert.ok(cur, "expected active-diff item");
  assert.equal(cur!.class, "working");
  assert.ok(cur!.importance >= 75);
});

test("git diff --stat stays trivial (not active-diff)", () => {
  const msgs: AnyMessage[] = [bashExecution("git diff --stat", "a.py | 2 +-\n")];
  const it = classifyMessages(msgs).items[0];
  assert.ok(it.tags.includes("trivial"));
  assert.ok(!it.tags.includes("active-diff"));
});

test("small old normal command output is kept; oversized old is stale", () => {
  const pair = (id: string, cmd: string, out: string) => [
    assistantToolCall("bash", { command: cmd }, id),
    toolResult("bash", out, { id }),
  ];
  const msgs: AnyMessage[] = [];
  // 10 old pads, then the small target, then 8 fresh pads so the small
  // target falls outside the recent window (default 8).
  for (let i = 0; i < 10; i++) msgs.push(...pair(`old${i}`, `echo old${i}`, `old${i}\n`));
  msgs.push(...pair("small1", "python -c 'print(1)'", "1\n"));
  msgs.push(...pair("big1", "seq 1 3000", bigText(400, "seq")));
  // 8 fresh pads push both targets outside the recent window (default 8).
  for (let i = 0; i < 8; i++) msgs.push(...pair(`new${i}`, `echo new${i}`, `new${i}\n`));

  const r = classifyMessages(msgs);
  const at = (id: string) => r.items[msgs.findIndex((m) => m.toolCallId === id)];
  const small = at("small1")!;
  assert.equal(small.class, "working", `small old output kept, got ${small.class}: ${small.reason}`);
  assert.ok(small.tags.includes("old-output"), `tags: ${small.tags}`);
  const big = at("big1")!;
  assert.equal(big.class, "stale", `oversized old output stale, got ${big.class}: ${big.reason}`);
  assert.ok(big.tags.includes("oversized"), `tags: ${big.tags}`);
});
