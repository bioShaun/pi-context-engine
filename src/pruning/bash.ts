/**
 * Bash command categorization and output folding (spec §11).
 */

export type BashCategory =
  | "install" // npm/pip/uv/cargo install, sync
  | "build" // build, compile, download-heavy
  | "fetch" // wget / curl download
  | "test" // pytest, jest, go test, ...
  | "gitdiff" // git diff (full diff — working set, spec §11)
  | "trivial" // ls, pwd, cd, echo, git status, ...
  | "normal";

const INSTALL_RE =
  /^(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|dlx|create)\b|^(?:pip3?|uv)\s+(?:install|sync|pip)\b|^cargo\s+(?:fetch|install)\b|^go\s+mod\s+(?:download|tidy)\b|^make\b(?=.*-j)/;

const BUILD_RE =
  /^docker\s+(?:build|pull|compose\s+(?:build|up))\b|^gradle\b|^mvn\b|^cmake\b|^ninja\b|^make\b|^cargo\s+(?:build|run)\b|^(?:next|nuxt|vite|webpack|esbuild)\b/;

const FETCH_RE = /^wget\b|^curl\s+(?:-[A-Za-z]*[cof]|https?:\/\/)/;

const TEST_RE =
  /(^|\s)(?:pytest|python\s+-m\s+pytest|python3\s+-m\s+pytest|jest|vitest|mocha|go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|npx\s+(?:pytest|jest|vitest)|\.\/run-tests|test\.sh)\b/;

const TRIVIAL_RE =
  /^(?:ls|ll|pwd|cd|echo|which|whoami|date|true|clear)\b/;
const GIT_TRIVIAL_RE = /^git\s+(?:status|st|branch|log\s+--oneline|diff\s+--stat|show\s+--stat|remote\s+-v|rev-parse)\b/;
/** Full `git diff` (no --stat): current-diff is working set (spec §11). */
const GIT_DIFF_RE = /^git\s+diff\b(?!\s+--stat)/;

export function categorizeCommand(command: string): BashCategory {
  if (!command) return "normal";
  const firstLine = command.split("\n", 1)[0].trim();
  // Only categorize the "main" command of a pipeline/chain when it's simple.
  const cmd = firstLine;
  if (INSTALL_RE.test(cmd)) return "install";
  if (TEST_RE.test(cmd)) return "test";
  if (BUILD_RE.test(cmd)) return "build";
  if (FETCH_RE.test(cmd)) return "fetch";
  if (GIT_DIFF_RE.test(cmd)) return "gitdiff";
  if (TRIVIAL_RE.test(cmd) || GIT_TRIVIAL_RE.test(cmd)) return "trivial";
  return "normal";
}

/**
 * Group key for test runs: the runner + target, so repeated runs of the same
 * suite supersede each other (spec §12: fail A → fix → fail B → fix → pass).
 */
export function testGroupKey(command: string): string {
  const m = command.match(/(?:pytest|jest|vitest|mocha|go\s+test|cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|npx\s+\S+)/);
  const runner = m ? m[0].trim() : command.split(/\s+/)[0];
  // First path-like argument (tests/, a file, a package)
  const arg = command.match(/\s((?:[\w.$-]+\/)+[\w.$-]*|\btests?\b|\b[\w-]+\b)(?=\s|$)/);
  return `test:${runner}:${arg ? arg[1] : "*"}`.toLowerCase();
}

/** Normalized key for duplicate detection: trim + collapse whitespace. */
export function normalizeCommand(command: string): string {
  return (command ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

const ERROR_LINE_RE =
  /(^|\n)\s*(?:[A-Za-z_.]*[Ee]rror|[A-Za-z_.]*[Ee]xception|Traceback|FAIL|FAILED|failed|panic|warning|Warning|WARN)[^\n]*/;

/**
 * Fold a large bash output: keep the command, exit code, first lines,
 * error/failure lines, and last lines (spec §10.1, §11).
 */
export function foldBashOutput(
  command: string,
  output: string,
  isError: boolean,
  opts: { maxHeadLines?: number; maxTailLines?: number; maxErrorLines?: number; maxChars?: number } = {},
): string {
  const maxHead = opts.maxHeadLines ?? 8;
  const maxTail = opts.maxTailLines ?? 6;
  const maxErrors = opts.maxErrorLines ?? 15;
  const maxChars = opts.maxChars ?? 2200;

  const lines = output.split("\n");
  if (lines.length <= maxHead + maxTail + 4) return output; // not worth folding

  const head = lines.slice(0, maxHead);
  const tail = lines.slice(-maxTail);

  // Collect error lines with ±2 lines context window (spec §8.3).
  const errorIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_LINE_RE.test(lines[i])) {
      const from = Math.max(0, i - 2);
      const to = Math.min(lines.length - 1, i + 2);
      for (let j = from; j <= to; j++) {
        errorIndices.add(j);
      }
    }
  }

  const headIndices = new Set(Array.from({ length: head.length }, (_, i) => i));
  const tailIndices = new Set(Array.from({ length: tail.length }, (_, i) => lines.length - tail.length + i));

  const sortedIndices = Array.from(errorIndices).sort((a, b) => a - b);
  const errors: string[] = [];
  for (const idx of sortedIndices) {
    if (errors.length >= maxErrors) break;
    if (headIndices.has(idx) || tailIndices.has(idx)) continue;
    const line = lines[idx].trim().slice(0, 160);
    if (line) {
      errors.push(line);
    }
  }

  const omitted = lines.length - head.length - tail.length;
  const parts: string[] = [];
  parts.push(`[bash output folded by ${"pi-context-engine"} — full output remains in session history]`);
  parts.push(`command: ${command.length > 200 ? command.slice(0, 200) + "…" : command}`);
  if (isError) parts.push("exit: non-zero (error)");
  if (head.length) parts.push("\n-- head --\n" + head.join("\n"));
  if (errors.length) parts.push("\n-- notable lines --\n" + errors.join("\n"));
  if (tail.length) parts.push("\n-- tail --\n" + tail.join("\n"));
  parts.push(`\n(${omitted} lines folded)`);
  let folded = parts.join("\n");
  if (folded.length > maxChars) folded = folded.slice(0, maxChars) + "\n…[truncated]";
  return folded;
}

/**
 * Decide whether a bash result is pure noise (install/build/fetch/trivial
 * that succeeded): foldable to a one-line stub (spec §11).
 */
export function isDisposableBash(command: string, isError: boolean): boolean {
  if (isError) return false; // active failures stay visible
  const cat = categorizeCommand(command);
  return cat === "install" || cat === "fetch" || cat === "trivial" || cat === "build";
}
