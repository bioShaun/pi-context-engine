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
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!isStr(x)) {
      errors.push(`${field}[${i}] must be a string`);
      continue;
    }
    out.push(x);
  }
  return out;
}

function enumValue(v: unknown, allowed: string[], field: string, errors: string[]): string {
  if (v === undefined) return allowed[0]; // absent optional → default
  if (!isStr(v) || !allowed.includes(v)) {
    errors.push(`${field} must be one of ${allowed.join(" | ")}`);
    return allowed[0];
  }
  return v;
}

function decisionArray(v: unknown, field: string, errors: string[]): CheckpointDecision[] {
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  const out: CheckpointDecision[] = [];
  for (let i = 0; i < v.length; i++) {
    const d = v[i];
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      errors.push(`${field}[${i}] must be an object`);
      continue;
    }
    const o = d as Record<string, unknown>;
    if (!isStr(o.decision) || !o.decision.trim()) {
      errors.push(`${field}[${i}].decision must be a non-empty string`);
      continue;
    }
    if (o.reason !== undefined && !isStr(o.reason)) {
      errors.push(`${field}[${i}].reason must be a string`);
    }
    out.push({
      decision: o.decision.trim(),
      reason: isStr(o.reason) ? o.reason : "",
      status: enumValue(o.status, ["active", "superseded", "abandoned"], `${field}[${i}].status`, errors) as CheckpointDecision["status"],
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

  if (o.version !== undefined && o.version !== 1) {
    errors.push(`unsupported version ${JSON.stringify(o.version)} (expected 1)`);
  }

  if (o.created_at !== undefined && (!isStr(o.created_at) || Number.isNaN(Date.parse(o.created_at)))) {
    errors.push("created_at must be an ISO-8601 timestamp string");
  }

  const taskRaw = o.task;
  if (!taskRaw || typeof taskRaw !== "object" || Array.isArray(taskRaw)) {
    errors.push("task must be an object");
  }
  const task = (taskRaw ?? {}) as Record<string, unknown>;
  const goal = isStr(task.goal) ? task.goal.trim() : "";
  if (!goal) errors.push("task.goal is required and must be a non-empty string");
  if (task.phase !== undefined && !isStr(task.phase)) errors.push("task.phase must be a string");
  const taskStatus = enumValue(task.status, ["in_progress", "blocked", "done"], "task.status", errors);

  const files = (o.files ?? {}) as Record<string, unknown>;
  const verification = (o.verification ?? {}) as Record<string, unknown>;
  const issuesRaw = Array.isArray(o.issues) ? o.issues : [];
  if (o.issues !== undefined && !Array.isArray(o.issues))
    errors.push("issues must be an array");

  type Issue = { description: string; status: "open" | "resolved" | "blocked" };
  const issues: Issue[] = [];
  for (let i = 0; i < issuesRaw.length; i++) {
    const it = issuesRaw[i];
    if (!it || typeof it !== "object" || Array.isArray(it)) {
      errors.push(`issues[${i}] must be an object`);
      continue;
    }
    const r = it as Record<string, unknown>;
    if (!isStr(r.description) || !r.description.trim()) {
      errors.push(`issues[${i}].description must be a non-empty string`);
      continue;
    }
    issues.push({
      description: r.description.trim(),
      status: enumValue(r.status, ["open", "resolved", "blocked"], `issues[${i}].status`, errors) as Issue["status"],
    });
  }

  const checkpoint: Checkpoint = {
    version: 1,
    created_at: isStr(o.created_at) ? o.created_at : new Date().toISOString(),
    task: {
      goal,
      phase: isStr(task.phase) && task.phase.trim() ? task.phase.trim() : "in_progress",
      status: taskStatus,
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
