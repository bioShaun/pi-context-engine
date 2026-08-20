/**
 * Text reports for /context and /context clean (spec §23, §24).
 * Pure functions → unit-testable, and printable in non-TUI modes.
 */

import type { ContextAnalysis, Pin, PruneAction } from "./types.ts";
import type { ContextPolicyDecision } from "./types.ts";
import { bandLabel, DEFAULT_BANDS } from "./policy/thresholds.ts";
import type { ModelInfo } from "./observer/context-observer.ts";

export function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

export interface ContextReportInputs {
  analysis: ContextAnalysis;
  model?: ModelInfo | null;
  pins: Pin[];
  compactions: number;
  decision?: ContextPolicyDecision;
  checkpointFresh?: boolean;
}

/** Largest consumers by (tool, label), for the "Largest consumers" section. */
export function largestConsumers(analysis: ContextAnalysis, n = 5): Array<{ label: string; tokens: number }> {
  const buckets = new Map<string, number>();
  for (const item of analysis.items) {
    if (item.type !== "tool-result" && item.type !== "bash") continue;
    let label = item.source ?? "tool";
    const file = item.relatedFiles?.[0];
    if (file) label = `${label}:${file}`;
    if (item.tags.includes("superseded-read") || item.tags.includes("duplicate-search")) {
      label = `${label} (old)`;
    }
    buckets.set(label, (buckets.get(label) ?? 0) + item.estimatedTokens);
  }
  return [...buckets.entries()]
    .map(([label, tokens]) => ({ label, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, n);
}

export function renderContextReport(r: ContextReportInputs): string {
  const a = r.analysis;
  const lines: string[] = [];
  lines.push("Context Engine");
  lines.push("");
  if (r.model) {
    lines.push("Model:");
    lines.push(`${r.model.provider}/${r.model.id}${r.model.name ? ` (${r.model.name})` : ""}`);
    lines.push("");
  }
  lines.push("Window:");
  lines.push(fmtInt(a.usableTokens + (r.model?.maxTokens ? 0 : 0)) + " usable");
  lines.push("");
  lines.push("Estimated usage:");
  lines.push(`${fmtInt(a.totalTokens)} / ${fmtInt(a.usableTokens)}  (${pct(a.pressure)})`);
  lines.push(`Band: ${bandLabel(a.pressure)}  ·  Quality: ${pct(a.quality)}`);
  lines.push("");
  lines.push("Classification:");
  lines.push(`critical     ${fmtK(a.criticalTokens)}   working    ${fmtK(a.workingTokens)}`);
  lines.push(`stale        ${fmtK(a.staleTokens)}   disposable ${fmtK(a.disposableTokens)}`);
  lines.push("");
  const largest = largestConsumers(a);
  if (largest.length) {
    lines.push("Largest consumers:");
    largest.forEach((c, i) => lines.push(`${i + 1}. ${c.label}  ${fmtK(c.tokens)}`));
    lines.push("");
  }
  lines.push(`Pins: ${r.pins.filter((p) => p.active).length}`);
  lines.push(`Compactions: ${r.compactions}`);
  lines.push(`Checkpoint: ${r.checkpointFresh ? "fresh" : "none/stale"}`);
  lines.push("");
  const rec = r.decision?.action ?? "none";
  lines.push(`Recommendation: ${rec.toUpperCase()}`);
  if (a.reclaimableTokens > 0) {
    lines.push(`Estimated reclaimable: ${fmtK(a.reclaimableTokens)} tokens`);
  }
  if (r.decision && r.decision.action !== "none") {
    lines.push(`Reason: ${r.decision.reason}`);
  }
  return lines.join("\n");
}

export function renderCleanReport(
  before: ContextAnalysis,
  after: ContextAnalysis,
  actions: PruneAction[],
): string {
  const saved = Math.max(0, before.totalTokens - after.totalTokens);
  const lines: string[] = [];
  lines.push("Context clean");
  lines.push("");
  lines.push(`Before: ${fmtK(before.totalTokens)}`);
  lines.push(`After:  ${fmtK(before.totalTokens - saved)}`);
  lines.push(`Saved:  ${fmtK(saved)} (${before.totalTokens ? pct(saved / before.totalTokens) : "0%"} of context)`);
  lines.push("");
  const stubs = actions.filter((x) => x.kind === "stub");
  const folds = actions.filter((x) => x.kind === "fold");
  lines.push("Pruned:");
  const byReason = new Map<string, number>();
  for (const a of [...stubs, ...folds]) byReason.set(a.reason, (byReason.get(a.reason) ?? 0) + 1);
  for (const [reason, n] of [...byReason.entries()].sort((x, y) => y[1] - x[1])) {
    lines.push(`- ${n} × ${reason}`);
  }
  if (!stubs.length && !folds.length) lines.push("- nothing to prune");
  lines.push("");
  lines.push(`(${stubs.length} stubbed, ${folds.length} folded — originals remain in session history)`);
  return lines.join("\n");
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export { DEFAULT_BANDS };
