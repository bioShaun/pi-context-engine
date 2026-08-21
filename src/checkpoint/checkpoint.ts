/**
 * Checkpoint generation (spec §14).
 *
 * The LLM call is injected (`complete`) so the pure parts (conversation
 * serialization, JSON extraction, validation) are unit-testable without pi.
 */

import { randomUUID } from "node:crypto";
import type { AnyMessage, Checkpoint, Pin } from "../types.ts";
import { messageText } from "../observer/token-estimator.ts";
import { checkpointSystemPrompt, validateCheckpoint } from "./schema.ts";

/**
 * Serialize the effective conversation into text for the checkpoint LLM.
 * Tool results are heavily truncated — the checkpoint cares about decisions,
 * state and constraints, not raw output.
 *
 * When over length, preserves:
 * [First user message (goal, up to 2K chars)] + [All active pins] + [Tail window] (spec §7.3).
 */
export function serializeConversation(
  messages: readonly AnyMessage[],
  opts: { maxToolChars?: number; maxTotalChars?: number; pins?: Pin[] } = {},
): string {
  const maxTool = opts.maxToolChars ?? 400;
  const maxTotal = opts.maxTotalChars ?? 120_000;

  // Extract first user message (up to 2K characters)
  let firstUserText = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = messageText(msg).trim();
      if (text) {
        firstUserText = `User (Initial Goal): ${text.slice(0, 2000)}`;
        break;
      }
    }
  }

  // Active pins summary
  let pinsText = "";
  if (opts.pins && opts.pins.length) {
    const activePins = opts.pins.filter((p) => p.active);
    if (activePins.length) {
      pinsText =
        `Active Pins:\n` +
        activePins.map((p) => `- [${p.type}] ${p.content}`).join("\n");
    }
  }

  const sections: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text = messageText(msg).trim();
        if (text) sections.push(`User: ${text}`);
        break;
      }
      case "assistant": {
        const text = messageText(msg).trim();
        const toolCalls: string[] = [];
        if (Array.isArray(msg.content)) {
          for (const b of msg.content as unknown[]) {
            if (b && typeof b === "object" && (b as { type?: string }).type === "toolCall") {
              const cb = b as { name?: string; arguments?: unknown };
              toolCalls.push(
                `Tool ${cb.name ?? "?"} ${JSON.stringify(cb.arguments ?? {}).slice(0, 200)}`,
              );
            }
          }
        }
        const lines = [
          ...(text ? [`Assistant: ${text}`] : []),
          ...toolCalls,
        ];
        if (lines.length) sections.push(lines.join("\n"));
        break;
      }
      case "toolResult": {
        const name = String(msg.toolName ?? "tool");
        const text = messageText(msg).trim();
        if (!text) break;
        const truncated =
          text.length > maxTool ? text.slice(0, maxTool) + " …[truncated]" : text;
        const err = msg.isError ? " [ERROR]" : "";
        sections.push(`Result(${name}${err}): ${truncated.replace(/\n/g, " ")}`);
        break;
      }
      case "bashExecution": {
        const out = String(msg.output ?? "").trim();
        const truncated = out.length > maxTool ? out.slice(0, maxTool) + " …" : out;
        sections.push(
          `Bash(${String(msg.command ?? "")}): ${truncated.replace(/\n/g, " ")}${
            (msg.exitCode ?? 0) !== 0 ? ` [exit ${msg.exitCode}]` : ""
          }`,
        );
        break;
      }
      case "compactionSummary": {
        const s = String(msg.summary ?? "").trim();
        if (s) sections.push(`[Earlier compaction summary]: ${s.slice(0, 4000)}`);
        break;
      }
      default:
        break;
    }
  }

  const fullBody = sections.join("\n\n");
  if (fullBody.length <= maxTotal) {
    return fullBody;
  }

  const headParts: string[] = [];
  if (firstUserText) headParts.push(firstUserText);
  if (pinsText) headParts.push(pinsText);
  const headStr = headParts.join("\n\n");
  const headBudget = headStr ? headStr.length + 4 : 0;
  const tailBudget = Math.max(1000, maxTotal - headBudget);
  const tailStr = fullBody.slice(-tailBudget);

  return headStr
    ? `${headStr}\n\n[... earlier conversation truncated ...]\n\n${tailStr}`
    : tailStr;
}

/**
 * Extract a JSON object from an LLM reply (strips code fences, finds the
 * outermost braces).
 */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

export interface GenerateResult {
  ok: boolean;
  checkpoint?: Checkpoint;
  errors: string[];
  raw?: string;
}

export interface GenerateInputs {
  messages: readonly AnyMessage[];
  /** Injected LLM call: (systemPrompt, userText, signal?) → raw text. */
  complete: (systemPrompt: string, userText: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  sessionId: string;
  tokensBefore?: number;
  source: "manual" | "auto";
  /** Active pins — constraints must be carried into the checkpoint. */
  pins?: Pin[];
  /** Injected for testability: () => void after save. */
  onSaved?: (cp: Checkpoint, saved: { path: string; name: string }) => void;
}

const USER_PROMPT = (conversation: string, pins: string[] = []) =>
  [
    "Generate the recovery checkpoint for this coding session.",
    pins.length
      ? `\nHard pins (must appear in constraints): ${pins.join(" | ")}`
      : "",
    `\n<conversation>\n${conversation}\n</conversation>`,
  ].join("");

export interface PiCompleteCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelRegistry: { complete: (model: any, params: any, options?: any) => Promise<any> };
  signal?: AbortSignal;
}

/**
 * Build the injected `complete` function from a live ExtensionContext.
 * Kept structural (no pi imports) so the pure path stays testable.
 */
export function buildComplete(
  ctx: PiCompleteCtx,
): (systemPrompt: string, userText: string, signal?: AbortSignal) => Promise<string> {
  return async (systemPrompt, userText, signal) => {
    const response = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        cacheRetention: "none",
        sessionId: randomUUID(),
        signal: signal ?? ctx.signal,
      },
    );
    if (response.stopReason === "aborted") {
      throw new Error("checkpoint generation aborted");
    }
    const content: Array<{ type: string; text?: string }> = response.content ?? [];
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  };
}

export async function generateCheckpoint(
  inputs: GenerateInputs,
  store: { saveCheckpoint: (cp: Checkpoint) => { path: string; name: string } },
): Promise<GenerateResult> {
  const conversation = serializeConversation(inputs.messages, { pins: inputs.pins });
  if (!conversation.trim()) {
    return { ok: false, errors: ["empty conversation — nothing to checkpoint"], raw: conversation };
  }
  const pinTexts = (inputs.pins ?? [])
    .filter((p) => p.active)
    .map((p) => (p.type === "file" ? `pinned file: ${p.content}` : p.content));
  const raw = await inputs.complete(
    checkpointSystemPrompt(),
    USER_PROMPT(conversation, pinTexts),
    inputs.signal,
  );
  const parsed = extractJson(raw);
  const valid = validateCheckpoint(parsed);
  if (!valid.ok) {
    return { ok: false, errors: valid.errors, raw };
  }
  const cp: Checkpoint = valid.checkpoint!;
  cp.meta = {
    session_id: inputs.sessionId,
    tokens_before: inputs.tokensBefore,
    source: inputs.source,
  };
  const saved = store.saveCheckpoint(cp);
  inputs.onSaved?.(cp, saved);
  return { ok: true, checkpoint: cp, errors: [], raw };
}
