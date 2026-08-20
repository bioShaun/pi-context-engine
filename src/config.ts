/**
 * Configuration (spec §26, §31).
 *
 * Resolution order (later wins, deep-merged):
 *   1. built-in defaults
 *   2. global:   ~/.pi/context-engine/config.json
 *   3. project:  <cwd>/.pi/context-engine.json
 *   4. env PI_CONTEXT_ENGINE_CONFIG — absolute path to a JSON file (tests/CI)
 *
 * `enabled: false` or `auto.*: false` disable the matching behavior
 * (spec §46: auto prune can be turned off, compact can be turned off).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelOverride {
  prune?: number;
  checkpoint?: number;
  compact?: number;
  handoff?: number;
}

export interface ContextEngineConfig {
  enabled: boolean;
  auto: { prune: boolean; checkpoint: boolean; compact: boolean };
  handoff: { mode: "suggest" | "auto" };
  thresholds: { prune: number; checkpoint: number; compact: number; handoff: number };
  /** Pressure band labels for reports (spec §9). */
  pressure: { green: number; yellow: number; orange: number; red: number };
  limits: {
    /** tool results at/above this many estimated tokens are "oversized". */
    oversizedTokens: number;
    /** last N toolish results count as "recent". */
    recentWindow: number;
    /** only stub out results larger than this (protects small items). */
    stubMinTokens: number;
    /** max chars in a folded tool output. */
    foldMaxChars: number;
  };
  reserves: {
    /** tokens reserved for model output. */
    output: number;
    /** extra safety margin. */
    safety: number;
    /** system-prompt estimate when pi usage is unavailable. */
    system: number;
  };
  cooldowns: {
    /** min ms between automatic prune passes. */
    pruneMs: number;
    /** min ms between compactions we trigger. */
    compactMs: number;
    /** a checkpoint younger than this is "fresh". */
    checkpointFreshMs: number;
  };
  /** model pattern ("provider/id" globs, "*" wildcard) → threshold overrides. */
  models: Record<string, ModelOverride>;
  /** base dir for session-local state. Default: ~/.pi/context-engine */
  stateDir: string;
}

export const DEFAULT_CONFIG: ContextEngineConfig = {
  enabled: true,
  auto: { prune: true, checkpoint: true, compact: true },
  handoff: { mode: "suggest" },
  thresholds: { prune: 0.65, checkpoint: 0.8, compact: 0.88, handoff: 0.94 },
  pressure: { green: 0.55, yellow: 0.7, orange: 0.82, red: 0.9 },
  limits: { oversizedTokens: 1000, recentWindow: 8, stubMinTokens: 50, foldMaxChars: 2200 },
  reserves: { output: 8192, safety: 4096, system: 4000 },
  cooldowns: { pruneMs: 15_000, compactMs: 300_000, checkpointFreshMs: 600_000 },
  models: {
    "qwen*": { prune: 0.55, compact: 0.78 },
  },
  stateDir: join(homedir(), ".pi", "context-engine"),
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) {
    return (patch === undefined ? base : (patch as T)) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj((base as Record<string, unknown>)[k])) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function globalConfigPath(): string {
  return join(homedir(), ".pi", "context-engine", "config.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "context-engine.json");
}

/**
 * Load config for a cwd. Never throws: bad config falls back to defaults
 * (fail-open, §36).
 */
export function loadConfig(cwd?: string): ContextEngineConfig {
  let config = DEFAULT_CONFIG;
  const globalFile = readJsonFile(globalConfigPath());
  if (globalFile) config = deepMerge(config, globalFile);
  if (cwd) {
    const projectFile = readJsonFile(projectConfigPath(cwd));
    if (projectFile) config = deepMerge(config, projectFile);
  }
  const envPath = process.env.PI_CONTEXT_ENGINE_CONFIG;
  if (envPath) {
    const envFile = readJsonFile(envPath);
    if (envFile) config = deepMerge(config, envFile);
  }
  return config;
}

/** Simple glob → regex ("*" → any, "?" → one char). */
function globToRe(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Resolve thresholds for the active model (spec §31).
 * Patterns match "provider/id".
 */
export function resolveThresholds(
  config: ContextEngineConfig,
  model?: { provider: string; id: string } | null,
): ContextEngineConfig["thresholds"] {
  const t = { ...config.thresholds };
  if (model) {
    const full = `${model.provider}/${model.id}`;
    for (const [pattern, ov] of Object.entries(config.models)) {
      if (pattern === full || globToRe(pattern).test(full)) {
        if (ov.prune !== undefined) t.prune = ov.prune;
        if (ov.checkpoint !== undefined) t.checkpoint = ov.checkpoint;
        if (ov.compact !== undefined) t.compact = ov.compact;
        if (ov.handoff !== undefined) t.handoff = ov.handoff;
      }
    }
  }
  return t;
}
