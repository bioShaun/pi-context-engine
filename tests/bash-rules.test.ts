import { test } from "node:test";
import assert from "node:assert/strict";

import {
  categorizeCommand,
  testGroupKey,
  normalizeCommand,
  isDisposableBash,
  foldBashOutput,
} from "../src/pruning/bash.ts";
import { detectTestOutcome } from "../src/classifier/rules.ts";

test("categorizeCommand identifies install commands", () => {
  assert.equal(categorizeCommand("npm install"), "install");
  assert.equal(categorizeCommand("pnpm add foo"), "install");
  assert.equal(categorizeCommand("pip install requests"), "install");
  assert.equal(categorizeCommand("uv sync"), "install");
  assert.equal(categorizeCommand("cargo build --release"), "build");
  assert.equal(categorizeCommand("cargo fetch"), "install");
  assert.equal(categorizeCommand("npm run build"), "normal"); // not an install
});

test("categorizeCommand identifies test commands", () => {
  assert.equal(categorizeCommand("pytest tests/"), "test");
  assert.equal(categorizeCommand("python -m pytest -x"), "test");
  assert.equal(categorizeCommand("npm test"), "test");
  assert.equal(categorizeCommand("go test ./..."), "test");
  assert.equal(categorizeCommand("jest"), "test");
});

test("categorizeCommand identifies build/fetch/trivial", () => {
  assert.equal(categorizeCommand("docker build ."), "build");
  assert.equal(categorizeCommand("wget https://example.com/x.tar.gz"), "fetch");
  assert.equal(categorizeCommand("curl -o x https://example.com"), "fetch");
  assert.equal(categorizeCommand("ls"), "trivial");
  assert.equal(categorizeCommand("pwd"), "trivial");
  assert.equal(categorizeCommand("git status"), "trivial");
  assert.equal(categorizeCommand("echo hello"), "trivial");
  assert.equal(categorizeCommand("python main.py"), "normal");
});

test("testGroupKey groups same suite, splits different suites", () => {
  const a = testGroupKey("pytest tests/parser");
  const b = testGroupKey("pytest tests/parser");
  const c = testGroupKey("pytest tests/api");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("normalizeCommand collapses whitespace and case", () => {
  assert.equal(normalizeCommand("  Git   Status "), normalizeCommand("git status"));
});

test("isDisposableBash: successful noise yes, errors no", () => {
  assert.ok(isDisposableBash("npm install", false));
  assert.ok(!isDisposableBash("npm install", true));
  assert.ok(isDisposableBash("ls", false));
  assert.ok(!isDisposableBash("pytest tests/", true)); // failing test not disposable
});

test("detectTestOutcome", () => {
  assert.equal(detectTestOutcome("217 passed in 3.2s"), "pass");
  assert.equal(detectTestOutcome("3 failed, 214 passed"), "fail");
  assert.equal(detectTestOutcome("Traceback (most recent call last):"), "fail");
  assert.equal(detectTestOutcome("random output"), "unknown");
});

test("foldBashOutput keeps head, errors, tail; small output untouched", () => {
  const lines: string[] = ["line1", "line2"];
  for (let i = 3; i < 200; i++) lines.push(`output line ${i}`);
  lines.splice(100, 0, "ValueError: something broke");
  lines.splice(150, 0, "FAILED tests/x.py::test_y");
  const output = lines.join("\n");

  const small = "just one line";
  assert.equal(foldBashOutput("cmd", small, false), small);

  const folded = foldBashOutput("pytest tests/", output, false, { maxChars: 4000 });
  assert.ok(folded.length < output.length);
  assert.ok(folded.includes("line1"), "head preserved");
  assert.ok(folded.includes("ValueError: something broke"), "errors preserved");
  assert.ok(folded.includes(`output line 199`), "tail preserved");
  assert.match(folded, /lines folded/);
});
