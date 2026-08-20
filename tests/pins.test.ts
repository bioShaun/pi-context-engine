import { test } from "node:test";
import assert from "node:assert/strict";

import { PinStore, ensurePinsInContext } from "../src/pins/pins.ts";
import { ENGINE_ID } from "../src/types.ts";
import type { AnyMessage, Pin } from "../src/types.ts";
import { userMsg, assistantText, toolResult, assistantToolCall } from "./factory.ts";

function memStore() {
  let data: unknown = undefined;
  return {
    load: () => data,
    save: (pins: Pin[]) => {
      data = { pins };
    },
    get: () => data,
  };
}

const mkPin = (over: Partial<Pin> = {}): Pin => ({
  id: "p1",
  type: "constraint",
  content: "Do not modify the database schema",
  createdAt: Date.now(),
  expires: "manual",
  active: true,
  ...over,
});

test("PinStore adds, dedupes, and removes pins", () => {
  const store = memStore();
  const ps = new PinStore(store.load, store.save);
  const a = ps.add("constraint", "Do not modify the database schema");
  const b = ps.add("constraint", "Do not modify the database schema");
  assert.equal(a.id, b.id, "identical active pin deduped");
  const c = ps.add("note", "use 12px margins");
  assert.notEqual(a.id, c.id);
  assert.equal(ps.all().length, 2);
  const removed = ps.remove(a.id);
  assert.equal(removed?.id, a.id);
  assert.equal(ps.all().length, 1);
  assert.equal(removed?.active, true);
  assert.equal(ps.remove("nope"), undefined);
});

test("inferType heuristics", () => {
  assert.equal(PinStore.inferType("do not touch the CLI"), "constraint");
  assert.equal(PinStore.inferType("不要修改数据库 schema"), "constraint");
  assert.equal(PinStore.inferType("the API must remain backward compatible"), "requirement");
  assert.equal(PinStore.inferType("src/parser.py"), "file");
  assert.equal(PinStore.inferType("npm test"), "command");
  assert.equal(PinStore.inferType("remember to write docs later"), "note");
});

test("ensurePinsInContext: no injection when pin already present", () => {
  const msgs: AnyMessage[] = [userMsg("Do not modify the database schema. Thanks!")];
  const r = ensurePinsInContext(msgs, [mkPin()]);
  assert.equal(r.injected.length, 0);
  assert.equal(r.messages.length, msgs.length);
});

test("ensurePinsInContext: injects missing pins once, idempotent across passes", () => {
  const msgs: AnyMessage[] = [userMsg("please fix the parser")];
  const pin = mkPin();
  const r1 = ensurePinsInContext(msgs, [pin]);
  assert.equal(r1.injected.length, 1);
  assert.equal(r1.messages.length, msgs.length + 1);
  const injected = r1.messages[r1.messages.length - 1];
  assert.equal(injected.role, "custom");
  assert.ok(String(injected.customType).startsWith(ENGINE_ID));
  assert.ok(String(injected.content).includes(pin.content));

  // Chained pass: the injected pin message is part of the corpus, so it is
  // NOT injected twice.
  const r2 = ensurePinsInContext(r1.messages, [pin]);
  assert.equal(r2.injected.length, 0, "no double injection on chained pass");
  assert.equal(r2.messages.length, msgs.length + 1);

  // Fresh effective context (as the real `context` event provides): re-injects.
  const r3 = ensurePinsInContext(msgs, [pin]);
  assert.equal(r3.injected.length, 1);
});

test("file pin only injected when file absent from context", () => {
  const pin = mkPin({ id: "f1", type: "file", content: "src/parser.py" });
  // In context: assistant mentions the file path
  const msgs1: AnyMessage[] = [userMsg("look at src/parser.py"), assistantText("reading src/parser.py now")];
  assert.equal(ensurePinsInContext(msgs1, [pin]).injected.length, 0);
  // Not in context
  const msgs2: AnyMessage[] = [userMsg("hi")];
  assert.equal(ensurePinsInContext(msgs2, [pin]).injected.length, 1);
});

test("inactive pins are ignored", () => {
  const msgs: AnyMessage[] = [userMsg("hi")];
  const r = ensurePinsInContext(msgs, [mkPin({ active: false })]);
  assert.equal(r.injected.length, 0);
});

test("multiple missing pins collapse into one injected message", () => {
  const msgs: AnyMessage[] = [userMsg("hi")];
  const pins = [
    mkPin({ id: "a", content: "constraint one" }),
    mkPin({ id: "b", type: "file", content: "src/b.ts" }),
  ];
  const r = ensurePinsInContext(msgs, pins);
  assert.equal(r.injected.length, 2);
  assert.equal(r.messages.length, msgs.length + 1);
});
