/**
 * Context recall search (pi-native-recall spec §9).
 *
 * Pure, deterministic, lexical. No embedding model, no new runtime
 * dependencies (§2). Query grammar (§9.1):
 *   - `tool:<name>` and `file:<path>` structured filters (case-insensitive)
 *   - double-quoted phrases (AND)
 *   - other tokens: AND; latin words are exact substring terms; CJK is
 *     unigram + bigram (at least one bigram must hit)
 *   - stopwords (en/zh) are ignored
 *   - NFKC normalization; case-insensitive for latin
 *
 * Scoring (spec §9.3): exact phrase > error code / path / command /
 * distinct content terms > tool filter > recency, with caps so a single
 * repeated token cannot dominate.
 *
 * This module never writes, never throws on bad data, and is unit-testable
 * with plain objects.
 */

import type { SearchDocument } from "../types.ts";
import { estimateTextTokens } from "../observer/token-estimator.ts";
import { redactSecrets, stripControlChars, collapseWhitespace } from "../pruning/stub-summary.ts";

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "in", "on", "at",
  "for", "to", "of", "and", "or", "not", "no", "it", "its", "with", "this",
  "that", "from", "by", "as", "do", "does", "did", "how", "what", "when",
  "的", "了", "是", "在", "和", "与", "或", "也", "都", "就", "把", "被", "让",
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN_DIGIT_RE = /[a-z0-9]/;

export function normalizeText(s: string): string {
  return (s ?? "").normalize("NFKC").toLowerCase();
}

export interface ParsedQuery {
  ok: true;
  raw: string;
  /** normalized, filters/quotes stripped, whitespace collapsed. */
  norm: string;
  /** latin terms (stopwords removed). */
  terms: string[];
  /** CJK bigrams (unigram when the run is a single char). */
  cjk: string[];
  /** quoted phrases, normalized. */
  phrases: string[];
  tool?: string;
  file?: string;
}

export type QueryParseResult = ParsedQuery | { ok: false; error: string };

function cjkGrams(run: string): string[] {
  const chars = [...run];
  if (chars.length === 1) return [chars[0]];
  const set = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]);
  return [...set];
}

export function parseSearchQuery(
  raw: string,
  opts?: { tool?: string; file?: string },
): QueryParseResult {
  const original = (raw ?? "").trim();
  if (!original) return { ok: false, error: "query is empty" };
  if (original.length > 500) return { ok: false, error: "query too long (max 500 chars)" };

  let tool = opts?.tool ? opts.tool.toLowerCase() : undefined;
  let file = opts?.file;
  let text = original;

  // structured filters (spec §9.1)
  const toolM = text.match(/\btool:([a-z0-9_-]+)/i);
  if (toolM) {
    tool = toolM[1].toLowerCase();
    text = text.replace(toolM[0], " ");
  }
  const fileM = text.match(/\bfile:(\S+)/i);
  if (fileM) {
    file = fileM[1];
    text = text.replace(fileM[0], " ");
  }

  // quoted phrases
  const phrases: string[] = [];
  text = text.replace(/"([^"]{1,200})"/g, (_m, p: string) => {
    const n = collapseWhitespace(normalizeText(p));
    if (n) phrases.push(n);
    return " ";
  });

  // tokenize the remainder: whitespace-separated parts, then split each part
  // into CJK runs and latin/digit runs (CJK is NOT a separator).
  const terms: string[] = [];
  const cjk: string[] = [];
  for (const part of normalizeText(text).split(/\s+/)) {
    if (!part) continue;
    const runs = part.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+|[a-z0-9_./:-]+/g) ?? [];
    for (const run of runs) {
      if (!run) continue;
      if (CJK_RE.test(run) && !/[a-z0-9]/.test(run)) {
        for (const g of cjkGrams(run)) if (!cjk.includes(g)) cjk.push(g);
      } else if (LATIN_DIGIT_RE.test(run)) {
        const t = run.replace(/^[./:-]+|[./:-]+$/g, "");
        if (t && !STOPWORDS.has(t) && !terms.includes(t)) terms.push(t);
      }
    }
  }

  const norm = collapseWhitespace(normalizeText(text));
  if (terms.length === 0 && cjk.length === 0 && phrases.length === 0) {
    return { ok: false, error: "query has no search terms" };
  }
  return { ok: true, raw: original, norm, terms, cjk, phrases, tool, file };
}

// ---------------------------------------------------------------------------
// Matching + scoring (spec §9.2, §9.3)
// ---------------------------------------------------------------------------

const ERROR_CODE_RE = /^[a-z]{1,10}\d{2,}$/;
const HTTP_CODE_RE = /^\d{3}$/;
const PATH_TERM_RE = /[./\\]/;

export interface Hit {
  /** index into the input docs array. */
  docIndex: number;
  score: number;
  /** 0-based line of the primary match (for snippet). */
  line: number;
  /** the query term used for the snippet (normalized). */
  primary: string;
  matched: {
    phrase: number;
    errorCode: number;
    path: number;
    command: number;
    content: number;
    toolFilter: boolean;
  };
}

interface NormDoc {
  content: string; // normalized, whitespace-collapsed
  lines: string[]; // normalized per-line
  haystack: string; // content + command + argsText (normalized)
  command: string; // normalized
}

function normDoc(d: SearchDocument): NormDoc {
  const content = collapseWhitespace(normalizeText(d.content));
  const rawLines = stripControlChars(d.content).split("\n");
  const lines = rawLines.map((l) => normalizeText(l));
  const command = normalizeText(d.command ?? "");
  const haystack = `${content} ${command} ${normalizeText(d.argsText ?? "")}`;
  return { content, lines, haystack, command };
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < 8) {
    n++;
    i = hay.indexOf(needle, i + Math.max(1, needle.length));
  }
  return n;
}

export interface SearchInput {
  query: ParsedQuery;
  docs: readonly SearchDocument[];
  /** optional: checked between documents; when true the search stops early. */
  isAborted?: () => boolean;
}

export interface SearchResult {
  hits: Hit[]; // sorted per spec §9.3
  scanned: number;
  cancelled: boolean;
}

/**
 * Deterministic lexical search over L0 documents (pure; no I/O).
 *
 * Tie-break (§9.3): score desc → pruned first → newer first → later branch
 * position first.
 */
export function searchDocuments(input: SearchInput): SearchResult {
  const { query, docs, isAborted } = input;
  const hits: Hit[] = [];
  const n = docs.length;

  // Precompute normalized docs once (single pass).
  const normDocs: (NormDoc | undefined)[] = new Array(n);

  for (let i = 0; i < n; i++) {
    if (isAborted?.()) break;
    const d = docs[i];
    const nd = (normDocs[i] = normDoc(d));

    // structural filters
    if (query.tool && d.tool !== query.tool) continue;
    if (query.file) {
      const f = normalizeText(query.file);
      if (!nd.haystack.includes(f) && !nd.haystack.includes(f.split(/[\\/]/).pop() ?? "")) continue;
    }

    // phrase matching (all must hit, in content)
    let phraseTotal = 0;
    let phraseOk = true;
    for (const p of query.phrases) {
      const c = countOccurrences(nd.content, p);
      if (c === 0) {
        phraseOk = false;
        break;
      }
      phraseTotal += Math.min(4, c);
    }
    if (query.phrases.length > 0 && !phraseOk) continue;

    // AND terms (all must hit in haystack)
    const termHit: boolean[] = new Array(query.terms.length).fill(false);
    for (let t = 0; t < query.terms.length; t++) {
      termHit[t] = nd.haystack.includes(query.terms[t]);
    }
    if (query.terms.length > 0 && termHit.some((h) => !h)) continue;

    // CJK: at least one bigram must hit
    if (query.cjk.length > 0) {
      const any = query.cjk.some((g) => nd.haystack.includes(g));
      if (!any) continue;
    }

    // ---- scoring (caps per spec §9.3)
    let score = 0;
    if (query.phrases.length > 0) score += Math.min(4, phraseTotal) * 12;

    let errorCode = 0;
    let path = 0;
    let command = 0;
    let content = 0;
    for (let t = 0; t < query.terms.length; t++) {
      const term = query.terms[t];
      const inContent = nd.content.includes(term) ? 1 : 0;
      const inCommand = nd.command ? nd.command.includes(term) ? 1 : 0 : 0;
      if (inContent > 0) {
        if (ERROR_CODE_RE.test(term) || HTTP_CODE_RE.test(term)) errorCode += 1;
        else if (PATH_TERM_RE.test(term)) path += 1;
      }
      if (inCommand > 0) command += 1;
      if (inContent > 0 || inCommand > 0) content += 1; // distinct term (non-phrase)
    }
    // CJK bigrams in content also count toward the content term budget
    const cjkInContent = query.cjk.filter((g) => nd.content.includes(g)).length;
    if (cjkInContent > 0) content += Math.min(2, cjkInContent);

    score += Math.min(3, errorCode) * 6;
    score += Math.min(3, path) * 5;
    score += Math.min(3, command) * 4;
    score += Math.min(8, content) * 3;
    if (query.tool && d.tool === query.tool) score += 2;
    if (n > 1) score += (i / (n - 1)) * 1.0; // recency bonus (bounded < 1)

    // primary match term for the snippet
    let primary = "";
    for (const term of query.terms) {
      if (ERROR_CODE_RE.test(term) || HTTP_CODE_RE.test(term)) {
        primary = term;
        break;
      }
    }
    if (!primary) for (const term of query.terms) if (PATH_TERM_RE.test(term)) { primary = term; break; }
    if (!primary && query.phrases.length > 0) primary = query.phrases[0];
    if (!primary && query.terms.length > 0) primary = query.terms[0];
    if (!primary) {
      for (const g of query.cjk) {
        if (nd.content.includes(g)) {
          primary = g;
          break;
        }
      }
    }

    // locate the primary line (first line whose normalized text contains it)
    let line = 0;
    if (primary) {
      for (let li = 0; li < nd.lines.length; li++) {
        if (nd.lines[li].includes(primary)) {
          line = li;
          break;
        }
      }
    }

    hits.push({
      docIndex: i,
      score,
      line,
      primary,
      matched: {
        phrase: phraseTotal,
        errorCode,
        path,
        command,
        content,
        toolFilter: Boolean(query.tool && d.tool === query.tool),
      },
    });
  }

  // order: score desc → pruned first → newer first → later position first
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ap = Boolean(docs[a.docIndex]?.prune);
    const bp = Boolean(docs[b.docIndex]?.prune);
    if (ap !== bp) return ap ? -1 : 1;
    const ta = docs[a.docIndex]?.timestamp ?? 0;
    const tb = docs[b.docIndex]?.timestamp ?? 0;
    if (ta !== tb) return tb - ta;
    return b.docIndex - a.docIndex;
  });

  return { hits, scanned: n, cancelled: Boolean(isAborted?.()) };
}

// ---------------------------------------------------------------------------
// Snippets (spec §11.3: ≤ 5 lines / 400 chars / original line numbers)
// ---------------------------------------------------------------------------

export function makeSnippet(
  doc: SearchDocument,
  line: number,
  maxChars: number,
  maxLines: number = 5,
): string {
  const raw = stripControlChars(doc.content);
  const lines = raw.split("\n");
  if (lines.length === 0) return "(empty output)";
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, start + maxLines);
  // keep the window centered-ish when line is near the start
  const windowLines = lines.slice(start, end);
  const rendered: string[] = [];
  let used = 0;
  for (let i = 0; i < windowLines.length; i++) {
    const no = start + i + 1; // 1-based original line number
    let l = windowLines[i];
    if (l.length > 200) l = l.slice(0, 199) + "…";
    const row = `  ${no}: ${l}`;
    if (used + row.length > maxChars) break;
    used += row.length;
    rendered.push(row);
  }
  if (rendered.length === 0) {
    // window line alone exceeds budget: single truncated line, correct number
    let l = windowLines[0] ?? "";
    if (l.length > Math.max(40, maxChars - 12)) l = l.slice(0, Math.max(40, maxChars - 12) - 1) + "…";
    rendered.push(`  ${start + 1}: ${redactSecrets(l)}`);
  } else {
    for (let i = 0; i < rendered.length; i++) rendered[i] = redactSecrets(rendered[i]);
  }
  const omitted = lines.length - windowLines.length + (windowLines.length - rendered.length);
  let out = rendered.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
  if (omitted > 0) out += `\n… (${omitted} more lines)`;
  return out;
}

// ---------------------------------------------------------------------------
// Result rendering (spec §11.3, token budget)
// ---------------------------------------------------------------------------

export interface RenderSearchInput {
  query: ParsedQuery;
  result: SearchResult;
  docs: readonly SearchDocument[];
  scope: "pruned" | "all";
  /** the scope actually searched after degradation. */
  effectiveScope: "pruned" | "all";
  pruneMetadataUnavailable?: boolean;
  partialCoverage?: boolean;
  ms: number;
  limit: number;
  maxResultTokens: number;
  maxSnippetChars: number;
}

export interface RenderSearchOutput {
  text: string;
  details: {
    hits: number;
    scanned: number;
    ms: number;
    scope: string;
    effectiveScope: string;
    coverage: "complete" | "partial";
    cancelled: boolean;
    recoveryIds: string[];
    trimmed: boolean;
  };
}

export function renderSearchResult(input: RenderSearchInput): RenderSearchOutput {
  const { query, result, docs, ms, limit, maxResultTokens, maxSnippetChars } = input;
  const coverage: "complete" | "partial" = input.partialCoverage ? "partial" : "complete";

  if (result.hits.length === 0) {
    const notes: string[] = [];
    if (input.pruneMetadataUnavailable) notes.push("prune metadata unavailable → searched scope=all");
    if (input.partialCoverage) notes.push("history coverage partial (after compaction)");
    const text = [
      `No results for "${query.raw}".`,
      `Scanned ${result.scanned} L0 documents (scope: ${input.effectiveScope}, coverage: ${coverage}).`,
      ...notes,
      `Normalized query: "${query.norm || "(empty)"}"`,
      `Tip: shorten the query; use tool:<name> / file:<path> filters; or scope "all" instead of "pruned".`,
    ].join("\n");
    return {
      text,
      details: {
        hits: 0,
        scanned: result.scanned,
        ms,
        scope: input.scope,
        effectiveScope: input.effectiveScope,
        coverage,
        cancelled: result.cancelled,
        recoveryIds: [],
        trimmed: false,
      },
    };
  }

  const recoveryIdOf = (d: SearchDocument) => {
    const m = (d.recovery?.contentHash ?? "").match(/:([0-9a-f]{3,})$/);
    return `r:${(m ? m[1] : "000000").slice(0, 6)}`;
  };

  let trimmed = false;
  // Progressive budget (spec §11.3): shrink snippets, then drop hits, keeping
  // at least one. Each step never exceeds the configured maxSnippetChars.
  const snippetLadder = [
    maxSnippetChars,
    Math.min(maxSnippetChars, Math.max(60, Math.floor(maxSnippetChars / 2))),
    Math.min(maxSnippetChars, 120),
  ];
  for (const snippetBudget of snippetLadder) {
    const blocks: string[] = [];
    let totalTokens = 0;
    let kept = 0;
    const header =
      `context_search: "${query.raw}" — ${Math.min(result.hits.length, limit)} hit(s) · ` +
      `scanned ${result.scanned} L0 docs · ${ms}ms\n` +
      `scope: ${input.effectiveScope} (coverage: ${coverage})` +
      (input.pruneMetadataUnavailable ? " · prune metadata unavailable" : "") +
      (result.cancelled ? " · [cancelled]" : "");
    blocks.push(header);
    totalTokens += estimateTextTokens(header);

    for (const h of result.hits) {
      if (kept >= limit) break;
      const d = docs[h.docIndex];
      const head =
        `${kept + 1}. ${d.tool} · ${recoveryIdOf(d)}` +
        (d.prune ? ` · [pruned: ${d.prune.kind}${d.prune.reason ? `, ${d.prune.reason}` : ""}]` : "") +
        (d.preCompaction ? " · [pre-compaction]" : "") +
        (d.command ? `\n   cmd: ${redactSecrets(collapseWhitespace(d.command).slice(0, 120))}` : "");
      const snippet = makeSnippet(d, h.line, snippetBudget);
      const block = `${head}\n${snippet}`;
      // hard token cap: never let one result blow the budget
      const est = estimateTextTokens(block);
      if (totalTokens + est > maxResultTokens && kept > 0) {
        trimmed = true;
        break;
      }
      blocks.push(block);
      totalTokens += est;
      kept++;
    }
    if (!trimmed || kept >= limit || snippetBudget === 120) {
      return {
        text: blocks.join("\n\n"),
        details: {
          hits: kept,
          scanned: result.scanned,
          ms,
          scope: input.scope,
          effectiveScope: input.effectiveScope,
          coverage,
          cancelled: result.cancelled,
          recoveryIds: result.hits.slice(0, kept).map((h) => recoveryIdOf(docs[h.docIndex])),
          trimmed,
        },
      };
    }
    trimmed = true;
  }
  // unreachable (loop always returns)
  throw new Error("unreachable");
}
