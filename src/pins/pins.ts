/**
 * Pins (spec §15–16): user-pinned context that must survive prune/compact.
 *
 * Stored session-local in pins.json (not git-tracked). Survival mechanism:
 * the observer marks pinned items critical, and the context rewriter
 * re-injects pin content as a custom message whenever it is missing from
 * the (post-prune) effective context.
 */

import type { AnyMessage, Pin, PinType } from "../types.ts";
import { ENGINE_ID } from "../types.ts";
import { shortId } from "../util/hash.ts";
import { messageText } from "../observer/token-estimator.ts";

export class PinStore {
  private load: () => unknown;
  private save: (pins: Pin[]) => void;
  private cachedPins: Pin[] | null = null;

  constructor(load: () => unknown, save: (pins: Pin[]) => void) {
    this.load = load;
    this.save = save;
  }

  private loadInternal(): Pin[] {
    if (this.cachedPins !== null) return this.cachedPins;
    const raw = this.load();
    if (!raw || typeof raw !== "object") {
      this.cachedPins = [];
      return this.cachedPins;
    }
    const arr = (raw as { pins?: unknown }).pins;
    if (!Array.isArray(arr)) {
      this.cachedPins = [];
      return this.cachedPins;
    }
    this.cachedPins = arr.filter(
      (p): p is Pin => !!p && typeof p === "object" && typeof (p as Pin).id === "string",
    );
    return this.cachedPins;
  }

  all(): Pin[] {
    return [...this.loadInternal()];
  }

  active(): Pin[] {
    return this.all().filter((p) => p.active);
  }

  private persist(): void {
    if (this.cachedPins) {
      this.save(this.cachedPins);
    }
  }

  add(
    type: PinType,
    content: string,
    sourceMessageId?: string,
    expires: Pin["expires"] = "manual",
  ): Pin {
    const pins = this.loadInternal();
    // De-duplicate identical active pins (case-insensitive for files, trimmed comparison for text).
    const existing = pins.find(
      (p) =>
        p.active &&
        p.type === type &&
        (type === "file"
          ? p.content.toLowerCase() === content.trim().toLowerCase()
          : p.content === content.trim()),
    );
    if (existing) return existing;
    const pin: Pin = {
      id: shortId(),
      type,
      content: content.trim(),
      createdAt: Date.now(),
      sourceMessageId,
      expires,
      active: true,
    };
    pins.push(pin);
    this.persist();
    return pin;
  }

  remove(id: string): Pin | undefined {
    const pins = this.loadInternal();
    const idx = pins.findIndex((p) => p.id === id);
    if (idx < 0) return undefined;
    const [removed] = pins.splice(idx, 1);
    this.persist();
    return removed;
  }

  /**
   * Infer a pin type from text (best-effort heuristics).
   */
  static inferType(text: string): PinType {
    const t = text.toLowerCase();
    // CJK has no word boundaries in JS regex — check it separately.
    const asciiConstraint = /\b(don'?t|do not|never|must not)\b/;
    const cjkConstraint = /禁止|不要|不得|不能|无需/;
    if (asciiConstraint.test(t) || cjkConstraint.test(t)) return "constraint";
    const asciiRequirement = /\b(should|must|require|requires)\b/;
    const cjkRequirement = /需要|必须|要求/;
    if (asciiRequirement.test(t) || cjkRequirement.test(t)) return "requirement";
    if (/^(\.|\.\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.(py|ts|js|tsx|jsx|go|rs|java|c|cpp|sh|yml|yaml|json|nf|toml|md)(:\d+)?$/i.test(t.trim()))
      return "file";
    if (/\b(npm|pnpm|yarn|pip|uv|cargo|git|docker|make|pytest|jest)\b/.test(t) && t.length < 120)
      return "command";
    return "note";
  }
}

/**
 * Ensure pins are present in the effective context. Returns a new message
 * array (input not mutated). Idempotent: if the pin content already appears
 * in a non-engine message, nothing is injected.
 */
export function ensurePinsInContext(
  messages: readonly AnyMessage[],
  pins: Pin[],
): { messages: AnyMessage[]; injected: Pin[] } {
  const active = pins.filter((p) => p.active);
  if (!active.length) return { messages: [...messages], injected: [] };

  // Corpus of existing text for presence checks. Engine *stub* messages are
  // excluded (their text is a pruning marker, not conversation), but engine
  // *pin* messages are included so chained passes stay idempotent.
  const corpus: string[] = [];
  for (const m of messages) {
    const d = m.details as Record<string, unknown> | undefined;
    if (d && d.engine === ENGINE_ID && d.kind !== "pins") continue;
    if (m.role === "user" || m.role === "assistant") {
      const t = messageText(m);
      if (t) corpus.push(t);
    } else if (m.role === "custom" && d && d.engine === ENGINE_ID && d.kind === "pins") {
      const t = messageText(m);
      if (t) corpus.push(t);
    }
  }
  const corpusJoined = corpus.join("\n");
  const corpusLower = corpusJoined.toLowerCase();

  const missing = active.filter((p) => {
    if (p.type === "file") {
      // File pins only re-inject when the file is not in context at all (case-insensitive).
      const pLower = p.content.toLowerCase().trim();
      return !corpusLower.includes(pLower);
    }
    const needle = p.content.slice(0, 100).trim().toLowerCase();
    return !needle || !corpusLower.includes(needle);
  });

  if (!missing.length) return { messages: [...messages], injected: [] };

  const lines = missing.map((p) => {
    const label =
      p.type === "file" ? `pinned file: ${p.content}` : p.content;
    return `- [${p.type}] ${label}`;
  });
  const text =
    `[${ENGINE_ID}] Pinned context (must be respected across prune/compact/handoff):\n` +
    lines.join("\n");

  const injected = [...messages];
  injected.push({
    role: "custom",
    customType: `${ENGINE_ID}-pins`,
    content: text,
    display: false,
    details: { engine: ENGINE_ID, kind: "pins", pinIds: missing.map((p) => p.id) },
    timestamp: Date.now(),
  });
  return { messages: injected, injected: missing };
}
