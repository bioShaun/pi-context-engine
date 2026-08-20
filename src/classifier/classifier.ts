/**
 * Rule-based context classifier (spec §6–§8, §11–§12).
 *
 * Precision > recall (§51): only content we are highly confident is noise
 * gets the disposable/stale treatment. Everything ambiguous stays working.
 */

import type {
  AnyMessage,
  ContextItem,
  ContextClass,
  Pin,
  ResolvedToolCall,
} from "../types.ts";
import { ENGINE_ID } from "../types.ts";
import {
  estimateMessageTokens,
  messageText,
  contentFingerprint,
} from "../observer/token-estimator.ts";
import type { RuleOptions } from "./rules.ts";
import { DEFAULT_RULES, detectTestOutcome, resolveCall } from "./rules.ts";
import { scoreImportance } from "./scoring.ts";
import {
  computeSupersession,
  type SupersessionInfo,
} from "../pruning/supersession.ts";
import { categorizeCommand } from "../pruning/bash.ts";
import { normalizePathLike } from "../util/hash.ts";

export interface ClassifyResult {
  items: ContextItem[];
  toolCalls: Map<string, ResolvedToolCall>;
  supersession: SupersessionInfo;
}

export function buildToolCalls(messages: readonly AnyMessage[]): Map<string, ResolvedToolCall> {
  const map = new Map<string, ResolvedToolCall>();
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as unknown[]) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "toolCall" && typeof b.id === "string") {
        map.set(b.id, {
          toolCallId: b.id,
          name: String(b.name ?? "unknown"),
          args: (b.arguments as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return map;
}

type Estimator = (msg: AnyMessage) => number;

function makeEstimator(external?: Estimator): Estimator {
  return external ?? ((msg) => estimateMessageTokens(msg));
}

function itemBase(
  msg: AnyMessage,
  i: number,
  estimate: Estimator,
): { id: string; createdAt: number; estimatedTokens: number; text: string } {
  return {
    id: contentFingerprint(
      `${msg.role}:${i}:${messageText(msg).slice(0, 200)}`,
    ),
    createdAt: typeof msg.timestamp === "number" ? msg.timestamp : 0,
    estimatedTokens: estimate(msg),
    text: messageText(msg),
  };
}

/** Mark the last user message. */
function lastUserIndex(messages: readonly AnyMessage[]): number {
  let last = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") last = i;
  }
  return last;
}

function recentToolishSet(messages: readonly AnyMessage[], window: number): Set<number> {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const r = messages[i].role;
    if (r === "toolResult" || r === "bashExecution") idx.push(i);
  }
  return new Set(idx.slice(-window));
}

function makeItem(
  msg: AnyMessage,
  i: number,
  messages: readonly AnyMessage[],
  cls: ContextClass,
  importance: number,
  tags: string[],
  extra: Partial<ContextItem> = {},
  estimate: Estimator,
): ContextItem {
  const base = itemBase(msg, i, estimate);
  return {
    messageIndex: i,
    id: base.id,
    type: itemType(msg, base),
    source: extra.source ?? (msg.toolName as string | undefined),
    createdAt: base.createdAt,
    estimatedTokens: base.estimatedTokens,
    importance,
    class: cls,
    tags,
    pinned: false,
    reason: extra.reason,
    relatedFiles: extra.relatedFiles,
    supersededBy: extra.supersededBy,
    engineStub: extra.engineStub,
  };
}

function itemType(msg: AnyMessage, base: { text: string }): ContextItem["type"] {
  switch (msg.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool-result";
    case "bashExecution":
      return "bash";
    case "compactionSummary":
    case "branchSummary":
      return "summary";
    default:
      return "custom";
  }
}

function fileOf(call: ResolvedToolCall | undefined): string | undefined {
  if (!call) return undefined;
  const p = call.args.path ?? call.args.file_path;
  return typeof p === "string" && p ? normalizePathLike(p) : undefined;
}

/**
 * Classify one toolResult / bashExecution message.
 */
function classifyToolish(
  msg: AnyMessage,
  i: number,
  messages: readonly AnyMessage[],
  toolCalls: Map<string, ResolvedToolCall>,
  sup: SupersessionInfo,
  recent: Set<number>,
  opts: RuleOptions,
  estimate: Estimator,
): ContextItem {
  const call = resolveCall(msg, toolCalls);
  const name =
    (msg.role === "bashExecution" ? "bash" : (msg.toolName as string)) ??
    call?.name ??
    "unknown";
  const text =
    msg.role === "bashExecution" ? String(msg.output ?? "") : messageText(msg);
  const tokens = estimate(msg);
  const err =
    msg.role === "bashExecution"
      ? (msg.cancelled ? true : (msg.exitCode ?? 0) !== 0)
      : Boolean(msg.isError);

  const group = sup.superseded.get(i);
  const isSuperseded = group !== undefined;
  const groupLast = group ? group.memberIndexes[group.memberIndexes.length - 1] : undefined;

  const relatedFiles: string[] = [];
  const file = fileOf(call);
  if (file) relatedFiles.push(file);
  const tags: string[] = [name];

  // --- read ---------------------------------------------------------------
  if (name === "read") {
    if (isSuperseded) {
      return makeItem(
        msg, i, messages, "stale",
        scoreImportance(25, { verbosityPenalty: tokens >= opts.oversizedTokens ? 10 : 0 }),
        [...tags, "superseded-read"],
        { reason: "an older read of a file that was read again later", relatedFiles, supersededBy: groupLast },
        estimate,
      );
    }
    return makeItem(
      msg, i, messages, "working",
      scoreImportance(tokens >= opts.oversizedTokens ? 60 : 70),
      [...tags, "file-read", ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
      { reason: "file content (latest read of this file)", relatedFiles },
      estimate,
    );
  }

  // --- grep / find / ls ----------------------------------------------------
  if (name === "grep" || name === "find" || name === "ls") {
    if (name === "ls") {
      return makeItem(
        msg, i, messages, "disposable",
        isSuperseded ? 5 : 10,
        [...tags, isSuperseded ? "duplicate" : "listing"],
        { reason: "directory listing", relatedFiles, supersededBy: isSuperseded ? groupLast : undefined },
        estimate,
      );
    }
    if (isSuperseded) {
      return makeItem(
        msg, i, messages, "stale",
        15,
        [...tags, "duplicate-search"],
        { reason: "earlier run of the same search (kept: latest only)", relatedFiles, supersededBy: groupLast },
        estimate,
      );
    }
    const recentMember = recent.has(i);
    return makeItem(
      msg, i, messages, recentMember ? "working" : "stale",
      recentMember ? 40 : 25,
      [...tags, "search", ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
      { reason: recentMember ? "recent search result" : "older search result", relatedFiles },
      estimate,
    );
  }

  // --- bash ----------------------------------------------------------------
  if (name === "bash") {
    const command =
      msg.role === "bashExecution" ? String(msg.command ?? "") : String(call?.args.command ?? "");
    const cat = categorizeCommand(command);

    if (cat === "install" || cat === "fetch" || cat === "build") {
      if (!err) {
        return makeItem(
          msg, i, messages, "disposable",
          isSuperseded ? 5 : 10,
          [...tags, cat, "noise"],
          { reason: `${cat} command succeeded; output is noise` },
          estimate,
        );
      }
      // failing install/build is an active problem
      return makeItem(
        msg, i, messages, "working", 90,
        [...tags, cat, "active-failure"],
        { reason: "failing build/install output" },
        estimate,
      );
    }

    if (cat === "test") {
      const outcome = detectTestOutcome(text);
      if (isSuperseded) {
        return makeItem(
          msg, i, messages, "stale",
          outcome === "fail" ? 25 : 20,
          [...tags, "test", outcome === "fail" ? "superseded-failure" : "superseded-pass"],
          {
            reason:
              outcome === "fail"
                ? "older failing test run superseded by a later run of the same suite"
                : "earlier passing test run superseded by a later run",
            supersededBy: groupLast,
          },
          estimate,
        );
      }
      if (outcome === "fail") {
        return makeItem(
          msg, i, messages, "working", 90,
          [...tags, "test", "active-failure", ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
          { reason: "active failing test run (latest)" },
          estimate,
        );
      }
      if (outcome === "pass") {
        const small = tokens < opts.oversizedTokens;
        const recentMember = recent.has(i);
        return makeItem(
          msg, i, messages,
          recentMember && small ? "working" : "disposable",
          recentMember && small ? 30 : 15,
          [...tags, "test", "pass"],
          { reason: "passing test run" },
          estimate,
        );
      }
      // unknown outcome → treat like a normal command below
    }

    if (cat === "trivial") {
      if (!err) {
        return makeItem(
          msg, i, messages, "disposable", 10,
          [...tags, "trivial"],
          { reason: "trivial command output (ls/pwd/git status/...)" },
          estimate,
        );
      }
      return makeItem(
        msg, i, messages, "working", 40,
        [...tags, "trivial", "active-failure"],
        { reason: "trivial command failed" },
        estimate,
      );
    }

    // normal bash
    if (err) {
      if (isSuperseded) {
        return makeItem(
          msg, i, messages, "stale", 25,
          [...tags, "superseded-error"],
          { reason: "error output from an earlier identical command", supersededBy: groupLast },
          estimate,
        );
      }
      return makeItem(
        msg, i, messages, "working", 90,
        [...tags, "active-failure", ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
        { reason: "active failing command" },
        estimate,
      );
    }
    const recentMember = recent.has(i);
    if (isSuperseded) {
      return makeItem(
        msg, i, messages, "stale", 15,
        [...tags, "duplicate-command"],
        { reason: "earlier identical successful command (kept: latest only)", supersededBy: groupLast },
        estimate,
      );
    }
    if (recentMember) {
      return makeItem(
        msg, i, messages, "working",
        scoreImportance(tokens >= opts.oversizedTokens ? 55 : 60),
        [...tags, ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
        { reason: "recent successful command output" },
        estimate,
      );
    }
    return makeItem(
      msg, i, messages, "stale",
      scoreImportance(tokens >= opts.oversizedTokens ? 20 : 25),
      [...tags, "old-output", ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
      { reason: "older successful command output" },
      estimate,
    );
  }

  // --- edit / write ---------------------------------------------------------
  if (name === "edit" || name === "write" || name === "create") {
    const recentMember = recent.has(i);
    return makeItem(
      msg, i, messages, recentMember ? "working" : "stale",
      recentMember ? 85 : 35,
      [...tags, "file-mutation", ...(recentMember ? ["active-diff"] : [])],
      { reason: recentMember ? "recent file modification" : "earlier file modification", relatedFiles },
      estimate,
    );
  }

  // --- other tools ----------------------------------------------------------
  if (err) {
    return makeItem(
      msg, i, messages, "working", 90,
      [...tags, "active-failure"],
      { reason: "tool error (active)" },
      estimate,
    );
  }
  const recentMember = recent.has(i);
  return makeItem(
    msg, i, messages, recentMember ? "working" : "stale",
    recentMember ? 40 : 20,
    [...tags, ...(tokens >= opts.oversizedTokens ? ["oversized"] : [])],
    { reason: recentMember ? "recent tool result" : "older tool result" },
    estimate,
  );
}

function applyPins(items: ContextItem[], messages: readonly AnyMessage[], pins: Pin[]): void {
  if (!pins.length) return;
  const filePins = pins
    .filter((p) => p.active && p.type === "file")
    .map((p) => normalizePathLike(p.content));
  const textPins = pins
    .filter((p) => p.active && (p.type === "constraint" || p.type === "requirement" || p.type === "note" || p.type === "command"))
    .map((p) => normalizePathLike(p.content).slice(0, 120));

  for (const item of items) {
    if (item.engineStub) continue;
    const msg = messages[item.messageIndex];
    let pinned = false;
    if (filePins.length) {
      const files = item.relatedFiles ?? [];
      if (files.some((f) => filePins.includes(f))) pinned = true;
    }
    if (!pinned && textPins.length) {
      const text = messageText(msg);
      if (textPins.some((p) => p && text.includes(p))) pinned = true;
    }
    if (pinned) {
      item.pinned = true;
      item.class = "critical";
      item.importance = 100;
      item.tags = [...item.tags, "pinned"];
    }
  }
}

export interface ClassifyOptions {
  rules?: RuleOptions;
  pins?: Pin[];
  tokenEstimator?: (msg: AnyMessage) => number;
}

export function classifyMessages(
  messages: readonly AnyMessage[],
  opts: ClassifyOptions = {},
): ClassifyResult {
  const rules: Required<RuleOptions> = { ...DEFAULT_RULES, ...opts.rules };
  const estimate = makeEstimator(opts.tokenEstimator);
  const toolCalls = buildToolCalls(messages);
  const sup = computeSupersession(messages, toolCalls);
  const recent = recentToolishSet(messages, rules.recentWindow);
  const lastUser = lastUserIndex(messages);

  const items: ContextItem[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Engine stubs are terminal: never re-classify upward, never re-prune.
    const d = msg.details as Record<string, unknown> | undefined;
    if (d && d.engine === ENGINE_ID) {
      items[i] = makeItem(
        msg, i, messages, "disposable", 5,
        ["engine-stub"],
        { reason: "already pruned by context engine", engineStub: true },
        estimate,
      );
      continue;
    }

    switch (msg.role) {
      case "user": {
        const tags = ["user"];
        if (i === lastUser) tags.push("latest-user");
        items[i] = makeItem(msg, i, messages, "critical", 100, tags, {
          reason: i === lastUser ? "latest user request" : "user message (protected)",
        }, estimate);
        break;
      }
      case "assistant": {
        const hasToolCall = Array.isArray(msg.content) &&
          (msg.content as unknown[]).some(
            (b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall",
          );
        items[i] = makeItem(
          msg, i, messages, "working", 60,
          hasToolCall ? ["assistant", "tool-call"] : ["assistant", "reasoning"],
          { reason: hasToolCall ? "assistant turn with tool calls" : "assistant reasoning" },
          estimate,
        );
        break;
      }
      case "compactionSummary":
      case "branchSummary":
        items[i] = makeItem(
          msg, i, messages, "critical", 80, ["summary"],
          { reason: "compaction/branch summary (only record of compacted history)" },
          estimate,
        );
        break;
      case "toolResult":
      case "bashExecution":
        items[i] = classifyToolish(msg, i, messages, toolCalls, sup, recent, rules, estimate);
        break;
      default:
        items[i] = makeItem(
          msg, i, messages, "working", 50,
          [String(msg.customType ?? "custom"), "custom"],
          { reason: "extension message" },
          estimate,
        );
    }
  }

  applyPins(items, messages, opts.pins ?? []);
  return { items, toolCalls, supersession: sup };
}
