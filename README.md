# pi-context-engine

Context lifecycle engine for [Pi Coding Agent](https://github.com/badlogic/pi-mono).
A Pi extension that manages the *effective* context sent to the model:

- **measures** context pressure and quality (`/context`)
- **prunes** low-value tool output non-destructively (`/context clean`, automatic)
- **recalls** pruned originals on demand (`/context search`, model tool `context_search`)
- **checkpoints** task state into a fixed JSON schema (`/context checkpoint`)
- **drives** Pi's native compaction with checkpoint-anchored instructions (`/context compact`)
- **hands off** to fresh sessions with a self-contained prompt (`/context handoff`)
- **pins** critical constraints that survive every destructive step

[中文文档](README.zh-CN.md) · [Design spec (zh)](docs/pi-context-engine.spec.md) · [v0.2 auto-optimization spec (zh)](docs/pi-context-engine.auto-optimization.spec.md) · [v0.3 recall spec (zh)](docs/pi-context-engine.pi-native-recall.spec.md)

```
pi native session (never modified)  ──►  context event  ──►  effective context
                                                        (pruned, folded,
                                                         pins re-injected)
              ▲
              └── /context search · context_search tool   (recall L0 originals)
```

> Keep the working set, evict the noise, preserve recoverability.

## Install

```bash
# from GitHub (global install → ~/.pi/agent/settings.json)
pi install git:github.com/bioShaun/pi-context-engine

# project-local (→ .pi/settings.json, shareable with your team)
pi install -l git:github.com/bioShaun/pi-context-engine

# try it for this run only, without installing
pi -e git:github.com/bioShaun/pi-context-engine
```

- SSH source works too: `pi install git:git@github.com:bioShaun/pi-context-engine`
  (uses your configured SSH keys / `~/.ssh/config`).
- Local development: `pi install /abs/path/to/pi-context-engine` or `pi -e ./src/index.ts`.

Git installs clone the repo and run `npm install` automatically (the Pi core
packages are declared as peers and provided by Pi itself — the extension has no
runtime dependencies of its own).

Uninstall: `pi remove git:github.com/bioShaun/pi-context-engine`.
`pi list` shows installed packages; `pi update --extensions` updates them.

State is stored session-locally (never touches your repo):

```
~/.pi/context-engine/
├── config.json                  # optional global config
└── sessions/<session-id>/
    ├── state.json               # compaction/checkpoint/handoff counters
    ├── pins.json
    ├── metrics.jsonl            # per-turn metrics + action events
    ├── prune-log.jsonl          # one line per pruned item (audit)
    └── checkpoints/
        ├── cp-0001.json
        └── latest.json
```

Project-local override: `.pi/context-engine.json` (same schema, deep-merged).
Env override (tests/CI): `PI_CONTEXT_ENGINE_CONFIG=/path/to/config.json`.

## Commands

| Command | Effect |
|---|---|
| `/context` | Pressure, quality, class breakdown, largest consumers, recommendation |
| `/context enable` / `/context disable` | Turn the engine's auto pipeline on/off **for this session only** (in-memory; config file untouched, resets on new session/restart). Disabling cancels a queued auto compact; each actual switch is audited |
| `/context clean` | Manual aggressive pass: stubs stale/duplicates, folds oversized outputs. Applied on the next model call; session file untouched |
| `/context search <query> [--send]` | Search the session's original tool outputs (including pruned ones). Supports `tool:<name>`, `file:<path>`, `"quoted phrases"`, CJK. `--send` forwards the budgeted results to the model |
| `/context checkpoint` | LLM-generated, schema-validated task checkpoint (`cp-NNNN.json`) |
| `/context compact` | Triggers Pi compaction with checkpoint-anchored instructions |
| `/context handoff` | Checkpoint → self-contained handoff prompt → new session (edit before switching) |
| `/context pin <text>` | Pin a constraint/requirement/file/command/note (type inferred) |
| `/context pin-last` | Pin the latest user message |
| `/context pin-file <path>` | Pin a file (its reads are never pruned) |
| `/context pins` / `/context unpin [id]` | List / remove pins |
| `/context history` | Audit trail of recent prunes, checkpoints, compactions, searches |

The model gets the same recall ability natively: the `context_search` tool is
registered for the LLM (same parser, search, and renderer as the command). It
only reads the current session branch — never writes, never re-runs commands,
and results stay within a configurable token budget.

## Automatic policy

On every model call the observer estimates pressure and quality:

```
pressure  = context tokens / (window − output reserve − safety reserve)
quality   = (critical + working tokens) / total tokens
```

| Condition (defaults) | Action |
|---|---|
| pressure < 55% and quality > 60% | nothing (fast path) |
| pressure ≥ 65% and reclaimable > 5K | **auto prune** (non-destructive fold/stub) |
| pressure ≥ 80% and no fresh checkpoint | **auto checkpoint** (background LLM call) |
| pressure ≥ 88% | **auto compact** (checkpoint-anchored) |
| pressure ≥ 94% and ≥2 compactions and quality < 50% | **suggest handoff** (never automatic) |

Model-specific thresholds via config (e.g. small local models get earlier
prune/compact; most specific pattern wins). All auto behavior is individually
toggleable and audited.

Auto actions are anti-oscillating and cost-bounded (v0.2): each action has
enter/exit hysteresis (re-entry requires 2 consecutive turns below `exit`),
cooldowns (prune 15s / compact 300s), and a rate limit (≤ 3 actions per 10
turns, then notify-only). Checkpoint generation backs off exponentially after
failures (30s → 60s → 120s → … capped at 10min), trips a circuit breaker after
3 consecutive failures, and has a per-session budget (`maxPerSession`). A
checkpoint counts as fresh only when it is < 10min old AND < 20K tokens AND
< 30 messages behind.

```json
{
  "enabled": true,
  "auto": { "prune": true, "checkpoint": true, "compact": true },
  "handoff": { "mode": "suggest" },
  "thresholds": {
    "prune":      { "enter": 0.65, "exit": 0.55 },
    "checkpoint": { "enter": 0.80, "exit": 0.70 },
    "compact":    { "enter": 0.88, "exit": 0.78 },
    "handoff":    { "enter": 0.94 }
  },
  "policy": { "reclaimableMin": 5000, "maxActionsPer10Turns": 3, "adaptiveThresholds": true },
  "checkpoint": { "model": null, "maxPerSession": 20 },
  "stub": { "enhanced": true, "maxChars": 360, "maxErrorChars": 180, "includeRecoveryRef": true },
  "search": { "enabled": true, "defaultLimit": 8, "maxLimit": 20, "maxSnippetChars": 800, "maxResultTokens": 3000, "defaultScope": "pruned" },
  "cacheAware": { "enabled": true },
  "transientGuidance": { "enabled": true, "minPressure": 0.65, "maxTokens": 120 },
  "prune": { "bands": [
    { "pressureGte": 0.88, "stubMinTokens": 20, "foldMaxChars": 1200 },
    { "pressureGte": 0.80, "stubMinTokens": 30, "foldMaxChars": 1600 },
    { "pressureGte": 0.0,  "stubMinTokens": 50, "foldMaxChars": 2200 }
  ]},
  "models": { "qwen*": { "prune": { "enter": 0.55, "exit": 0.45 }, "compact": { "enter": 0.78, "exit": 0.68 } } }
}
```

v0.1 flat thresholds (`"prune": 0.65`) still load — they are migrated to
`{ enter, exit: enter − 0.10 }` automatically (audited as `config_migrated`).
Invalid values fall back to defaults (`config_sanitized`).

## What gets pruned

Classification is rule-based (no per-message LLM calls):

- **critical** — user messages, summaries, pinned content → never touched
- **working** — latest reads, active failures, recent tool output → only *folded*
  (head + errors + tail), never dropped
- **stale** — superseded reads (`read A → edit A → read A`), earlier identical
  commands, old failing test runs, old search duplicates → stubbed
- **disposable** — install/fetch/build noise, trivial commands, passing test
  lists, directory listings → stubbed

A stub replaces the large output **in the effective context only**. v0.3 stubs
are information-dense and deterministic (no LLM calls): they keep the facts that
matter for continuing the task — exit code, first error signature, test counts,
read ranges, hit counts, HTTP status — plus a short recovery id:

```
[pi-context-engine] bash pruned: exit=1, errors=3, first="TS2322: Type 'string' is not assignable to type 'number'", lines=428; ~6.2K tokens; reason=old-output; recover=r:8af1c2
```

The original data remains untouched in the session file, and the stub's
`recover=` id resolves back to the exact original via `context_search` /
`/context search` — no re-run needed. Pruning is idempotent (stubbed results
are never re-folded), never enlarges (a replacement costing more tokens than
the original is skipped), and tool results are never deleted, only replaced in
place, so provider tool-call pairing always holds. When several candidates are
equally safe, the pruner prefers later positions to shrink the provider prefix
cache invalidation window (cache locality never overrides safety or a clearly
larger reclaim).

## Safety model

- **Fail-open**: any engine error is logged to `metrics.jsonl` and swallowed;
  Pi continues with the unmodified context.
- **Never enlarge**: a replacement that would cost more tokens than the original
  is skipped.
- **Session-native recovery**: every stub/fold carries a `RecoveryRef`
  (session id + content hash, no user content) into the session branch;
  recall searches only the current branch, is read-only, and persists nothing.
  Pre-compaction originals are searched and flagged when the branch still
  exposes them; otherwise coverage is reported as partial — never faked.
- **Pins survive**: pin content is re-injected as a hidden message whenever it is
  missing from the effective context; pinned files force their reads to
  critical.
- **Transient guidance**: high-pressure hints (use `context_search` before
  re-running) are injected per-turn into the system prompt only — user
  constraints, pins, and checkpoints are never transient.
- **Handoff is suggest-only by default** (`handoff.mode: "suggest"`); the
  explicit `/context handoff` command is the only handoff path.
- **Audit everything**: every stub/fold is one JSON line in `prune-log.jsonl`
  with original/replacement sizes, reason, and recovery ref; searches log
  query hash + counts only (never raw queries or snippets).

## Development

```bash
npm install
npm test          # node --test (Node >= 23.6, native TS)
npm run typecheck
```

Layout follows the spec's recommended source structure (`src/observer`,
`src/classifier`, `src/pruning`, `src/checkpoint`, `src/policy`, `src/pins`,
`src/handoff`, `src/commands`-style dispatch in `src/index.ts`).

## Roadmap (spec §47–49)

- v0.2 (done): auto-first pipeline — unified token metering (CJK-aware +
  calibrated), enter/exit hysteresis with rate limits, checkpoint backoff /
  circuit breaker / budget, pressure-banded pruning, range-aware read
  supersession
- v0.3 (done): pi-native recall — deterministic enhanced stubs with recovery
  refs, lexical `context_search` (tool + `/context search`), prefix-cache-aware
  candidate ordering, transient per-turn guidance
- v0.3.x: handoff scoring, automatic fresh-session bootstrap, checkpoint recovery
- v0.4: semantic folding (L2) — only after lexical recall proves out; requires
  separate LLM budget, per-session caps, circuit breaker, and summarizer
  validation. See the v0.3 spec §13.3 preconditions.
