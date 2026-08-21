/**
 * Core type definitions for pi-context-engine.
 *
 * These are intentionally minimal *structural* types. They match the shapes
 * of Pi's AgentMessage variants (user / assistant / toolResult /
 * bashExecution / custom / branchSummary / compactionSummary) without
 * importing the pi packages at runtime, so the pure-logic modules can be
 * unit tested with plain `node --test`.
 */

/** A message in the effective context, in its raw (pre-LLM-conversion) shape. */
export interface AnyMessage {
  role: string;
  timestamp?: number;
  /** user: string | (TextPart|ImagePart)[] ; assistant/toolResult: block[] ; */
  content?: unknown;
  /** toolResult only */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** tool result details (bash/read/...), may carry engine markers */
  details?: unknown;
  /** bashExecution */
  command?: string;
  output?: string;
  exitCode?: number | null;
  cancelled?: boolean;
  /** custom messages */
  customType?: string;
  display?: boolean;
  /** compactionSummary */
  summary?: string;
  tokensBefore?: number;
  /** assistant */
  usage?: unknown;
  stopReason?: string;
  [key: string]: unknown;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Engine identity marker stored in tool-result `details` (idempotency, §34). */
export const ENGINE_ID = "pi-context-engine";

/** Marker in stub content so visible text is recognizable (not relied on). */
export const STUB_PREFIX = `[${ENGINE_ID}]`;

/**
 * A resolved tool call (assistant toolCall block), correlated by toolCallId.
 * Concurrency-safe: built from explicit ids, never from position (§35).
 */
export interface ResolvedToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Classification (spec §6, §7, §8)
// ---------------------------------------------------------------------------

export type ContextClass = "critical" | "working" | "stale" | "disposable";

export type ContextItemType =
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "bash"
  | "custom"
  | "summary";

/** One classified context item (spec §6, with implementation extras). */
export interface ContextItem {
  /** Index of the message in the effective message array. */
  messageIndex: number;
  /** Stable synthetic id (deterministic hash) for this message. */
  id: string;
  type: ContextItemType;
  /** Tool name for tool results, e.g. "bash" | "read" | "grep". */
  source?: string;
  createdAt: number;
  estimatedTokens: number;
  importance: number;
  class: ContextClass;
  tags: string[];
  relatedFiles?: string[];
  /** If this item was superseded, the messageIndex of the newer one. */
  supersededBy?: number;
  pinned: boolean;
  /** Why it got this class (audit + UI). */
  reason?: string;
  /** True when this message is already an engine stub (idempotency). */
  engineStub?: boolean;
}

// ---------------------------------------------------------------------------
// Analysis (spec §41)
// ---------------------------------------------------------------------------

export interface ContextAnalysis {
  totalTokens: number;
  usableTokens: number;
  pressure: number;

  criticalTokens: number;
  workingTokens: number;
  staleTokens: number;
  disposableTokens: number;

  /** (critical+working) / total — signal ratio (spec §20). */
  quality: number;

  /** Tokens that a clean pass would reclaim. */
  reclaimableTokens: number;

  items: ContextItem[];
}

// ---------------------------------------------------------------------------
// Pruning (spec §41)
// ---------------------------------------------------------------------------

export type PruneActionKind = "fold" | "stub" | "drop" | "keep";

export interface PruneAction {
  kind: PruneActionKind;
  messageIndex: number;
  messageId: string;
  tool?: string;
  originalTokens: number;
  replacementTokens: number;
  reason: string;
  tags?: string[];
  /** For folds: the folded replacement text (for audit/UI). */
  preview?: string;
}

export interface PruneResult {
  context: AnyMessage[];
  removedTokens: number;
  preservedTokens: number;
  actions: PruneAction[];
}

export interface PruneOptions {
  stubMinTokens: number;
  foldMaxChars: number;
  /** "auto" = policy-driven; "manual" = /context clean (more aggressive). */
  mode: "auto" | "manual";
}

export interface PruneBand {
  pressureGte: number;
  stubMinTokens: number;
  foldMaxChars: number;
}

// ---------------------------------------------------------------------------
// Policy (spec §43)
// ---------------------------------------------------------------------------

export type PolicyAction = "none" | "prune" | "checkpoint" | "compact" | "handoff";

export interface ContextPolicyDecision {
  action: PolicyAction;
  reason: string;
  pressureBefore: number;
  estimatedPressureAfter?: number;
}

export interface ThresholdPair {
  enter: number;
  exit: number;
}

export interface HandoffThreshold {
  enter: number;
}

export interface AutoPlan {
  prune: boolean;
  pruneOpts: PruneOptions;
  checkpoint: boolean;
  compact: boolean;
  handoffSuggest: boolean;
  reason: string;
  decision: ContextPolicyDecision;
  throttledActions?: Array<"prune" | "checkpoint" | "compact">;
}

export interface EngineState {
  compactionCount: number;
  checkpointCount: number;
  handoffCount: number;
  lastPruneAt: number;
  lastCheckpointAt: number;
  lastCompactAt: number;
  // v0.2 state
  lastCheckpointAttemptAt?: number;
  checkpointFailStreak?: number;
  checkpointCircuitBroken?: boolean;
  checkpointDisabledReason?: string;
  tokensAtLastCheckpoint?: number;
  messagesAtLastCheckpoint?: number;
  lastCompactPressureBefore?: number;
  consecutiveIneffectiveCompacts?: number;
  consecutiveIneffectivePrunes?: number;
  adaptivePruneEnterDelta?: number;
  adaptiveCompactEnterDelta?: number;
  /** Sliding action window for §6 rate limits; `turn` enables per-10-TURN counting. */
  actionHistory?: Array<{
    action: "prune" | "checkpoint" | "compact";
    timestamp: number;
    turn?: number;
  }>;
  /** Context-event counter (§6 "per 10 turns" window). */
  turnCount?: number;
  /** §6 hysteresis latch: true while the action's band is active. Reset only
   *  after 2 consecutive turns with pressure < exit. */
  bandActive?: { prune: boolean; checkpoint: boolean; compact: boolean };
  /** Consecutive turns with pressure < exit, per action (§6). */
  lowPressureStreak?: { prune: number; checkpoint: number; compact: number };
}

// ---------------------------------------------------------------------------
// Meter (spec §4)
// ---------------------------------------------------------------------------

export interface Meter {
  tokens(msg: AnyMessage): number;
  total(messages: readonly AnyMessage[]): number;
  recompute(a: ContextAnalysis, r: PruneResult): ContextAnalysis;
  calibrate(reported: number): void;
}

// ---------------------------------------------------------------------------
// Pins (spec §15, §16)
// ---------------------------------------------------------------------------

export type PinType = "constraint" | "requirement" | "file" | "command" | "note";

export interface Pin {
  id: string;
  type: PinType;
  content: string;
  createdAt: number;
  sourceMessageId?: string;
  expires: "session" | "task" | "manual";
  active: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoint (spec §13)
// ---------------------------------------------------------------------------

export interface CheckpointDecision {
  decision: string;
  reason: string;
  status: "active" | "superseded" | "abandoned";
}

export interface Checkpoint {
  version: 1;
  created_at: string;
  task: {
    goal: string;
    phase: string;
    status: string;
  };
  requirements: string[];
  constraints: string[];
  decisions: CheckpointDecision[];
  files: {
    inspected: string[];
    modified: string[];
    created: string[];
    deleted: string[];
  };
  verification: {
    passed: string[];
    failed: string[];
    pending: string[];
  };
  issues: Array<{ description: string; status: "open" | "resolved" | "blocked" }>;
  next_actions: string[];
  /** Engine metadata (not part of the LLM-facing schema). */
  meta?: {
    session_id: string;
    tokens_before?: number;
    source: "manual" | "auto";
  };
}

// ---------------------------------------------------------------------------
// Audit (spec §29)
// ---------------------------------------------------------------------------

export interface AuditEvent {
  time: string;
  action: string;
  [key: string]: unknown;
}
