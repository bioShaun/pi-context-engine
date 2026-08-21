/**
 * Fast token estimation (spec §32).
 *
 * v0.1 does not need tokenizer precision — trends must be right.
 * We estimate from character counts (code ≈ 4 chars/token, prose ≈ 3.5).
 * Pi-provided usage is preferred by the observer when available.
 */

import type { AnyMessage, TextPart } from "../types.ts";

export const IMAGE_TOKENS = 1600;

/**
 * CJK-aware token estimation (spec §4.4).
 * tokens ≈ ceil(asciiChars / 4 + cjkChars / 1.5)
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffee) ||
      (code >= 0xd800 && code <= 0xdbff)
    ) {
      cjk++;
    }
  }
  const ascii = text.length - cjk;
  return Math.ceil(ascii / 4 + cjk / 1.5);
}

function blockTokens(block: unknown): number {
  if (!block || typeof block !== "object") return 0;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text": {
      const text = b.text;
      return typeof text === "string" ? estimateTextTokens(text) : 0;
    }
    case "thinking": {
      const t = b.thinking ?? b.text;
      return typeof t === "string" ? estimateTextTokens(t) : 0;
    }
    case "image":
      return IMAGE_TOKENS;
    case "toolCall": {
      let n = estimateTextTokens(String(b.name ?? "")) + 6;
      try {
        n += estimateTextTokens(JSON.stringify(b.arguments ?? {}));
      } catch {
        n += 64;
      }
      return n;
    }
    default:
      return 32;
  }
}

function contentTokens(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) n += blockTokens(part);
    return n;
  }
  return estimateTextTokens(String(content));
}

/** Extract all visible text from a message's content (for hashing/folding). */
export function messageText(msg: AnyMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as unknown[]) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        else if (b.type === "thinking" && typeof b.thinking === "string")
          parts.push(b.thinking);
        else if (b.type === "toolCall") {
          parts.push(`call:${b.name ?? ""}(${JSON.stringify(b.arguments ?? {})})`);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Estimated tokens for one message. */
export function estimateMessageTokens(msg: AnyMessage): number {
  switch (msg.role) {
    case "toolResult": {
      let n = contentTokens(msg.content);
      if (msg.details != null) {
        try {
          n += Math.min(256, estimateTextTokens(JSON.stringify(msg.details)));
        } catch {
          n += 32;
        }
      }
      return n + 16; // envelope: toolCallId/toolName/isError overhead
    }
    case "bashExecution":
      return (
        estimateTextTokens(msg.command ?? "") +
        estimateTextTokens(msg.output ?? "") +
        24
      );
    case "compactionSummary":
    case "branchSummary":
      return estimateTextTokens(msg.summary ?? "") + 96;
    case "assistant":
      return contentTokens(msg.content) + 24;
    default:
      return contentTokens(msg.content) + 16;
  }
}

/** Estimated tokens for the full message list. */
export function estimateContextTokens(messages: readonly AnyMessage[]): number {
  let n = 0;
  for (const msg of messages) n += estimateMessageTokens(msg);
  return n;
}

/**
 * Cheap deterministic hash for duplicate detection.
 * Bounded: hashes length + first/last 400 chars, so huge outputs stay fast.
 */
export function contentFingerprint(text: string): string {
  const len = text.length;
  if (len === 0) return "0:empty";
  const head = text.slice(0, 400);
  const tail = len > 800 ? text.slice(-400) : "";
  let h = 2166136261 >>> 0;
  const data = `${len}\n${head}\n${tail}`;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${len}:${h.toString(16)}`;
}
