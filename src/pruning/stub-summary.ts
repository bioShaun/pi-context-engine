/**
 * Deterministic enhanced stubs (pi-native-recall spec §7).
 *
 * Every fact comes from the message structure, tool arguments, or
 * deterministic text matching — never from an LLM (P3). The rendered stub is
 * a single line with a strict length budget; fields are dropped in a fixed
 * order (§7.4). If the facts are empty the caller falls back to the generic
 * stub (§7.3). Output is byte-stable for identical input (no timestamps, no
 * random ids).
 */

import type { AnyMessage, ResolvedToolCall, StubFacts } from "../types.ts";
import { messageText } from "../observer/token-estimator.ts";
import { normalizePathLike } from "../util/hash.ts";
import { getReadRange } from "./read.ts";
import { categorizeCommand } from "./bash.ts";

// ---------------------------------------------------------------------------
// Text hygiene (spec §7.5)
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strip ANSI escape sequences and control characters; collapse newlines. */
export function stripControlChars(text: string): string {
  return (text ?? "").replace(ANSI_RE, "").replace(CTRL_RE, "");
}

/** Fold all whitespace runs into single spaces (single-line stub, §7.5). */
export function collapseWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Secret redaction (spec §7.5, §16)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>"],
  [
    // header form incl. auth scheme: "Authorization: Bearer <token>"
    /(authorization|proxy-authorization)\s*[:=]\s*["']?(?:\b(?:bearer|basic|digest|token|apikey)\b\s+)?[a-z0-9._\-/+]{8,}=*/gi,
    "$1: <redacted>",
  ],
  [/\bbearer\s+[a-z0-9._\-/+]{8,}=*/gi, "bearer <redacted>"],
  [/\bcookie\s*[:=]\s*["']?[^\n,"']{8,}/gi, "cookie: <redacted>"],
  [
    /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|token|passwd|password)\b\s*[:=]\s*["']?[a-z0-9._\-/+]{8,}=*/gi,
    "$1: <redacted>",
  ],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  [/\bgh[pousr]_[a-z0-9]{16,}\b/gi, "<redacted-github-token>"],
  [/[a-z0-9]+_([a-z0-9]{24,})\b/g, "<redacted-secret>"],
];

/**
 * Redact secret-like fragments. Deterministic; errs toward over-redaction on
 * high-entropy values next to credential keywords (precision > recall).
 */
export function redactSecrets(text: string): string {
  let out = text ?? "";
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error signature (spec §7.2: reuse + tighten the foldBashOutput rules)
// ---------------------------------------------------------------------------

/**
 * High-confidence first-error-line patterns, in priority order.
 * Tightened vs foldBashOutput's ERROR_LINE_RE: matched lines are trimmed to
 * a single line, ANSI-stripped, whitespace-collapsed, and capped without
 * ever altering the leading error code.
 */
const ERROR_SIG_PATTERNS: RegExp[] = [
  /\berror TS\d{4}\s*:[^\n]*/i, // TypeScript
  /\bpanic(?:ked)?:?\s+[^\n]*/i, // go / rust ("panic:" / "panicked at …")
  /([a-z_]*(?:error|exception|failure))\s*:\s*[^\n]*/i, // XxxError: message / error: msg
  /\b(?:fatal|exception)\s*:\s*[^\n]*/i,
  /\berror\s*:\s*[^\n]*/i,
  /\bFAILED\b[^\n]*/i, // pytest
];

export function firstErrorSignature(text: string, maxChars: number): string | undefined {
  const clean = stripControlChars(text);
  const lines = clean.split("\n");
  // Python tracebacks: the useful line is the exception at the END, not the
  // "Traceback..." marker at the start.
  if (clean.includes("Traceback (most recent call last)")) {
    const exc = lines
      .map((l) => l.trim())
      .filter((l) => /^[a-z_.]*(?:error|exception)\b/i.test(l));
    if (exc.length > 0) {
      let sig = collapseWhitespace(exc[exc.length - 1]);
      if (sig.length > maxChars) sig = sig.slice(0, maxChars - 1) + "…";
      if (sig) return sig;
    }
  }
  for (const re of ERROR_SIG_PATTERNS) {
    for (const line of lines) {
      const m = line.match(re);
      if (!m) continue;
      let sig = collapseWhitespace(m[0]);
      if (!sig) continue;
      if (sig.length > maxChars) sig = sig.slice(0, maxChars - 1) + "…";
      return sig;
    }
  }
  return undefined;
}

/** Count error-ish lines (for `errors=N`). */
const ERROR_COUNT_RE =
  /(?:[A-Za-z_.]*[Ee]rror|[A-Za-z_.]*[Ee]xception|Traceback|\bFAIL(?:ED)?\b|\bpanic\b|\bE\d{3,}\b)/;
export function countErrorLines(text: string): number {
  let n = 0;
  for (const line of stripControlChars(text).split("\n")) {
    if (line && ERROR_COUNT_RE.test(line)) n++;
  }
  return n;
}

/** Count warning-ish lines (for `warnings=N`). */
const WARNING_RE = /\bwarning\b|\bwarn\b|^\s*\[W\]/im;
export function countWarningLines(text: string): number {
  let n = 0;
  for (const line of stripControlChars(text).split("\n")) {
    if (line && WARNING_RE.test(line)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Test outcome counts (pytest / jest / cargo / go / generic)
// ---------------------------------------------------------------------------

export interface TestCounts {
  passed?: number;
  failed?: number;
  errors?: number;
}

export function extractTestCounts(text: string): TestCounts {
  const clean = stripControlChars(text);
  const lines = clean.split("\n");
  // Scan the last 20 lines: summary lines live at the end of test output.
  const tail = lines.slice(-20).join("\n");
  const pick = (re: RegExp): number | undefined => {
    const m = tail.match(re);
    return m ? Number(m[1]) : undefined;
  };
  const passed = pick(/(\d+)\s+passed\b/);
  const failed = pick(/(\d+)\s+(?:failed|failing)\b/);
  const errors = pick(/(\d+)\s+errors?\b/);
  if (passed === undefined && failed === undefined && errors === undefined) return {};
  if (/\btest result: FAILED\b/.test(tail) && failed === undefined && errors === undefined) return { failed: 1 };
  return { passed, failed, errors };
}

// ---------------------------------------------------------------------------
// Line / byte counts
// ---------------------------------------------------------------------------

export function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") return lines.length - 1;
  return lines.length;
}

/** UTF-8 byte length without pulling in node:buffer for pure-logic tests. */
export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i)!;
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c < 0x10000) {
      n += 3; // lone surrogates match Buffer.byteLength (U+FFFD, 3 bytes)
    } else {
      n += 4;
      i++; // surrogate pair consumes two UTF-16 units
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tool-specific fact extraction (spec §7.2)
// ---------------------------------------------------------------------------

function trunc(v: string, max: number): string {
  return v.length > max ? v.slice(0, max - 1) + "…" : v;
}

function bashFacts(
  msg: AnyMessage,
  call: ResolvedToolCall | undefined,
  text: string,
  maxErrorChars: number,
): StubFacts {
  const command =
    msg.role === "bashExecution" ? String(msg.command ?? "") : String(call?.args.command ?? "");
  const category = categorizeCommand(command);
  const facts: StubFacts = {};

  if (msg.cancelled) {
    facts.status = "cancelled";
  } else if (msg.role === "bashExecution") {
    if (typeof msg.exitCode === "number") {
      facts.exitCode = msg.exitCode;
      facts.status = msg.exitCode === 0 ? "success" : "failure";
    }
  } else if (msg.role === "toolResult") {
    facts.status = msg.isError ? "failure" : "success";
  }

  const err = msg.role === "bashExecution"
    ? (msg.cancelled ? true : (msg.exitCode ?? 0) !== 0)
    : Boolean(msg.isError);

  let errorCount = countErrorLines(text);
  const warningCount = countWarningLines(text);
  if (warningCount > 0) facts.warningCount = warningCount;

  if (err) {
    const sig = firstErrorSignature(text, maxErrorChars);
    if (sig) {
      facts.errorSignature = redactSecrets(sig);
      if (!facts.status) facts.status = "failure";
    }
  }

  if (category === "test") {
    const t = extractTestCounts(text);
    if (t.passed !== undefined) facts.resultCount = t.passed;
    if (t.failed !== undefined) errorCount += t.failed;
    if (t.errors !== undefined) errorCount += t.errors;
  }
  if (errorCount > 0) facts.errorCount = errorCount;

  facts.lineCount = countLines(text);
  if (command) facts.command = trunc(redactSecrets(command), 80);
  return facts;
}

function readFacts(call: ResolvedToolCall | undefined, text: string): StubFacts {
  const facts: StubFacts = {};
  const raw = call?.args.path ?? call?.args.file_path;
  if (typeof raw === "string" && raw) facts.path = trunc(normalizePathLike(raw), 60);
  if (call) {
    const r = getReadRange(call);
    const start = r.start === 0 ? 1 : r.start;
    const end = Number.isFinite(r.end) ? r.end : countLines(text);
    facts.range = { start, end: Math.max(end, start) };
  }
  facts.lineCount = countLines(text);
  return facts;
}

/**
 * grep/find/ls: short pattern or path, hit count, file count (when the
 * `path:line:content` shape is determinable), truncation state. Never
 * enumerates the full hit list (§7.2).
 */
function searchFacts(tool: string, call: ResolvedToolCall | undefined, text: string): StubFacts {
  const facts: StubFacts = {};
  const a = call?.args ?? {};
  if (tool === "grep" || tool === "find") {
    const pattern = typeof a.pattern === "string" ? a.pattern : undefined;
    if (pattern) facts.pattern = trunc(pattern, 48);
  } else if (tool === "ls") {
    const p = typeof a.path === "string" && a.path ? normalizePathLike(a.path) : undefined;
    if (p) facts.path = trunc(p, 60);
  }
  const lines = stripControlChars(text).split("\n").filter((l) => l.trim());
  facts.resultCount = lines.length;
  // file:line:content shape → distinct file count
  const filePrefixes = new Set<string>();
  let shaped = 0;
  for (const l of lines) {
    const m = l.match(/^([^:\n]+):(\d+):/);
    if (m) {
      shaped++;
      filePrefixes.add(m[1]);
    }
  }
  if (shaped > 0 && shaped === lines.length && filePrefixes.size > 0) {
    facts.fileCount = filePrefixes.size;
  }
  if (/\[\d+ more results\]|…\[truncated\]|truncated/i.test(text.slice(-200))) facts.truncated = true;
  return facts;
}

/**
 * fetch/network tools: only high-confidence structural matches (HTTP status,
 * content type, byte count). Query strings are stripped (no secrets in stubs,
 * §7.2).
 */
function fetchFacts(tool: string, call: ResolvedToolCall | undefined, text: string): StubFacts {
  const facts: StubFacts = {};
  const a = call?.args ?? {};
  const rawUrl = typeof a.url === "string" ? a.url : typeof a.target === "string" ? a.target : undefined;
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      facts.path = trunc(`${u.protocol}//${u.host}${u.pathname}`, 80); // query string dropped
    } catch {
      facts.path = trunc(rawUrl.split("?")[0], 80);
    }
  }
  const clean = stripControlChars(text);
  const status =
    clean.match(/HTTP\/[\d.]+\s+(\d{3})\b/i)?.[1] ??
    clean.match(/\bstatus["']?\s*[:=]\s*"?(\d{3})"?/i)?.[1];
  if (status) facts.httpStatus = Number(status);
  const ct = clean.match(/\bcontent[- ]?type["']?\s*[:=]\s*"?([\w.\/+-]+)/i)?.[1];
  if (ct) facts.contentType = ct;
  const bytes = clean.match(/\b(\d+)\s+bytes\b/i)?.[1];
  if (bytes) facts.byteCount = Number(bytes);
  return facts;
}

const FETCH_TOOLS = new Set(["fetch", "web_fetch", "webfetch", "http", "curl", "wget"]);

// ---------------------------------------------------------------------------
// Main entry: extract facts for one message (spec §7.2)
// ---------------------------------------------------------------------------

export interface ExtractFactsInput {
  tool: string;
  msg: AnyMessage;
  call?: ResolvedToolCall;
  /** Full original text (L0). */
  text: string;
  maxErrorChars: number;
}

export function extractStubFacts(input: ExtractFactsInput): StubFacts {
  const { tool, msg, call, text, maxErrorChars } = input;
  try {
    if (tool === "bash" || msg.role === "bashExecution") return bashFacts(msg, call, text, maxErrorChars);
    if (tool === "read") return readFacts(call, text);
    if (tool === "grep" || tool === "find" || tool === "ls") return searchFacts(tool, call, text);
    if (FETCH_TOOLS.has(tool)) return fetchFacts(tool, call, text);
    // Unrecognized tool: only tool name, original token count, reason and
    // recovery id are kept by the renderer — no free-text summary (§7.2).
    return {};
  } catch {
    // fail-open: no facts → generic stub fallback (§7.5)
    return {};
  }
}

// ---------------------------------------------------------------------------
// Budgeted single-line rendering (spec §7.3, §7.4)
// ---------------------------------------------------------------------------

export interface StubRenderInput {
  tool: string;
  facts: StubFacts;
  originalTokens: number;
  originalChars: number;
  reason: string;
  recoveryId?: string;
  maxChars: number;
  includeRecoveryRef: boolean;
}

export interface StubRenderOutput {
  text: string;
  /** Field names present in the stub (for the stub_enhanced audit, §16). */
  factFields: string[];
  /** true when nothing structured was extracted (caller keeps generic stub). */
  empty: boolean;
}

function kTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`;
}

function kBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}`;
}

/** Short reason code for the §7.4 step-4 degradation. */
export function reasonCode(reason: string): string {
  const r = (reason ?? "").trim().toLowerCase();
  const table: Record<string, string> = {
    "an older read of a file that was read again later": "superseded",
    "earlier run of the same search (kept: latest only)": "superseded",
    "older oversized command output": "old-output",
    "earlier identical successful command (kept: latest only)": "duplicate",
    "error output from an earlier identical command": "superseded",
    "failing build/install output": "active-failure",
    "directory listing": "listing",
    "install command succeeded; output is noise": "noise",
    "older search result": "old-search",
    "older tool result": "old-output",
    "older successful command output (small — kept)": "old-output",
  };
  return table[r] ?? (r.split(/\s+/).slice(0, 2).join("-").slice(0, 20) || "pruned");
}

export function renderStub(input: StubRenderInput): StubRenderOutput {
  const { tool, facts, originalTokens, originalChars, reason, maxChars, includeRecoveryRef } = input;
  const budget = Math.max(60, Math.min(maxChars, Math.floor(originalChars * 0.2)));

  const httpStatus = facts.httpStatus;
  const contentType = facts.contentType;

  interface FactSection {
    text: string;
    /** 0 = never dropped. Higher = dropped earlier (§7.4 order). */
    dropPrio: number;
    field: string;
  }

  const sections: FactSection[] = [];
  const add = (field: string, text: string | undefined, dropPrio: number) => {
    if (text !== undefined && text !== "") sections.push({ field, text, dropPrio });
  };

  // core facts (drop prio 0: always kept)
  if (facts.status === "cancelled") {
    add("status", "cancelled", 0);
  } else if (typeof facts.exitCode === "number") {
    add("exitCode", `exit=${facts.exitCode}`, 0);
  } else if (facts.status && facts.status !== "unknown") {
    add("status", facts.status, 0);
  }
  if (typeof httpStatus === "number") add("httpStatus", `status=${httpStatus}`, 0);
  if (facts.path) add("path", facts.path, 0);
  if (facts.range && (facts.range.start !== undefined || facts.range.end !== undefined)) {
    const end = facts.range.end !== undefined ? `-${facts.range.end}` : "";
    const start = facts.range.start ?? 1;
    add("range", `lines ${start}${end}`, 0);
  }
  if (typeof facts.byteCount === "number") add("byteCount", `bytes=${kBytes(facts.byteCount)}`, 3);
  if (contentType) add("contentType", `content-type=${contentType}`, 3);
  if (facts.pattern) add("pattern", `pattern="${trunc(facts.pattern, 40)}"`, 1);
  if (typeof facts.resultCount === "number" && httpStatus === undefined) {
    // bash → test pass count; grep/find → hit count
    add("resultCount", tool === "bash" ? `passed=${facts.resultCount}` : `hits=${facts.resultCount}`, 3);
  }
  if (typeof facts.fileCount === "number") add("fileCount", `files=${facts.fileCount}`, 3);
  if (facts.truncated) add("truncated", "truncated", 3);
  if (typeof facts.errorCount === "number" && facts.errorCount > 0) {
    add("errorCount", `errors=${facts.errorCount}`, 3);
  }
  if (typeof facts.lineCount === "number" && facts.lineCount > 0) {
    // skip when the range already implies it (e.g. read lines 1-240 ⇒ 240 lines)
    const implied =
      facts.range?.start !== undefined && facts.range?.end !== undefined
        ? facts.range.end - facts.range.start + 1
        : undefined;
    if (implied !== facts.lineCount) add("lineCount", `lines=${facts.lineCount}`, 3);
  }
  if (facts.command) add("command", tool === "bash" ? `cmd=${trunc(facts.command, 60)}` : trunc(facts.command, 40), 1);
  if (facts.errorSignature) add("errorSignature", `first="${trunc(facts.errorSignature, 120)}"`, 5);
  if (typeof facts.warningCount === "number" && facts.warningCount > 0) {
    add("warningCount", `warnings=${facts.warningCount}`, 2);
  }

  const core = `[pi-context-engine] ${tool} pruned`;
  let reasonText = reasonCode(reason);
  let fullReasonUsed = false;
  const reasonFull = (reason ?? "").trim();
  if (reasonFull.length <= 24) {
    reasonText = reasonFull;
    fullReasonUsed = true;
  }
  const tailParts: string[] = [];
  tailParts.push(`~${kTokens(originalTokens)} tokens`);
  tailParts.push(`reason=${reasonText}`);
  if (includeRecoveryRef && input.recoveryId) tailParts.push(`recover=${input.recoveryId}`);

  const hasFacts = sections.length > 0;
  const factFields = sections.map((s) => s.field);

  if (!hasFacts) {
    // §7.3: empty facts → generic stub shape (no empty fields).
    return {
      text: `${core}: ${tailParts.join("; ")}`,
      factFields: [],
      empty: true,
    };
  }

  const assemble = (): string => {
    const factText = sections.map((s) => s.text).join(", ");
    return `${core}: ${factText}; ${tailParts.join("; ")}`;
  };

  let text = assemble();
  // §7.4 drop order: 1) command/pattern 2) warningCount 3) lineCount/byteCount
  // (and other count trivia) 4) reason details → short code 5) errorSignature
  // truncated without touching the leading error code 6) tool, status/exitCode,
  // original token count and recovery id always survive.
  let guard = 0;
  while (text.length > budget && guard++ < 40) {
    const drop = (field: string): boolean => {
      const i = sections.findIndex((s) => s.field === field);
      if (i >= 0) {
        sections.splice(i, 1);
        return true;
      }
      return false;
    };
    if (
      drop("command") ||
      drop("pattern") ||
      drop("warningCount") ||
      drop("byteCount") ||
      drop("lineCount") ||
      drop("resultCount") ||
      drop("fileCount") ||
      drop("truncated") ||
      drop("contentType")
    ) {
      text = assemble();
      continue;
    }
    if (!fullReasonUsed && reasonText !== reasonCode(reason)) {
      reasonText = reasonCode(reason);
      text = assemble();
      continue;
    }
    // truncate the error signature without touching the leading code
    const i = sections.findIndex((s) => s.field === "errorSignature");
    if (i >= 0) {
      if (sections[i].text.length > 40) {
        sections[i] = { ...sections[i], text: `first="${trunc(facts.errorSignature!, 30)}"` };
        text = assemble();
        continue;
      }
      sections.splice(i, 1);
      text = assemble();
      continue;
    }
    break;
  }

  return { text, factFields: sections.map((s) => s.field), empty: false };
}
