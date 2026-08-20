/**
 * Handoff payload (spec §18).
 *
 * A fresh session does NOT load the whole history — only:
 * checkpoint + pins + (optional) git diff summary + next action.
 */

import type { Checkpoint, Pin } from "../types.ts";

export interface HandoffInputs {
  checkpoint?: Checkpoint | null;
  pins: Pin[];
  gitDiffSummary?: string;
  goal?: string;
}

export function buildHandoffPrompt(inputs: HandoffInputs): string {
  const cp = inputs.checkpoint;
  const lines: string[] = [];
  lines.push("You are continuing an existing coding task. Continue directly from the state below; do not ask the user to repeat it.");
  lines.push("");

  // Goal
  const goal = inputs.goal ?? cp?.task.goal;
  lines.push("## Goal");
  lines.push(goal ?? "(no goal recorded — infer from the state below)");
  lines.push("");

  // Hard constraints
  const constraints = new Set<string>(cp?.constraints ?? []);
  for (const pin of inputs.pins.filter((p) => p.active && (p.type === "constraint" || p.type === "requirement"))) {
    constraints.add(pin.content);
  }
  if (constraints.size) {
    lines.push("## Hard constraints");
    for (const c of constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  // Current state
  if (cp) {
    lines.push("## Current state");
    lines.push(`Phase: ${cp.task.phase} · Status: ${cp.task.status}`);
    if (cp.requirements.length) {
      lines.push("");
      lines.push("Requirements:");
      cp.requirements.forEach((r) => lines.push(`- ${r}`));
    }
    if (cp.decisions.length) {
      lines.push("");
      lines.push("Decisions:");
      cp.decisions.forEach((d) => lines.push(`- ${d.decision} (${d.reason || "no reason recorded"}) [${d.status}]`));
    }
    lines.push("");
    lines.push("## Modified files");
    const files = [
      ...cp.files.modified.map((f) => `modified: ${f}`),
      ...cp.files.created.map((f) => `created: ${f}`),
      ...cp.files.deleted.map((f) => `deleted: ${f}`),
    ];
    if (files.length) files.forEach((f) => lines.push(`- ${f}`));
    else lines.push("- (none recorded)");
    if (cp.files.inspected.length) {
      lines.push("");
      lines.push("Inspected files: " + cp.files.inspected.join(", "));
    }
    lines.push("");
    lines.push("## Verification");
    const v = cp.verification;
    const vlines: string[] = [];
    v.passed.length && vlines.push(`passed: ${v.passed.join(", ")}`);
    v.failed.length && vlines.push(`failed: ${v.failed.join(", ")}`);
    v.pending.length && vlines.push(`pending: ${v.pending.join(", ")}`);
    lines.push(vlines.length ? vlines.map((x) => `- ${x}`).join("\n") : "- (none recorded)");
    lines.push("");

    if (cp.issues.length) {
      lines.push("## Open issues");
      cp.issues.forEach((i) => lines.push(`- [${i.status}] ${i.description}`));
      lines.push("");
    }
  } else {
    lines.push("## Current state");
    lines.push("(no checkpoint available — inspect the repository to reconstruct state)");
    lines.push("");
  }

  if (inputs.gitDiffSummary) {
    lines.push("## Current git diff (summary)");
    lines.push(inputs.gitDiffSummary);
    lines.push("");
  }

  // Next actions
  lines.push("## Next action");
  const next = cp?.next_actions;
  if (next && next.length) lines.push(`${next[0]} (remaining: ${next.slice(1).join("; ") || "none"})`);
  else lines.push("(none recorded — propose the next step to the user)");
  lines.push("");
  lines.push("Continue directly from this state.");

  return lines.join("\n");
}
