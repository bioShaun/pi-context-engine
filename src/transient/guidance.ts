/**
 * Transient per-turn system-prompt guidance (pi-native-recall spec §14).
 *
 * Appended to the system prompt at `before_agent_start`, ONLY in high/critical
 * pressure bands, and NEVER persisted to the session (it is re-derived every
 * turn and vanishes on session switch).
 *
 * Properties (spec §14):
 *  - byte-stable: same (band, hasFolded, compactImminent) → same bytes across
 *    turns (no timestamps, no random, no session-specific data);
 *  - bounded: each template is ≤ 120 tokens (maxTokens is enforced);
 *  - deterministic pure function; fail-open at the call site.
 */

import { estimateTextTokens } from "../observer/token-estimator.ts";

export interface GuidanceState {
  /** current context pressure 0..1 (from the last analysis). */
  pressure: number;
  /** at least one engine fold/stub is present in the effective context. */
  hasFolded: boolean;
  /** the policy plans a checkpoint/compact for the next pressure band. */
  compactImminent: boolean;
}

export interface GuidanceConfig {
  enabled: boolean;
  minPressure: number;
  maxTokens: number;
  /** compact enter threshold (from the resolved policy thresholds). */
  compactEnter: number;
}

export interface Guidance {
  text: string;
  /** stable template id, e.g. "high-folded", "critical-compact". */
  templateId: string;
  band: "high" | "critical";
}

export function buildTransientGuidance(
  state: GuidanceState,
  config: GuidanceConfig,
): Guidance | null {
  if (!config.enabled) return null;
  if (!Number.isFinite(state.pressure)) return null;

  let band: "high" | "critical" | null = null;
  if (state.pressure >= config.compactEnter) band = "critical";
  else if (state.pressure >= config.minPressure) band = "high";
  if (!band) return null;

  const folded = state.hasFolded ? "-folded" : "";
  const imminent = state.compactImminent ? "-compact" : "";
  const templateId = `${band}${folded}${imminent}`;

  const parts: string[] = [];
  if (band === "critical") {
    parts.push(
      "Context engine: pressure is CRITICAL — compaction may trigger soon; " +
        "older tool output has been folded into compact stubs.",
    );
  } else {
    parts.push(
      "Context engine: pressure is high — older tool output may be stubbed or folded.",
    );
  }
  if (state.hasFolded) {
    parts.push(
      "Pruned output is still recoverable: call context_search with an error code, " +
        "file path, or command fragment before re-running commands or re-reading files.",
    );
  } else {
    parts.push(
      "If you need earlier command output or file content, call context_search " +
        "(tool:<name> / file:<path> filters) before re-running or re-reading.",
    );
  }
  if (state.compactImminent) {
    parts.push(
      "Keep replies focused on key facts (file:line, command, error code) — " +
        "they stay recoverable via context_search after compaction.",
    );
  }

  let text = parts.join(" ");
  const max = Math.max(40, config.maxTokens);
  if (estimateTextTokens(text) > max) {
    // hard last-resort bound (the fixed templates should already fit)
    text = text
      .split(" ")
      .reduce<string>(
        (acc, w) => (estimateTextTokens(acc ? `${acc} ${w}` : w) > max ? acc : acc ? `${acc} ${w}` : w),
        "",
      );
  }
  return { text, templateId, band };
}
