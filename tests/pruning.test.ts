import { test } from "node:test";
import assert from "node:assert/strict";

import { pruneContext, planForItem, MANUAL_PRUNE_OPTS } from "../src/pruning/pruner.ts";
import { buildToolCalls } from "../src/classifier/classifier.ts";
import { classifyMessages } from "../src/classifier/classifier.ts";
import { analyzeContext } from "../src/observer/context-observer.ts";
import { loadConfig } from "../src/config.ts";
import { ENGINE_ID } from "../src/types.ts";
import type { AnyMessage, ContextItem } from "../src/types.ts";
import {
  userMsg,
  assistantText,
  assistantToolCall,
  toolResult,
  bigText,
  readEditReadScenario,
} from "./factory.ts";

const config = loadConfig();
function analyze(msgs: AnyMessage[]) {
  return analyzeContext({ messages: msgs, config });
}

function makeItem(partial: Partial<ContextItem> & Pick<ContextItem, "class" | "type">): ContextItem {
  return {
    messageIndex: 0,
    id: "test",
    createdAt: 0,
    estimatedTokens: 1000,
    importance: 50,
    tags: [],
    pinned: false,
    ...partial,
  } as ContextItem;
}

test("planForItem: critical/pinned/small never pruned", () => {
  assert.equal(planForItem(makeItem({ class: "critical", type: "tool-result" }), MANUAL_PRUNE_OPTS), "keep");
  assert.equal(
    planForItem(makeItem({ class: "stale", type: "tool-result", pinned: true }), MANUAL_PRUNE_OPTS),
    "keep",
  );
  assert.equal(
    planForItem(makeItem({ class: "stale", type: "tool-result", estimatedTokens: 10 }), MANUAL_PRUNE_OPTS),
    "keep",
  );
  assert.equal(
    planForItem(makeItem({ class: "stale", type: "user" }), MANUAL_PRUNE_OPTS),
    "keep",
  );
  assert.equal(
    planForItem(makeItem({ class: "stale", type: "tool-result", engineStub: true }), MANUAL_PRUNE_OPTS),
    "keep",
  );
});

test("planForItem: stale→stub, oversized working bash→fold", () => {
  assert.equal(
    planForItem(makeItem({ class: "stale", type: "tool-result", source: "bash" }), MANUAL_PRUNE_OPTS),
    "stub",
  );
  assert.equal(
    planForItem(
      makeItem({ class: "working", type: "tool-result", source: "bash", tags: ["oversized"] }),
      MANUAL_PRUNE_OPTS,
    ),
    "fold",
  );
  assert.equal(
    planForItem(
      makeItem({ class: "working", type: "tool-result", source: "edit" }),
      MANUAL_PRUNE_OPTS,
    ),
    "keep",
  );
});

test("pruneContext does not mutate the input array or messages", () => {
  const id = "z1";
  const msgs: AnyMessage[] = [
    userMsg("install deps"),
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "install noise"), { id }),
    assistantText("done"),
  ];
  const snapshot = JSON.stringify(msgs);
  const { analysis } = analyze(msgs);
  const result = pruneContext({ messages: msgs, analysis, toolCalls: buildToolCalls(msgs), opts: MANUAL_PRUNE_OPTS });
  assert.equal(JSON.stringify(msgs), snapshot, "input unchanged");
  assert.ok(result.actions.length >= 1, "pruned the install noise");
});

test("stubbed toolResult keeps pairing fields (toolCallId/toolName/role)", () => {
  const id = "z2";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "install noise"), { id }),
  ];
  const { analysis } = analyze(msgs);
  const result = pruneContext({ messages: msgs, analysis, toolCalls: buildToolCalls(msgs), opts: MANUAL_PRUNE_OPTS });
  const stub = result.context[1];
  assert.equal(stub.role, "toolResult");
  assert.equal(stub.toolCallId, id);
  assert.equal(stub.toolName, "bash");
  assert.equal((stub.details as Record<string, unknown>).engine, ENGINE_ID);
  const text = (stub.content as Array<{ text: string }>)[0].text;
  assert.ok(text.length < 400, "stub is short");
});

test("idempotency: second prune pass produces no actions", () => {
  const id = "z3";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "install noise"), { id }),
  ];
  const { analysis: a1 } = analyze(msgs);
  const first = pruneContext({ messages: msgs, analysis: a1, toolCalls: buildToolCalls(msgs), opts: MANUAL_PRUNE_OPTS });
  assert.ok(first.actions.length > 0);

  const { analysis: a2 } = analyze(first.context);
  const second = pruneContext({
    messages: first.context,
    analysis: a2,
    toolCalls: buildToolCalls(first.context),
    opts: MANUAL_PRUNE_OPTS,
  });
  assert.equal(second.actions.length, 0, "no double-folding");
});

test("superseded read is stubbed, latest read kept intact", () => {
  const msgs = readEditReadScenario("src/a.py");
  // Make the first read oversized so it crosses the stub threshold.
  (msgs[2] as { content: Array<{ type: string; text: string }> }).content = [
    { type: "text", text: bigText(400, "v1 old code") },
  ];
  const { analysis } = analyze(msgs);
  const result = pruneContext({ messages: msgs, analysis, toolCalls: buildToolCalls(msgs), opts: MANUAL_PRUNE_OPTS });

  const stubbed = result.actions.find((a) => a.tool === "read" && a.kind === "stub");
  assert.ok(stubbed, `an old read was stubbed; actions=${JSON.stringify(result.actions.map((a) => [a.tool, a.kind, a.reason]))}`);
  // The latest read (index 6) must not be touched.
  const latest = result.context[6];
  assert.equal(latest, msgs[6], "latest read unchanged");
  // edit result untouched
  assert.equal(result.context[4], msgs[4], "edit result unchanged");
});

test("user and assistant messages are never modified", () => {
  const id = "z4";
  const msgs: AnyMessage[] = [
    userMsg("please don't change the CLI"),
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "n"), { id }),
    assistantText("I will keep the CLI stable."),
  ];
  const { analysis } = analyze(msgs);
  const result = pruneContext({ messages: msgs, analysis, toolCalls: buildToolCalls(msgs), opts: MANUAL_PRUNE_OPTS });
  assert.equal(result.context[0], msgs[0]);
  assert.equal(result.context[3], msgs[3]);
  assert.equal(result.context[1], msgs[1]);
});
