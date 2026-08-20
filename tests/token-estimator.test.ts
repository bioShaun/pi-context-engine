import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estimateTextTokens,
  estimateMessageTokens,
  estimateContextTokens,
  messageText,
  contentFingerprint,
} from "../src/observer/token-estimator.ts";
import { userMsg, assistantText, toolResult, bashExecution } from "./factory.ts";

test("estimateTextTokens scales with length", () => {
  const short = estimateTextTokens("hello");
  const long = estimateTextTokens("hello ".repeat(1000));
  assert.ok(short > 0);
  assert.ok(long > short * 50);
});

test("messageText handles string and block content", () => {
  assert.equal(messageText(userMsg("hi")), "hi");
  assert.equal(
    messageText({
      role: "user",
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    }),
    "a\nb",
  );
});

test("estimateMessageTokens: toolResult > text alone (envelope overhead)", () => {
  const text = "output ".repeat(100);
  const tr = toolResult("bash", text);
  assert.ok(estimateMessageTokens(tr) > estimateTextTokens(text));
});

test("estimateMessageTokens handles bashExecution and assistant", () => {
  const be = bashExecution("ls", "file1\nfile2");
  assert.ok(estimateMessageTokens(be) > 0);
  assert.ok(estimateMessageTokens(assistantText("thinking about things")) > 0);
});

test("estimateContextTokens sums messages", () => {
  const msgs = [userMsg("a"), toolResult("bash", "b".repeat(400))];
  const total = estimateContextTokens(msgs);
  assert.ok(total >= msgs.reduce((s, m) => s + estimateMessageTokens(m), 0));
});

test("contentFingerprint: deterministic, collision-avoiding for head/tail", () => {
  const a = "x".repeat(5000);
  const b = "y".repeat(5000);
  assert.equal(contentFingerprint(a), contentFingerprint(a));
  assert.notEqual(contentFingerprint(a), contentFingerprint(b));
  assert.equal(contentFingerprint(""), "0:empty");
});
