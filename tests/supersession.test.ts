import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeSupersession,
  groupKeyForCall,
} from "../src/pruning/supersession.ts";
import { buildToolCalls } from "../src/classifier/classifier.ts";
import { searchGroupKey } from "../src/pruning/grep.ts";
import { readGroupKey } from "../src/pruning/read.ts";
import type { AnyMessage } from "../src/types.ts";
import { assistantToolCall, toolResult, userMsg } from "./factory.ts";

test("read group key ignores case and ./ prefix", () => {
  const a = readGroupKey({ toolCallId: "x", name: "read", args: { path: "./src/A.py" } })!;
  const b = readGroupKey({ toolCallId: "y", name: "read", args: { path: "src/a.py" } })!;
  assert.equal(a, b);
});

test("search group key distinguishes patterns and scopes", () => {
  const a = searchGroupKey({ toolCallId: "x", name: "grep", args: { pattern: "foo" } })!;
  const b = searchGroupKey({ toolCallId: "y", name: "grep", args: { pattern: "foo", path: "src" } })!;
  const c = searchGroupKey({ toolCallId: "z", name: "grep", args: { pattern: "bar" } })!;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("repeated identical reads: earlier members superseded, last kept", () => {
  const id1 = "r1";
  const id2 = "r2";
  const msgs: AnyMessage[] = [
    userMsg("look at a.py"),
    assistantToolCall("read", { path: "src/a.py" }, id1),
    toolResult("read", "v1", { id: id1 }),
    assistantToolCall("read", { path: "src/a.py" }, id2),
    toolResult("read", "v2", { id: id2 }),
  ];
  const sup = computeSupersession(msgs, buildToolCalls(msgs));
  const read1Idx = 2;
  assert.ok(sup.superseded.has(read1Idx), "first read superseded");
  assert.equal(sup.superseded.get(read1Idx)!.memberIndexes.at(-1), 4);
  assert.ok(!sup.superseded.has(4), "latest read not superseded");
});

test("different files never group together", () => {
  const msgs: AnyMessage[] = [
    assistantToolCall("read", { path: "a.py" }, "a1"),
    toolResult("read", "x", { id: "a1" }),
    assistantToolCall("read", { path: "b.py" }, "b1"),
    toolResult("read", "y", { id: "b1" }),
  ];
  const sup = computeSupersession(msgs, buildToolCalls(msgs));
  assert.equal(sup.superseded.size, 0);
});

test("parallel tool calls correlate by id, not position", () => {
  // One assistant message issuing two tool calls in the same batch (§35).
  const parallelCall = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "callA", name: "read", arguments: { path: "f.txt" } },
      { type: "toolCall", id: "callB", name: "read", arguments: { path: "f.txt" } },
    ],
    timestamp: Date.now(),
  } as AnyMessage;
  const msgs: AnyMessage[] = [
    userMsg("read f.txt twice"),
    parallelCall,
    toolResult("read", "first", { id: "callB" }), // results can land out of order
    toolResult("read", "second", { id: "callA" }),
  ];
  const sup = computeSupersession(msgs, buildToolCalls(msgs));
  // Two members in one group → the earlier-positioned one is superseded.
  assert.equal(sup.superseded.size, 1);
});

test("bash group key: same command groups, different does not", () => {
  const a = groupKeyForCall({ toolCallId: "1", name: "bash", args: { command: "pytest tests/" } });
  const b = groupKeyForCall({ toolCallId: "2", name: "bash", args: { command: "pytest tests/" } });
  const c = groupKeyForCall({ toolCallId: "3", name: "bash", args: { command: "pytest other/" } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
