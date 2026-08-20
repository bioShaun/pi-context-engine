/**
 * Synthetic message factory for tests.
 * Mirrors pi's AgentMessage shapes (see docs/session-format.md).
 */

import type { AnyMessage } from "../src/types.ts";

let n = 0;
export function nextId(): string {
  n += 1;
  return `id-${n}`;
}

export function userMsg(text: string): AnyMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

export function assistantText(text: string): AnyMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    provider: "test",
    model: "test-model",
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function assistantToolCall(name: string, args: Record<string, unknown>, id?: string): AnyMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: id ?? nextId(), name, arguments: args }],
    timestamp: Date.now(),
    provider: "test",
    model: "test-model",
    stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function toolResult(
  toolName: string,
  text: string,
  opts: { id?: string; isError?: boolean; details?: unknown } = {},
): AnyMessage {
  return {
    role: "toolResult",
    toolCallId: opts.id ?? nextId(),
    toolName,
    content: [{ type: "text", text }],
    isError: opts.isError ?? false,
    details: opts.details,
    timestamp: Date.now(),
  };
}

export function bashExecution(command: string, output: string, opts: { exitCode?: number; cancelled?: boolean } = {}): AnyMessage {
  return {
    role: "bashExecution",
    command,
    output,
    exitCode: opts.exitCode ?? 0,
    cancelled: opts.cancelled ?? false,
    truncated: false,
    timestamp: Date.now(),
  };
}

export function bigText(repeat: number, filler = "x"): string {
  return Array.from({ length: repeat }, () => filler.repeat(40) + "\n").join("");
}

/**
 * Build a "read A, edit A, read A" conversation for supersession tests.
 */
export function readEditReadScenario(file = "src/a.py"): AnyMessage[] {
  const readId1 = nextId();
  const editId = nextId();
  const readId2 = nextId();
  return [
    userMsg(`please fix the bug in ${file}`),
    assistantToolCall("read", { path: file }, readId1),
    toolResult("read", `# v1\nold code\n`, { id: readId1 }),
    assistantToolCall("edit", { path: file, edits: [] }, editId),
    toolResult("edit", "edited", { id: editId }),
    assistantToolCall("read", { path: file }, readId2),
    toolResult("read", `# v2\nnew code\n`, { id: readId2 }),
    assistantText("The fix is in place."),
  ];
}
