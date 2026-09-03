/**
 * Prefix-cache-aware candidate ordering (§19.5) and transient guidance (§14).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  orderPruneCandidates,
  MIN_RECLAIM_GUARD,
  RECLAIM_GUARD_RATIO,
  type PruneCandidate,
} from "../src/pruning/pruner.ts";
import { buildTransientGuidance } from "../src/transient/guidance.ts";

function cand(
  index: number,
  originalTokens: number,
  replacementTokens: number,
  extra: Partial<PruneCandidate> = {},
): PruneCandidate {
  return {
    index,
    originalTokens,
    replacementTokens,
    class: "disposable",
    recoveryConfidence: 1,
    ...extra,
  };
}

test("§12.2: close value → later branch position wins (cache locality)", () => {
  const early = cand(2, 5000, 500); // reclaims 4500
  const late = cand(40, 5100, 600); // reclaims 4500 (close value, later position)
  const ordered = orderPruneCandidates([early, late]);
  assert.equal(ordered[0].index, 40, "later candidate preferred within the guard band");
  assert.equal(ordered[1].index, 2);
});

test("§12.3: earlier candidate reclaiming ≥2000 more tokens wins", () => {
  const early = cand(2, 8000, 500); // reclaims 7500
  const late = cand(40, 5100, 600); // reclaims 4500; diff = 3000 ≥ 2000
  const ordered = orderPruneCandidates([late, early]);
  assert.equal(ordered[0].index, 2, "min-reclaim guard overrides cache locality");
});

test("§12.3: earlier candidate reclaiming ≥2× the later one wins", () => {
  const early = cand(3, 4000, 100); // reclaims 3900
  const late = cand(30, 2000, 100); // reclaims 1900; 3900 ≥ 2×1900
  const ordered = orderPruneCandidates([late, early]);
  assert.equal(ordered[0].index, 3);
});

test("§12.3 thresholds are the documented constants and testable", () => {
  assert.equal(MIN_RECLAIM_GUARD, 2000);
  assert.equal(RECLAIM_GUARD_RATIO, 2);
});

test("ordering is stable for identical input", () => {
  const cands = [cand(1, 900, 100), cand(5, 900, 100), cand(9, 900, 100), cand(3, 3000, 100)];
  const a = orderPruneCandidates(cands);
  const b = orderPruneCandidates(cands);
  assert.deepEqual(
    a.map((c) => c.index),
    b.map((c) => c.index),
  );
});

test("targetReclaimable stops after reaching the target", () => {
  const cands = [
    cand(1, 3000, 1000), // reclaims 2000
    cand(2, 5000, 1000), // reclaims 4000
    cand(3, 2000, 1000), // reclaims 1000
  ];
  const ordered = orderPruneCandidates(cands, { targetReclaimable: 5000 });
  const total = ordered.reduce((s, c) => s + Math.max(0, c.originalTokens - c.replacementTokens), 0);
  assert.ok(total >= 5000);
  assert.ok(ordered.length < cands.length, "not every candidate needed");
});

// ---------------------------------------------------------------------------
// Case R3 — selective pruning through pruneContext (§12.1 + §12.3)
// ---------------------------------------------------------------------------

test("R3: cache-aware pruning meets the target with the later candidate first", () => {
  // Two disposable bash outputs; a target met by one of them.
  const cands = [
    cand(10, 5200, 200), // earlier, reclaims 5000
    cand(50, 5250, 250), // later, reclaims 5000 — cache locality prefers this
  ];
  const ordered = orderPruneCandidates(cands, { targetReclaimable: 5000 });
  assert.equal(ordered.length, 1, "one candidate meets the target");
  assert.equal(ordered[0].index, 50, "the later (cache-friendlier) candidate is chosen");

  // Grow the early one past the §12.3 guard → the early candidate wins instead.
  const grown = [cand(10, 12000, 200), cands[1]];
  const ordered2 = orderPruneCandidates(grown, { targetReclaimable: 5000 });
  assert.equal(ordered2[0].index, 10, "min-reclaim guard overrides cache locality");
});

// ---------------------------------------------------------------------------
// Transient guidance (§14)
// ---------------------------------------------------------------------------

const guidanceCfg = { enabled: true, minPressure: 0.65, maxTokens: 120, compactEnter: 0.9 };

test("§14.2: no guidance below minPressure / when disabled", () => {
  assert.equal(
    buildTransientGuidance({ pressure: 0.4, hasFolded: false, compactImminent: false }, guidanceCfg),
    null,
  );
  assert.equal(
    buildTransientGuidance(
      { pressure: 0.9, hasFolded: true, compactImminent: true },
      { ...guidanceCfg, enabled: false },
    ),
    null,
  );
});

test("§14.2: high/critical bands produce guidance with a stable template id", () => {
  const high = buildTransientGuidance(
    { pressure: 0.7, hasFolded: false, compactImminent: false },
    guidanceCfg,
  );
  assert.ok(high);
  assert.equal(high!.band, "high");
  assert.equal(high!.templateId, "high");

  const critical = buildTransientGuidance(
    { pressure: 0.95, hasFolded: true, compactImminent: true },
    guidanceCfg,
  );
  assert.ok(critical);
  assert.equal(critical!.band, "critical");
  assert.equal(critical!.templateId, "critical-folded-compact");
});

test("§14.3: byte-stable across turns in the same band+state", () => {
  const state = { pressure: 0.82, hasFolded: true, compactImminent: false };
  const a = buildTransientGuidance(state, guidanceCfg);
  const b = buildTransientGuidance({ ...state }, guidanceCfg);
  assert.equal(a!.text, b!.text, "same band + state → identical bytes");
  // adjacent pressures within the same band are also byte-identical
  const c = buildTransientGuidance({ ...state, pressure: 0.83 }, guidanceCfg);
  assert.equal(a!.text, c!.text, "no high-precision percentages leak into the template");
});

test("§14: guidance is bounded by maxTokens", () => {
  for (const pressure of [0.66, 0.7, 0.85, 0.91, 0.99]) {
    for (const hasFolded of [false, true]) {
      for (const compactImminent of [false, true]) {
        const g = buildTransientGuidance({ pressure, hasFolded, compactImminent }, guidanceCfg);
        if (!g) continue;
        assert.ok(g.text.length < 600, `template bounded (${g.text.length} chars)`);
        assert.ok(!g.text.startsWith(" "), "no leading space from the emergency reducer");
        assert.ok(g.text.includes("context_search"), "mentions the recall tool");
        assert.ok(!g.text.includes(String(pressure)), "no raw pressure value in text");
      }
    }
  }
});

test("§14: every template variant fits maxTokens without emergency truncation", () => {
  for (const hasFolded of [false, true]) {
    for (const compactImminent of [false, true]) {
      for (const band of ["high", "critical"] as const) {
        const pressure = band === "critical" ? 0.95 : 0.7;
        const g = buildTransientGuidance({ pressure, hasFolded, compactImminent }, guidanceCfg);
        assert.ok(g, `${band} template exists`);
        // ≤ maxTokens AND complete sentences (the reducer would cut mid-sentence)
        assert.ok(g!.text.endsWith("."), `${g!.templateId}: not mid-sentence truncated`);
      }
    }
  }
});
