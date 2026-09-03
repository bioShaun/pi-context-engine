/**
 * Enhanced deterministic stub tests (pi-native-recall spec §19.1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractStubFacts,
  renderStub,
  stripControlChars,
  redactSecrets,
  firstErrorSignature,
  extractTestCounts,
  countLines,
  utf8ByteLength,
} from "../src/pruning/stub-summary.ts";
import { pruneContext } from "../src/pruning/pruner.ts";
import { buildToolCalls } from "../src/classifier/classifier.ts";
import { analyzeContext } from "../src/observer/context-observer.ts";
import { loadConfig } from "../src/config.ts";
import type { AnyMessage, StubFacts } from "../src/types.ts";
import { assistantToolCall, toolResult, bashExecution, bigText } from "./factory.ts";

const config = loadConfig();
const MAX_ERR = 180;

function factsFor(
  tool: string,
  msg: AnyMessage,
  text: string,
  call?: { toolCallId: string; name: string; args: Record<string, unknown> },
): StubFacts {
  return extractStubFacts({ tool, msg, call, text, maxErrorChars: MAX_ERR });
}

function render(facts: StubFacts, opts: Partial<Parameters<typeof renderStub>[0]> = {}) {
  return renderStub({
    tool: "bash",
    facts,
    originalTokens: 6200,
    originalChars: 24000,
    reason: "older oversized command output",
    recoveryId: "r:8af1c2",
    maxChars: 360,
    includeRecoveryRef: true,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// §7.5 hygiene
// ---------------------------------------------------------------------------

test("stripControlChars removes ANSI + control chars, keeps newlines", () => {
  assert.equal(stripControlChars("\x1b[31merror\x1b[0m"), "error");
  assert.equal(stripControlChars("a\x00b\x07c"), "abc");
  assert.equal(stripControlChars("line1\nline2"), "line1\nline2");
});

test("redactSecrets redacts credentials", () => {
  const out = redactSecrets(
    "Authorization: Bearer abcdef1234567890 and api_key = sk1234567890abc and AKIAIOSFODNN7EXAMPLE",
  );
  assert.ok(!out.includes("abcdef1234567890"));
  assert.ok(!out.includes("sk1234567890abc"));
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(out.includes("<redacted>"));
});

// ---------------------------------------------------------------------------
// §7.2 bash extraction
// ---------------------------------------------------------------------------

test("bash: exit 0 success", () => {
  const msg = bashExecution("npm install", "added 100 packages", { exitCode: 0 });
  const f = factsFor("bash", msg, msg.output ?? "");
  assert.equal(f.status, "success");
  assert.equal(f.exitCode, 0);
});

test("bash: exit 1 failure keeps exit code and first error signature", () => {
  const out = [
    "compiling…",
    "src/index.ts:12:3 - error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/other.ts:3:1 - error TS2345: other error",
    "found 2 errors",
  ].join("\n");
  const msg = bashExecution("npx tsc --noEmit", out, { exitCode: 1 });
  const f = factsFor("bash", msg, out);
  assert.equal(f.status, "failure");
  assert.equal(f.exitCode, 1);
  assert.ok(f.errorSignature?.includes("TS2322"));
  assert.ok(!f.errorSignature?.includes("TS2345"), "only the FIRST error");
  assert.equal(f.errorCount, 3); // TS2322 + TS2345 + "found 2 errors"
});

test("bash: cancelled beats exit code", () => {
  const msg = bashExecution("sleep 100", "^C", { exitCode: 130, cancelled: true });
  const f = factsFor("bash", msg, "^C");
  assert.equal(f.status, "cancelled");
});

test("bash: pytest error signature (exception at end of traceback)", () => {
  const out = [
    "============================= test session starts =============================",
    "collected 3 items",
    "test_a.py F",
    "=================================== FAILURES ===================================",
    "Traceback (most recent call last):",
    '  File "test_a.py", line 2, in test_a',
    "    assert 1 == 2",
    "AssertionError: assert 1 == 2",
    "=========================== 1 failed, 2 passed in 0.05s ============================",
  ].join("\n");
  const f = factsFor("bash", bashExecution("pytest", out, { exitCode: 1 }), out);
  assert.equal(f.errorSignature, "AssertionError: assert 1 == 2");
  assert.equal(f.resultCount, 2); // passed
  assert.ok((f.errorCount ?? 0) >= 1);
});

test("bash: cargo/rust panic signature", () => {
  const out = "   Compiling app v0.1.0\nthread 'main' panicked at src/main.rs:3:5:\nassertion failed";
  const f = factsFor("bash", bashExecution("cargo test", out, { exitCode: 101 }), out);
  assert.ok(f.errorSignature?.includes("panic"));
});

test("bash: generic stderr error", () => {
  const out = "Usage: foo\nerror: cannot connect to database at localhost";
  const f = factsFor("bash", bashExecution("./run.sh", out, { exitCode: 2 }), out);
  assert.ok(f.errorSignature?.includes("error: cannot connect"));
});

test("extractTestCounts: jest/cargo/generic summaries", () => {
  const a = extractTestCounts("Tests: 4 passed, 2 failed");
  assert.equal(a.passed, 4);
  assert.equal(a.failed, 2);
  const b = extractTestCounts("test result: ok. 12 passed; 0 failed");
  assert.equal(b.passed, 12);
  assert.equal(b.failed, 0);
  assert.deepEqual(extractTestCounts("no test output here"), {});
});

test("firstErrorSignature never alters the leading error code", () => {
  const sig = firstErrorSignature("error TS2322: Type 'string' is not assignable", 30);
  assert.ok(sig?.startsWith("error TS2322"));
  assert.ok((sig?.length ?? 0) <= 30);
});

// ---------------------------------------------------------------------------
// §7.2 read / grep / find / ls / fetch
// ---------------------------------------------------------------------------

test("read: path + range + line count, no file content", () => {
  const call = { toolCallId: "r1", name: "read", args: { path: "src/index.ts", offset: 1, limit: 240 } };
  const text = Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join("\n");
  const f = factsFor("read", toolResult("read", text, { id: "r1" }), text, call);
  assert.equal(f.path, "src/index.ts");
  assert.deepEqual(f.range, { start: 1, end: 240 });
  assert.equal(f.lineCount, 240);
  assert.ok(!("errorSignature" in f));
});

test("grep: pattern + hit count + file count from path:line shape", () => {
  const call = { toolCallId: "g1", name: "grep", args: { pattern: "TODO", path: "src" } };
  const text = "src/a.ts:10:TODO fix\nsrc/a.ts:44:TODO later\nsrc/b.ts:3:TODO here";
  const f = factsFor("grep", toolResult("grep", text, { id: "g1" }), text, call);
  assert.equal(f.pattern, "TODO");
  assert.equal(f.resultCount, 3);
  assert.equal(f.fileCount, 2);
});

test("unrecognized tool: no free-text facts", () => {
  const f = factsFor("mcp WeirdTool", toolResult("mcp", "anything at all", {}), "anything at all");
  assert.deepEqual(Object.keys(f), []);
});

test("fetch: url query stripped, status/content-type/bytes kept", () => {
  const call = { toolCallId: "f1", name: "fetch", args: { url: "https://api.example.com/v1/x?token=sekret123456" } };
  const text = "HTTP/1.1 404 Not Found\ncontent-type: application/json\nreceived 1523 bytes";
  const f = factsFor("fetch", toolResult("fetch", text, { id: "f1" }), text, call);
  assert.equal(f.httpStatus, 404);
  assert.equal(f.contentType, "application/json");
  assert.equal(f.byteCount, 1523);
  assert.ok(!JSON.stringify(f).includes("sekret"), "query string secrets dropped");
});

// ---------------------------------------------------------------------------
// §7.3/§7.4 rendering + budget
// ---------------------------------------------------------------------------

test("render format: single line with facts, tokens, reason, recover", () => {
  const out = render({
    status: "failure",
    exitCode: 1,
    errorCount: 3,
    errorSignature: "TS2322: Type 'string' is not assignable to type 'number'",
    lineCount: 428,
  });
  assert.ok(!out.empty);
  assert.ok(!out.text.includes("\n"), "stub is a single line");
  assert.ok(out.text.startsWith("[pi-context-engine] bash pruned:"));
  assert.ok(out.text.includes("exit=1"));
  assert.ok(out.text.includes("errors=3"));
  assert.ok(out.text.includes("first=\"TS2322"));
  assert.ok(out.text.includes("lines=428"));
  assert.ok(out.text.includes("~6.2K tokens"));
  assert.ok(out.text.includes("recover=r:8af1c2"));
});

test("empty facts degrade to generic stub shape", () => {
  const out = render({});
  assert.equal(out.empty, true);
  assert.ok(out.text.startsWith("[pi-context-engine] bash pruned:"));
  assert.ok(!out.text.includes("exit="));
});

test("byte-stable: identical input → identical output", () => {
  const facts = factsFor(
    "bash",
    bashExecution("pytest -q", "1 failed, 2 passed", { exitCode: 1 }),
    "1 failed, 2 passed",
  );
  const a = render(facts);
  const b = render(facts);
  assert.equal(a.text, b.text);
});

test("budget: fields dropped in §7.4 order under a tight char budget", () => {
  const facts: StubFacts = {
    status: "failure",
    exitCode: 1,
    command: "npx turbo run build --filter=apps/web",
    warningCount: 2,
    lineCount: 900,
    byteCount: 40000,
    errorSignature: "TS2322: Type 'string' is not assignable to type 'number'",
  };
  // budget = min(200, floor(800*0.2)) = 160: command/warnings/counts drop,
  // reason shortens, error signature truncates but keeps its leading code.
  const out = render(facts, { originalChars: 800, maxChars: 200 });
  assert.ok(out.text.length <= 200, `stub within maxChars (${out.text.length})`);
  assert.ok(!out.text.includes("cmd="), "command dropped first");
  assert.ok(!out.text.includes("warnings="), "warnings dropped second");
  assert.ok(!out.text.includes("lines=900"), "line count dropped");
  assert.ok(out.text.includes("exit=1"), "exit code never dropped");
  assert.ok(out.text.includes("recover="), "recovery id never dropped");
  assert.ok(out.text.includes("TS2322"), "error code survives signature truncation");
});

test("utf8ByteLength matches Buffer.byteLength", () => {
  for (const s of ["plain", "中文测试", "mixed 中英 123", "emoji 🎉"]) {
    assert.equal(utf8ByteLength(s), Buffer.byteLength(s));
  }
});

test("countLines: trailing newline not counted as an extra line", () => {
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines("a\nb\nc\n"), 3);
  assert.equal(countLines(""), 0);
});

// ---------------------------------------------------------------------------
// pruner integration: recovery id + never-enlarge + action fields
// ---------------------------------------------------------------------------

function prune(msgs: AnyMessage[]) {
  const { analysis } = analyzeContext({ messages: msgs, config });
  return pruneContext({
    messages: msgs,
    analysis,
    toolCalls: buildToolCalls(msgs),
    opts: { stubMinTokens: 20, foldMaxChars: 1200, mode: "manual" },
    sessionId: "sess-test",
    stub: {
      enhanced: true,
      maxChars: 360,
      maxErrorChars: 180,
      includeRecoveryRef: true,
    },
    cacheAware: true,
  });
}

test("pruner: applied stub carries RecoveryRef and audit fields", () => {
  const id = "tc1";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "install noise"), { id }),
  ];
  const result = prune(msgs);
  assert.ok(result.actions.length >= 1);
  const a = result.actions[0];
  assert.ok(a.recovery?.contentHash, "recovery ref present");
  assert.equal(a.recovery?.sessionId, "sess-test");
  assert.equal(a.toolCallId, id);
  assert.equal(a.level, 3);
  assert.ok((a.reclaimableTokens ?? 0) > 0);
  assert.ok(typeof a.cacheLocality === "number");
  assert.equal(a.selectedRank, 1);
  const replaced = result.context.find(
    (m) => m.role === "toolResult" && (m as { details?: unknown }).details,
  ) as unknown as { details: Record<string, unknown> };
  assert.equal(replaced.details.engine, "pi-context-engine");
  assert.equal(replaced.details.level, 3);
  assert.equal(replaced.details.kind, "stub");
  assert.equal(typeof replaced.details.replacementTokens, "number");
  assert.ok(replaced.details.recovery, "details carry the recovery ref (§6.3)");
});

test("pruner: stub text shorter than original never enlarges", () => {
  const id = "tc2";
  const smallOutput = "ok".repeat(20); // ~40 chars, low token count
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "echo hi" }, id),
    toolResult("bash", smallOutput, { id }),
  ];
  const result = prune(msgs);
  // Either kept (below stub threshold / no savings) or strictly smaller.
  for (const a of result.actions) {
    assert.ok(a.replacementTokens < a.originalTokens, "replacement strictly smaller");
  }
});

test("pruner: recoveryUnavailable recorded when sessionId missing", () => {
  const id = "tc3";
  const msgs: AnyMessage[] = [
    assistantToolCall("bash", { command: "npm install" }, id),
    toolResult("bash", bigText(400, "noise"), { id }),
  ];
  const { analysis } = analyzeContext({ messages: msgs, config });
  const result = pruneContext({
    messages: msgs,
    analysis,
    toolCalls: buildToolCalls(msgs),
    opts: { stubMinTokens: 20, foldMaxChars: 1200, mode: "manual" },
    sessionId: undefined,
  });
  assert.ok(result.actions.length >= 1);
  assert.equal(result.actions[0].recoveryUnavailable, "no-session-id");
  assert.ok(!result.actions[0].recovery);
});

test("pruner: bashExecution stub names the tool 'bash', never the literal 'tool'", () => {
  const msgs: AnyMessage[] = [
    { role: "user", content: "install deps", timestamp: Date.now() },
    bashExecution("npm install", bigText(400, "install noise"), { exitCode: 0 }),
  ];
  const result = prune(msgs);
  assert.ok(result.actions.length >= 1);
  assert.equal(result.actions[0].tool, "bash");
  const stubbed = result.context.find(
    (m) => m.role === "bashExecution" && m.output?.startsWith("[pi-context-engine]"),
  );
  assert.ok(stubbed, "bashExecution stubbed");
  assert.ok(stubbed!.output!.startsWith("[pi-context-engine] bash pruned:"), `got: ${stubbed!.output!.slice(0, 60)}`);
});
