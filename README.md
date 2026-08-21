# pi-context-engine

Context lifecycle engine for [Pi Coding Agent](https://github.com/badlogic/pi-mono).
A Pi extension that manages the *effective* context sent to the model:

- **measures** context pressure and quality (`/context`)
- **prunes** low-value tool output non-destructively (`/context clean`, automatic)
- **checkpoints** task state into a fixed JSON schema (`/context checkpoint`)
- **drives** Pi's native compaction with checkpoint-anchored instructions (`/context compact`)
- **hands off** to fresh sessions with a self-contained prompt (`/context handoff`)
- **pins** critical constraints that survive every destructive step

[中文文档](README.zh-CN.md) · [Design spec (zh)](docs/pi-context-engine.spec.md)

```
pi native session (never modified)  ──►  context event  ──►  effective context
                                                        (pruned, folded,
                                                         pins re-injected)
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
| `/context clean` | Manual aggressive pass: stubs stale/duplicates, folds oversized outputs. Applied on the next model call; session file untouched |
| `/context checkpoint` | LLM-generated, schema-validated task checkpoint (`cp-NNNN.json`) |
| `/context compact` | Triggers Pi compaction with checkpoint-anchored instructions |
| `/context handoff` | Checkpoint → self-contained handoff prompt → new session (edit before switching) |
| `/context pin <text>` | Pin a constraint/requirement/file/command/note (type inferred) |
| `/context pin-last` | Pin the latest user message |
| `/context pin-file <path>` | Pin a file (its reads are never pruned) |
| `/context pins` / `/context unpin [id]` | List / remove pins |
| `/context history` | Audit trail of recent prunes, checkpoints, compactions |

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
prune/compact). All auto behavior is individually toggleable and audited.

```json
{
  "enabled": true,
  "auto": { "prune": true, "checkpoint": true, "compact": true },
  "handoff": { "mode": "suggest" },
  "thresholds": { "prune": 0.65, "checkpoint": 0.80, "compact": 0.88, "handoff": 0.94 },
  "models": { "qwen*": { "prune": 0.55, "compact": 0.78 } }
}
```

## What gets pruned

Classification is rule-based (no per-message LLM calls):

- **critical** — user messages, summaries, pinned content → never touched
- **working** — latest reads, active failures, recent tool output → only *folded*
  (head + errors + tail), never dropped
- **stale** — superseded reads (`read A → edit A → read A`), earlier identical
  commands, old failing test runs, old search duplicates → stubbed
- **disposable** — install/fetch/build noise, trivial commands, passing test
  lists, directory listings → stubbed

A stub is a one-line marker (`[pi-context-engine] bash result pruned …`) that
replaces the large output **in the effective context only**. The original data
remains in the session file — re-running the command or resuming the session
always recovers it. Pruning is idempotent (stubbed results are never re-folded)
and tool results are never deleted, only replaced in place, so provider
tool-call pairing always holds.

## Safety model

- **Fail-open**: any engine error is logged to `metrics.jsonl` and swallowed;
  Pi continues with the unmodified context.
- **Never enlarge**: a replacement that would cost more tokens than the original
  is skipped.
- **Pins survive**: pin content is re-injected as a hidden message whenever it is
  missing from the effective context; pinned files force their reads to
  critical.
- **Handoff is suggest-only by default** (`handoff.mode: "suggest"`); the
  explicit `/context handoff` command is the only handoff path.
- **Audit everything**: every stub/fold is one JSON line in `prune-log.jsonl`
  with original/replacement sizes and reason.

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

- v0.2: automatic checkpoint refresh, Pi compaction hook integration, better
  test-result folding, git-aware diff tracking, task phase detection
- v0.3: handoff scoring, automatic fresh-session bootstrap, checkpoint recovery
- v0.4: semantic folding (embeddings / recall on demand)
