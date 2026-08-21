import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PruneBand, ThresholdPair, HandoffThreshold } from "./types.ts";

export type ThresholdInput = number | { enter: number; exit?: number };

export interface ModelOverride {
  prune?: ThresholdInput;
  checkpoint?: ThresholdInput;
  compact?: ThresholdInput;
  handoff?: number | { enter: number };
  reclaimableMin?: number;
}

export interface CompiledModelRule {
  pattern: string;
  re: RegExp;
  override: ModelOverride;
  rank: number;
  prefixLength: number;
}

export interface ContextEngineConfig {
  enabled: boolean;
  auto: { prune: boolean; checkpoint: boolean; compact: boolean };
  handoff: { mode: "suggest" | "auto" };
  thresholds: {
    prune: ThresholdPair;
    checkpoint: ThresholdPair;
    compact: ThresholdPair;
    handoff: HandoffThreshold;
  };
  policy: {
    reclaimableMin: number;
    maxActionsPer10Turns: number;
    adaptiveThresholds: boolean;
  };
  checkpoint: {
    freshMs: number;
    staleTokens: number;
    staleMessages: number;
    model: string | null;
    maxPerSession: number;
    backoffMs: number[];
    maxFailStreak: number;
  };
  prune: {
    bands: PruneBand[];
  };
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
  _compiledModels?: CompiledModelRule[];
  _compiledModelsSource?: Record<string, ModelOverride>;
  _migrationEvents?: Array<{ action: string; [k: string]: unknown }>;
}

export const DEFAULT_CONFIG: ContextEngineConfig = {
  enabled: true,
  auto: { prune: true, checkpoint: true, compact: true },
  handoff: { mode: "suggest" },
  thresholds: {
    prune: { enter: 0.65, exit: 0.55 },
    checkpoint: { enter: 0.80, exit: 0.70 },
    compact: { enter: 0.88, exit: 0.78 },
    handoff: { enter: 0.94 },
  },
  policy: {
    reclaimableMin: 5000,
    maxActionsPer10Turns: 3,
    adaptiveThresholds: true,
  },
  checkpoint: {
    freshMs: 600_000,
    staleTokens: 20_000,
    staleMessages: 30,
    model: null,
    maxPerSession: 20,
    backoffMs: [30_000, 60_000, 120_000],
    maxFailStreak: 3,
  },
  prune: {
    bands: [
      { pressureGte: 0.88, stubMinTokens: 20, foldMaxChars: 1200 },
      { pressureGte: 0.80, stubMinTokens: 30, foldMaxChars: 1600 },
      { pressureGte: 0.0, stubMinTokens: 50, foldMaxChars: 2200 },
    ],
  },
  pressure: { green: 0.55, yellow: 0.7, orange: 0.82, red: 0.9 },
  limits: { oversizedTokens: 1000, recentWindow: 8, stubMinTokens: 50, foldMaxChars: 2200 },
  reserves: { output: 8192, safety: 4096, system: 4000 },
  cooldowns: { pruneMs: 15_000, compactMs: 300_000, checkpointFreshMs: 600_000 },
  models: {
    "qwen*": { prune: { enter: 0.55, exit: 0.45 }, compact: { enter: 0.78, exit: 0.68 } },
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

/** Simple glob → regex ("*" → any, "?" → one char). */
export function globToRe(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Compute pattern specificity: exact match > long prefix > `*` */
export function patternSpecificity(pattern: string): { rank: number; prefixLength: number } {
  if (pattern === "*") return { rank: 1, prefixLength: 0 };
  const firstWild = pattern.search(/[*?]/);
  if (firstWild === -1) {
    return { rank: 3, prefixLength: pattern.length };
  }
  return { rank: 2, prefixLength: firstWild };
}

export function compileModelRules(models: Record<string, ModelOverride>): CompiledModelRule[] {
  const rules: CompiledModelRule[] = [];
  for (const [pattern, override] of Object.entries(models)) {
    const { rank, prefixLength } = patternSpecificity(pattern);
    rules.push({
      pattern,
      re: globToRe(pattern),
      override,
      rank,
      prefixLength,
    });
  }
  // Sort descending by rank > prefixLength > pattern.length
  rules.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.prefixLength !== b.prefixLength) return b.prefixLength - a.prefixLength;
    return b.pattern.length - a.pattern.length;
  });
  return rules;
}

function normalizeThresholdPair(v: unknown, defaultPair: ThresholdPair, defaultExitDelta = 0.1): { pair: ThresholdPair; migrated?: boolean; sanitized?: boolean } {
  if (typeof v === "number" && !Number.isNaN(v) && v >= 0 && v <= 2) {
    return {
      pair: { enter: v, exit: Math.max(0, Number((v - defaultExitDelta).toFixed(4))) },
      migrated: true,
    };
  }
  if (isObj(v)) {
    const enter = typeof v.enter === "number" && !Number.isNaN(v.enter) && v.enter >= 0 && v.enter <= 2 ? v.enter : defaultPair.enter;
    const exit = typeof v.exit === "number" && !Number.isNaN(v.exit) && v.exit >= 0 && v.exit <= 2
      ? v.exit
      : Math.max(0, Number((enter - defaultExitDelta).toFixed(4)));
    const wasSanitized = typeof v.enter !== "number" || (v.exit !== undefined && typeof v.exit !== "number");
    return { pair: { enter, exit }, sanitized: wasSanitized };
  }
  return { pair: { ...defaultPair }, sanitized: true };
}

function normalizeHandoffThreshold(v: unknown, defaultHandoff: HandoffThreshold): { val: HandoffThreshold; migrated?: boolean; sanitized?: boolean } {
  if (typeof v === "number" && !Number.isNaN(v) && v >= 0 && v <= 2) {
    return { val: { enter: v }, migrated: true };
  }
  if (isObj(v) && typeof v.enter === "number" && !Number.isNaN(v.enter) && v.enter >= 0 && v.enter <= 2) {
    return { val: { enter: v.enter } };
  }
  return { val: { ...defaultHandoff }, sanitized: true };
}

/**
 * Sanitize and migrate config into v0.2 schema.
 */
export function sanitizeAndMigrateConfig(rawConfig: unknown): { config: ContextEngineConfig; events: Array<{ action: string; [k: string]: unknown }> } {
  const events: Array<{ action: string; [k: string]: unknown }> = [];
  const merged = deepMerge(DEFAULT_CONFIG, rawConfig) as ContextEngineConfig;

  // Threshold migration / sanitization
  const rawThresh = isObj(rawConfig) && isObj(rawConfig.thresholds) ? (rawConfig.thresholds as Record<string, unknown>) : {};
  const pruneNorm = normalizeThresholdPair(rawThresh.prune, DEFAULT_CONFIG.thresholds.prune);
  const checkpointNorm = normalizeThresholdPair(rawThresh.checkpoint, DEFAULT_CONFIG.thresholds.checkpoint);
  const compactNorm = normalizeThresholdPair(rawThresh.compact, DEFAULT_CONFIG.thresholds.compact);
  const handoffNorm = normalizeHandoffThreshold(rawThresh.handoff, DEFAULT_CONFIG.thresholds.handoff);

  merged.thresholds = {
    prune: pruneNorm.pair,
    checkpoint: checkpointNorm.pair,
    compact: compactNorm.pair,
    handoff: handoffNorm.val,
  };

  if (pruneNorm.migrated || checkpointNorm.migrated || compactNorm.migrated || handoffNorm.migrated) {
    events.push({ action: "config_migrated", from: "v0.1_flat_thresholds", thresholds: merged.thresholds });
  }

  if (pruneNorm.sanitized || checkpointNorm.sanitized || compactNorm.sanitized || handoffNorm.sanitized) {
    events.push({ action: "config_sanitized", reason: "invalid_threshold_value" });
  }

  // Policy sanitization
  if (typeof merged.policy?.reclaimableMin !== "number" || merged.policy.reclaimableMin < 0) {
    events.push({ action: "config_sanitized", field: "policy.reclaimableMin", fallback: DEFAULT_CONFIG.policy.reclaimableMin });
    merged.policy = { ...merged.policy, reclaimableMin: DEFAULT_CONFIG.policy.reclaimableMin };
  }
  if (typeof merged.policy?.maxActionsPer10Turns !== "number" || merged.policy.maxActionsPer10Turns < 1) {
    events.push({ action: "config_sanitized", field: "policy.maxActionsPer10Turns", fallback: DEFAULT_CONFIG.policy.maxActionsPer10Turns });
    merged.policy = { ...merged.policy, maxActionsPer10Turns: DEFAULT_CONFIG.policy.maxActionsPer10Turns };
  }

  // Checkpoint sanitization
  if (!Array.isArray(merged.checkpoint?.backoffMs) || !merged.checkpoint.backoffMs.every((x) => typeof x === "number" && x > 0)) {
    events.push({ action: "config_sanitized", field: "checkpoint.backoffMs", fallback: DEFAULT_CONFIG.checkpoint.backoffMs });
    merged.checkpoint = { ...merged.checkpoint, backoffMs: [...DEFAULT_CONFIG.checkpoint.backoffMs] };
  }
  if (typeof merged.checkpoint?.maxFailStreak !== "number" || merged.checkpoint.maxFailStreak < 1) {
    events.push({ action: "config_sanitized", field: "checkpoint.maxFailStreak", fallback: DEFAULT_CONFIG.checkpoint.maxFailStreak });
    merged.checkpoint = { ...merged.checkpoint, maxFailStreak: DEFAULT_CONFIG.checkpoint.maxFailStreak };
  }
  if (typeof merged.checkpoint?.maxPerSession !== "number" || merged.checkpoint.maxPerSession < 1) {
    events.push({ action: "config_sanitized", field: "checkpoint.maxPerSession", fallback: DEFAULT_CONFIG.checkpoint.maxPerSession });
    merged.checkpoint = { ...merged.checkpoint, maxPerSession: DEFAULT_CONFIG.checkpoint.maxPerSession };
  }

  // Prune bands sanitization
  if (!Array.isArray(merged.prune?.bands) || merged.prune.bands.length === 0) {
    events.push({ action: "config_sanitized", field: "prune.bands", fallback: DEFAULT_CONFIG.prune.bands });
    merged.prune = { ...merged.prune, bands: [...DEFAULT_CONFIG.prune.bands] };
  }

  // Precompile models
  merged._compiledModels = compileModelRules(merged.models ?? {});
  merged._compiledModelsSource = merged.models;
  merged._migrationEvents = events;

  return { config: merged, events };
}

/**
 * Load config for a cwd. Never throws: bad config falls back to defaults
 * (fail-open, §36).
 */
export function loadConfig(cwd?: string): ContextEngineConfig {
  let raw: Record<string, unknown> = {};
  const globalFile = readJsonFile(globalConfigPath());
  if (globalFile) raw = deepMerge(raw, globalFile);
  if (cwd) {
    const projectFile = readJsonFile(projectConfigPath(cwd));
    if (projectFile) raw = deepMerge(raw, projectFile);
  }
  const envPath = process.env.PI_CONTEXT_ENGINE_CONFIG;
  if (envPath) {
    const envFile = readJsonFile(envPath);
    if (envFile) raw = deepMerge(raw, envFile);
  }
  const { config } = sanitizeAndMigrateConfig(raw);
  return config;
}

/**
 * Resolve thresholds for the active model (spec §31, §10.4).
 * Patterns match "provider/id". Rules are applied in specificity order.
 */
export function resolveThresholds(
  config: ContextEngineConfig,
  model?: { provider: string; id: string } | null,
): ContextEngineConfig["thresholds"] {
  const t: ContextEngineConfig["thresholds"] = {
    prune: { ...config.thresholds.prune },
    checkpoint: { ...config.thresholds.checkpoint },
    compact: { ...config.thresholds.compact },
    handoff: { ...config.thresholds.handoff },
  };
  if (!model) return t;

  const full = `${model.provider}/${model.id}`;
  const compiled =
    config._compiledModels && config._compiledModelsSource === config.models
      ? config._compiledModels
      : compileModelRules(config.models ?? {});

  // compiled is sorted most-specific first; apply in REVERSE so that the
  // most specific matching rule lands last and wins (§10.4).
  for (const rule of [...compiled].reverse()) {
    if (rule.pattern === full || rule.re.test(full)) {
      const ov = rule.override;
      if (ov.prune !== undefined) {
        t.prune = normalizeThresholdPair(ov.prune, t.prune).pair;
      }
      if (ov.checkpoint !== undefined) {
        t.checkpoint = normalizeThresholdPair(ov.checkpoint, t.checkpoint).pair;
      }
      if (ov.compact !== undefined) {
        t.compact = normalizeThresholdPair(ov.compact, t.compact).pair;
      }
      if (ov.handoff !== undefined) {
        t.handoff = normalizeHandoffThreshold(ov.handoff, t.handoff).val;
      }
    }
  }
  return t;
}

/**
 * Resolve `policy.reclaimableMin` for the active model (spec §5.2, D6):
 * model-specific overrides beat the global policy value; most specific
 * matching pattern wins (same cascade as resolveThresholds).
 */
export function resolveReclaimableMin(
  config: ContextEngineConfig,
  model?: { provider: string; id: string } | null,
): number {
  let value = config.policy?.reclaimableMin ?? 5000;
  if (!model) return value;

  const full = `${model.provider}/${model.id}`;
  const compiled =
    config._compiledModels && config._compiledModelsSource === config.models
      ? config._compiledModels
      : compileModelRules(config.models ?? {});

  for (const rule of [...compiled].reverse()) {
    if (
      (rule.pattern === full || rule.re.test(full)) &&
      typeof rule.override.reclaimableMin === "number" &&
      !Number.isNaN(rule.override.reclaimableMin) &&
      rule.override.reclaimableMin >= 0
    ) {
      value = rule.override.reclaimableMin;
    }
  }
  return value;
}
