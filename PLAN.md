# Implementation plan — pi-context-engine v0.1

Spec: `docs/pi-context-engine.spec.md`

## Scope (spec §38 MVP 1–4 + §46 acceptance)

1. **Observer + `/context`** — token estimation, classification (rule-based),
   pressure/quality, largest consumers report.
2. **Classifier + Pruner + `/context clean`** — oversized / duplicate /
   superseded tool results (bash, read, grep/find/ls + tests). Non-destructive:
   transforms via the `context` event; session JSONL never modified.
   Idempotent stubs via `details.engine` marker.
3. **Structured checkpoint + `/context checkpoint`** — fixed JSON schema
   (§13), LLM-generated with strict prompt (§14), schema-validated,
   stored session-local `~/.pi/context-engine/sessions/<id>/checkpoints/`.
4. **Pressure policy (auto)** — 65% prune / 80% checkpoint / 88% compact /
   handoff = SUGGEST ONLY (§26–27). Fail-open (§36). Audit log (§29).
5. **Pins** (§15–16) — pin/pin-last/pin-file/pins/unpin; survive prune via
   re-injection; session-local `pins.json`.
6. **Commands** (§22) — /context, clean, checkpoint, compact, handoff,
   pin, pins, unpin, history.
7. **Config** (§26, §31) — global `~/.pi/context-engine/config.json` +
   project-local `.pi/context-engine.json`, model-specific thresholds.

## Design decisions

- Pruning is **non-destructive**: the `context` event rewrites the effective
  message list per LLM call; original session data stays on disk (recovery, §46).
- Tool results are **stubbed/folded, never dropped** (provider tool-call
  pairing safety). Disposable = ~1-line stub. Oversized working = head+errors+tail.
- Zero runtime dependencies (node builtins only). `import type` for pi types
  only in `index.ts`; pure logic modules are standalone → testable with
  `node --test` (Node 24 native TS).
- Checkpoint/handoff LLM calls use `ctx.modelRegistry.complete` + `ctx.model`
  (slow path, only when triggered).

## File layout (spec §40)

src/index.ts, config.ts, types.ts, audit.ts,
observer/{context-observer,token-estimator}.ts,
classifier/{classifier,rules,scoring}.ts,
pruning/{pruner,bash,read,grep,supersession}.ts,
checkpoint/{checkpoint,schema,store}.ts,
policy/{engine,thresholds}.ts,
handoff/handoff.ts, pins/pins.ts,
commands/context.ts (dispatcher for all /context subcommands)

tests/: classifier, pruning, supersession, checkpoint, policy, token-estimator

## Verification

1. `node --test tests/` — unit tests
2. `npx tsc --noEmit` — type check
3. Live smoke test: `pi -e ./src/index.ts -p ...` in a scratch dir
   (build a synthetic busy session, run /context, /context clean)
