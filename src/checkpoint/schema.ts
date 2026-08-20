/**
 * Checkpoint schema (spec §13) — strict validation, hand-rolled (no deps).
 */

import type { Checkpoint, CheckpointDecision } from "../types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  checkpoint?: Checkpoint;
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function strArray(v: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  return v.filter((x): x is string => isStr(x));
}

function decisionArray(v: unknown, field: string, errors: string[]): CheckpointDecision[] {
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const out: CheckpointDecision[] = [];
  for (const d of v) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    if (!isStr(o.decision) || !o.decision.trim()) continue;
    out.push({
      decision: o.decision.trim(),
      reason: isStr(o.reason) ? o.reason : "",
      status: o.status === "superseded" || o.status === "abandoned" ? o.status : "active",
    });
  }
  return out;
}

/**
 * Validate + normalize an LLM-produced checkpoint.
 * Missing optional sections default to empty; structurally broken input fails.
 */
export function validateCheckpoint(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["checkpoint must be a JSON object"] };
  }
  const o = raw as Record<string, unknown>;

  const task = (o.task ?? {}) as Record<string, unknown>;
  const goal = isStr(task.goal) ? task.goal.trim() : "";
  if (!goal) errors.push("task.goal is required and must be a non-empty string");

  const files = (o.files ?? {}) as Record<string, unknown>;
  const verification = (o.verification ?? {}) as Record<string, unknown>;
  const issuesRaw = Array.isArray(o.issues) ? o.issues : [];
  if (o.issues !== undefined && !Array.isArray(o.issues))
    errors.push("issues must be an array");

  type Issue = { description: string; status: "open" | "resolved" | "blocked" };
  const issues: Issue[] = [];
  for (const it of issuesRaw) {
    const r = (it ?? {}) as Record<string, unknown>;
    if (!isStr(r.description) || !r.description.trim()) continue;
    const status: Issue["status"] =
      r.status === "resolved" || r.status === "blocked" ? (r.status as Issue["status"]) : "open";
    issues.push({ description: r.description.trim(), status });
  }

  const checkpoint: Checkpoint = {
    version: 1,
    created_at: isStr(o.created_at) ? o.created_at : new Date().toISOString(),
    task: {
      goal,
      phase: isStr(task.phase) ? task.phase : "in_progress",
      status: isStr(task.status) ? task.status : "in_progress",
    },
    requirements: strArray(o.requirements, "requirements", errors),
    constraints: strArray(o.constraints, "constraints", errors),
    decisions: decisionArray(o.decisions, "decisions", errors),
    files: {
      inspected: strArray(files.inspected, "files.inspected", errors),
      modified: strArray(files.modified, "files.modified", errors),
      created: strArray(files.created, "files.created", errors),
      deleted: strArray(files.deleted, "files.deleted", errors),
    },
    verification: {
      passed: strArray(verification.passed, "verification.passed", errors),
      failed: strArray(verification.failed, "verification.failed", errors),
      pending: strArray(verification.pending, "verification.pending", errors),
    },
    issues,
    next_actions: strArray(o.next_actions, "next_actions", errors),
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], checkpoint };
}

/**
 * The strict generation prompt (spec §14).
 * "Produce a recovery checkpoint using exactly this schema." — never
 * "summarize the conversation".
 */
export function checkpointSystemPrompt(): string {
  return [
    "You are a recovery-checkpoint generator for a coding agent session.",
    "Produce a recovery checkpoint using exactly the JSON schema below.",
    "Do not summarize in conversational style. No prose outside the JSON.",
    "",
    "Preserve:",
    "- explicit user constraints (verbatim where possible)",
    "- unresolved issues",
    "- implementation decisions and their reasons",
    "- verification status (what passed, what failed, what is pending)",
    "- next executable actions",
    "",
    "Output ONLY a single JSON object matching this schema:",
    JSON.stringify(
      {
        version: 1,
        created_at: "<ISO-8601 timestamp>",
        task: { goal: "string", phase: "string", status: "in_progress|blocked|done" },
        requirements: ["string"],
        constraints: ["string"],
        decisions: [{ decision: "string", reason: "string", status: "active|superseded|abandoned" }],
        files: { inspected: ["string"], modified: ["string"], created: ["string"], deleted: ["string"] },
        verification: { passed: ["string"], failed: ["string"], pending: ["string"] },
        issues: [{ description: "string", status: "open|resolved|blocked" }],
        next_actions: ["string"],
      },
      null,
      2,
    ),
    "",
    "Rules:",
    "- Every field must be present (use empty arrays when nothing applies).",
    "- task.goal must capture the user's current objective in one sentence.",
    "- constraints must include every hard user constraint (e.g. 'do not modify X').",
    "- next_actions must be concrete and executable, in order.",
    "- Do not invent facts that are not supported by the conversation.",
  ].join("\n");
}
