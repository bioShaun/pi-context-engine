/**
 * `context_search` — the Pi tool (pi-native-recall spec §9–11).
 *
 * This is the only Pi-coupled module in the recall path. Everything it calls
 * (source.ts / search.ts / recovery.ts / render in search.ts) is pure and
 * unit-testable without Pi.
 *
 * Contract (spec §10, §11):
 *  - Registered only when `search.enabled` (checked on Pi init from the
 *    global config; re-checked per execution from the session config).
 *  - Execution reads the current session branch (L0), builds documents, runs
 *    the deterministic lexical search, and renders within a token budget.
 *  - Supports AbortSignal: on abort, returns whatever was collected and
 *    marks it cancelled.
 *  - Fail-open: any error returns an error text; Pi is never blocked.
 *  - Audit: `context_search` (raw query NEVER — hash + length only, §16),
 *    plus `search_coverage_partial` when coverage degrades.
 */

import { Type } from "typebox";
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { contentFingerprint, estimateTextTokens } from "../observer/token-estimator.ts";
import type { ContextEngineConfig } from "../config.ts";
import type { Auditor } from "../audit.ts";
import type { SessionStore } from "../checkpoint/store.ts";
import { buildSearchDocuments, type BranchEntryLike, type PruneLogRecord } from "./source.ts";
import {
  parseSearchQuery,
  searchDocuments,
  renderSearchResult,
  type ParsedQuery,
  type RenderSearchOutput,
} from "./search.ts";

/**
 * The engine state the tool needs. Structural type so this module does not
 * import index.ts (no cycle).
 */
export interface ContextSearchEngine {
  sessionId: string;
  config: ContextEngineConfig;
  auditor: Auditor;
  store: SessionStore;
}

/** The session-manager surface runContextSearch needs (both tool and command ctx). */
export interface SearchSessionManager {
  getSessionId(): string | undefined;
  getBranch(): unknown[];
}

export interface ContextSearchParamsInput {
  query: string;
  limit?: number;
  tool?: string;
  scope?: "pruned" | "all";
}

export type ContextSearchRun =
  | { ok: true; rendered: RenderSearchOutput }
  | { ok: false; error: string };

/**
 * Shared search pipeline (spec §11.1: the `/context search` command and the
 * `context_search` tool use EXACTLY the same parser, search, and renderer).
 * Pure orchestration; all heavy lifting is in source.ts / search.ts.
 */
export async function runContextSearch(
  engine: ContextSearchEngine | null,
  sm: SearchSessionManager | undefined,
  params: ContextSearchParamsInput,
  signal?: AbortSignal,
): Promise<ContextSearchRun> {
  let sessionId: string | undefined;
  try {
    sessionId = sm?.getSessionId();
  } catch {
    return { ok: false, error: "context_search: unavailable (session manager error)." };
  }
  if (!engine || !sessionId || engine.sessionId !== sessionId) {
    return { ok: false, error: "context_search: engine not attached to this session yet." };
  }
  if (!engine.config.search.enabled) {
    return { ok: false, error: "context_search is disabled by configuration (search.enabled=false)." };
  }

  const t0 = Date.now();

  // 1) parse query
  const parsed = parseSearchQuery(params.query, { tool: params.tool, file: undefined });
  if (!parsed.ok) return { ok: false, error: `context_search: ${parsed.error}` };
  const query = parsed as ParsedQuery;

  // 2) read branch (L0) — getBranch is the full path incl. pre-compaction
  let entries: unknown[];
  try {
    entries = sm!.getBranch() as unknown[];
  } catch {
    return { ok: false, error: "context_search: could not read session branch." };
  }
  const branchEntries = entries as BranchEntryLike[];

  // 3) prune-log records (for prune metadata)
  let pruneLog: PruneLogRecord[] = [];
  try {
    pruneLog = (engine.store.readJsonl("prune-log") ?? []) as PruneLogRecord[];
  } catch {
    pruneLog = []; // fail-open: no metadata, never block
  }

  // 4) build documents + prune metadata + coverage
  let src;
  try {
    src = buildSearchDocuments(branchEntries, engine.sessionId, pruneLog);
  } catch {
    return { ok: false, error: "context_search: failed to build search documents." };
  }

  // 5) scope filtering (with degradation per spec §11.1)
  const effectiveScope0: "pruned" | "all" = params.scope ?? engine.config.search.defaultScope;
  let effectiveScope: "pruned" | "all" = effectiveScope0;
  let docs = src.docs;
  const pruneMetaNote = src.pruneMetadataUnavailable;
  if (effectiveScope === "pruned") {
    if (pruneMetaNote) {
      // metadata unreliable → degrade to all with a note (§11.1)
      effectiveScope = "all";
    } else {
      docs = src.docs.filter((d) => d.prune);
    }
  }

  // 6) search (abort-aware)
  let result;
  try {
    result = searchDocuments({ query, docs, isAborted: () => signal?.aborted ?? false });
  } catch {
    return { ok: false, error: "context_search: search failed unexpectedly." };
  }

  // 7) render within budget
  const limit = Math.min(
    params.limit ?? engine.config.search.defaultLimit,
    engine.config.search.maxLimit,
  );
  const rendered = renderSearchResult({
    query,
    result,
    docs,
    scope: effectiveScope,
    effectiveScope,
    pruneMetadataUnavailable: pruneMetaNote,
    partialCoverage: src.partialCoverage,
    ms: Date.now() - t0,
    limit,
    maxResultTokens: engine.config.search.maxResultTokens,
    maxSnippetChars: engine.config.search.maxSnippetChars,
  });

  // 8) audit (raw query never — hash + length only, spec §16)
  try {
    engine.auditor.event("context_search", {
      query_hash: contentFingerprint(params.query),
      query_len: params.query.length,
      tool: query.tool ?? null,
      file: query.file ? "set" : null,
      scope: effectiveScope,
      scanned: rendered.details.scanned,
      hits: rendered.details.hits,
      ms: rendered.details.ms,
      coverage: rendered.details.coverage,
      cancelled: rendered.details.cancelled,
    });
    if (rendered.details.coverage === "partial") {
      engine.auditor.event("search_coverage_partial", {
        reason: "compaction without reachable pre-compaction L0",
      });
    }
  } catch {
    // audit failure never blocks the tool
  }

  return { ok: true, rendered };
}

/** Token estimate of the rendered result (for the context_search_sent audit). */
export function renderedTokens(rendered: RenderSearchOutput): number {
  return estimateTextTokens(rendered.text);
}

export interface ContextSearchParams {
  query: string;
  limit?: number;
  tool?: string;
  scope?: "pruned" | "all";
}

const PARAMS = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 500,
    description:
      'Search text. Supports tool:<name>, file:<path>, and "quoted phrases". ' +
      "Example: tool:bash file:src/app.ts \"Error: ENOENT\"",
  }),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
      description: "Max results (default from config, hard cap 50).",
    }),
  ),
  tool: Type.Optional(
    Type.String({ description: 'Only this tool (e.g. "bash", "read", "grep").' }),
  ),
  scope: Type.Optional(
    Type.Union(
      [Type.Literal("pruned"), Type.Literal("all")],
      {
        description:
          '"pruned" = only tool outputs currently stubbed/folded in context; "all" = every L0 tool output in the branch.',
      },
    ),
  ),
});

const DESCRIPTION =
  "Search this session's original tool outputs (L0) — command output, file reads, grep results — " +
  "including content that was pruned from the visible context (stubs/folds). " +
  "Use it before re-running a command, re-reading a file, or re-running a search: " +
  "the original output is often still in the session. " +
  "Query grammar: tool:<name> and file:<path> filters, double-quoted phrases (AND), " +
  "other tokens are AND-combined; CJK matches by bigram. " +
  "scope=pruned limits to outputs currently replaced by a stub/fold; scope=all searches everything. " +
  "Results include line-numbered snippets of the original output plus a recovery id (r:xxxxxx).";

/**
 * Create the `context_search` tool definition bound to an engine provider.
 */
export function createContextSearchTool(
  engineProvider: () => ContextSearchEngine | null,
): ToolDefinition<typeof PARAMS, Record<string, unknown>> {
  return {
    name: "context_search",
    label: "Context Search",
    description: DESCRIPTION,
    promptSnippet:
      "context_search — recall original tool output (bash/read/grep/...) from this session, including pruned (stubbed/folded) content, before re-running commands or re-reading files.",
    promptGuidelines: [
      "Before re-running a command, re-reading a file, or re-running a search, call context_search first (scope=pruned, then all) — the original output is usually still in the session.",
      "Include a specific error code, file path, command fragment, or unique term in the query.",
      "Do not browse all history for possibly-useful output; search for something specific, and only re-run the tool when the search has no results.",
    ],
    parameters: PARAMS,
    executionMode: "parallel",
    async execute(
      _toolCallId: string,
      params: { query: string; limit?: number; tool?: string; scope?: "pruned" | "all" },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const err = (text: string): AgentToolResult<Record<string, unknown>> => ({
        content: [{ type: "text", text }],
        details: { error: text },
      });

      const run = await runContextSearch(engineProvider(), ctx.sessionManager, params, signal);
      if (!run.ok) return err(run.error);
      return {
        content: [{ type: "text", text: run.rendered.text }],
        details: run.rendered.details,
      };
    },
  };
}
