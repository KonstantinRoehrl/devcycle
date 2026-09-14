import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateKeys, costPerOccurrence, winKeySet, periodLedger, culpritCostByKey } from "../../scripts/impact-ledger.mjs";

const VOCAB = [
  { slug: "first-round-clean-accept", kind: "win", observes: ["first-round-accept:execution"], prevents: ["review-reject:execution"] },
  { slug: "gate-caught-regression", kind: "win", observes: ["gate-pass-clean:execution"] },
  { slug: "restated-instead-of-cited", kind: "rule-violation" },
];
const HELD = [{ culpritId: "first-round-clean-accept", verdict: "held" }, { culpritId: "gate-caught-regression", verdict: "held" }];
const LANDED = [
  { culpritId: "first-round-clean-accept", rung: "r2" },
  { culpritId: "gate-caught-regression", rung: "r2" },
];
const summary = (rows) => ({ impact: rows });

test("aggregateKeys sums frequency and impact, and remembers unmeasurable", () => {
  const agg = aggregateKeys([
    summary([{ key: "a", frequency: 2, impact: 4 }]),
    summary([{ key: "a", frequency: 1, impact: 2 }, { key: "b", frequency: 1, impact: null }]),
  ]);
  assert.deepEqual(agg.get("a"), { impact: 6, frequency: 3, measurable: true });
  assert.equal(agg.get("b").measurable, false);
});

test("costPerOccurrence divides impact by frequency, and is null when unpriced", () => {
  const base = aggregateKeys([summary([{ key: "review-reject:execution", frequency: 4, impact: 10 }])]);
  assert.equal(costPerOccurrence("review-reject:execution", base), 2.5);
  assert.equal(costPerOccurrence("absent:execution", base), null);
  const unpriced = aggregateKeys([summary([{ key: "x", frequency: 2, impact: null }])]);
  assert.equal(costPerOccurrence("x", unpriced), null);
});

test("winKeySet collects slug, novel form, and observes keys of win entries only", () => {
  const keys = winKeySet(VOCAB);
  assert.ok(keys.has("first-round-clean-accept"));
  assert.ok(keys.has("novel:first-round-clean-accept"));
  assert.ok(keys.has("first-round-accept:execution"));
  assert.ok(!keys.has("restated-instead-of-cited"));
});

test("a win resolves its occurrences through observes and prices against the baseline", () => {
  const period = aggregateKeys([summary([{ key: "first-round-accept:execution", frequency: 3, impact: 0 }])]);
  const baseline = aggregateKeys([summary([{ key: "review-reject:execution", frequency: 4, impact: 10 }])]);
  const l = periodLedger({ period, baseline, promotions: [LANDED[0]], vocab: VOCAB, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0].occurrences, 3);
  assert.equal(l.rows[0].savings, 7.5);
  assert.equal(l.savings, 7.5);
});

test("a win with no observes and no journaled slug prices unmeasurable, never zero", () => {
  const vocab = [{ slug: "first-round-clean-accept", kind: "win", prevents: ["review-reject:execution"] }];
  const period = aggregateKeys([summary([{ key: "first-round-accept:execution", frequency: 3, impact: 0 }])]);
  const baseline = aggregateKeys([summary([{ key: "review-reject:execution", frequency: 4, impact: 10 }])]);
  const l = periodLedger({ period, baseline, promotions: [LANDED[0]], vocab, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows[0].savings, null);
  assert.notEqual(l.rows[0].savings, 0);
  assert.equal(l.savings, null);
});

test("a win declaring no prevents is unmeasurable", () => {
  const period = aggregateKeys([summary([{ key: "gate-pass-clean:execution", frequency: 2, impact: 0 }])]);
  const l = periodLedger({ period, baseline: new Map(), promotions: [LANDED[1]], vocab: VOCAB, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows[0].savings, null);
  assert.equal(l.rows[0].reason, "declares no prevents");
});

test("savings over several prevents keys is their mean, not their sum", () => {
  const vocab = [{ slug: "first-round-clean-accept", kind: "win", observes: ["first-round-accept:execution"],
    prevents: ["review-reject:execution", "re-dispatch:execution"] }];
  const period = aggregateKeys([summary([{ key: "first-round-accept:execution", frequency: 1, impact: 0 }])]);
  const baseline = aggregateKeys([summary([
    { key: "review-reject:execution", frequency: 1, impact: 2 },
    { key: "re-dispatch:execution", frequency: 1, impact: 4 },
  ])]);
  const l = periodLedger({ period, baseline, promotions: [LANDED[0]], vocab, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows[0].savings, 3);
});

test("the unattributed sentinel is excluded from cost and never poisons the net", () => {
  const period = aggregateKeys([summary([
    { key: "first-round-accept:execution", frequency: 2, impact: 0 },
    { key: "restated-instead-of-cited", frequency: 1, impact: 5 },
    { key: "re-dispatch:unattributed", frequency: 1, impact: null },
  ])]);
  const baseline = aggregateKeys([summary([{ key: "review-reject:execution", frequency: 2, impact: 6 }])]);
  const l = periodLedger({ period, baseline, promotions: [LANDED[0]], vocab: VOCAB, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.cost, 5);
  assert.equal(l.excluded.events, 1);
  assert.deepEqual(l.excluded.keys, ["re-dispatch:unattributed"]);
  assert.equal(l.net, 6 - 5);
});

test("an unpriced non-win key poisons cost and net but leaves the measured parts readable", () => {
  const period = aggregateKeys([summary([
    { key: "first-round-accept:execution", frequency: 1, impact: 0 },
    { key: "restated-instead-of-cited", frequency: 1, impact: null },
  ])]);
  const baseline = aggregateKeys([summary([{ key: "review-reject:execution", frequency: 1, impact: 3 }])]);
  const l = periodLedger({ period, baseline, promotions: [LANDED[0]], vocab: VOCAB, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.cost, null);
  assert.equal(l.net, null);
  assert.equal(l.savings, 3);
  assert.equal(l.measured.cost, 0);
});

test("a win with several landing records dedups to one row, savings not doubled", () => {
  const period = aggregateKeys([summary([{ key: "first-round-accept:execution", frequency: 3, impact: 0 }])]);
  const baseline = aggregateKeys([summary([{ key: "review-reject:execution", frequency: 4, impact: 10 }])]);
  const l = periodLedger({ period, baseline, vocab: VOCAB, scoreboard: HELD,
    promotions: [{ culpritId: "first-round-clean-accept", rung: "r2" }, { culpritId: "first-round-clean-accept", rung: "r3" }],
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0].savings, 7.5);
  assert.equal(l.savings, 7.5);
});

test("a period with zero held wins nets minus its measurable cost, not unmeasurable", () => {
  const period = aggregateKeys([summary([{ key: "restated-instead-of-cited", frequency: 1, impact: 5 }])]);
  const l = periodLedger({ period, baseline: new Map(), promotions: [], vocab: VOCAB, scoreboard: [],
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows.length, 0);
  assert.equal(l.savings, 0);
  assert.equal(l.cost, 5);
  assert.equal(l.net, -5);
});

test("a held win that cannot be priced keeps savings and net null, never zero", () => {
  const period = aggregateKeys([summary([{ key: "first-round-accept:execution", frequency: 3, impact: 0 }])]);
  const l = periodLedger({ period, baseline: new Map(), promotions: [LANDED[0]], vocab: VOCAB, scoreboard: HELD,
    from: "2026-08-01", to: "2026-09-01", sessions: 5, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 20 });
  assert.equal(l.rows[0].savings, null);
  assert.equal(l.savings, null);
  assert.equal(l.net, null);
});

test("culpritCostByKey: keeps measurable culprits, drops wins and unattributed and unpriced", () => {
  const baseline = aggregateKeys([{ impact: [
    { key: "gate-fail:execution", impact: 22.02, frequency: 2 }, // culprit, priced -> 11.01
    { key: "first-round-clean-accept", impact: 5, frequency: 1 }, // win -> dropped
    { key: "unattributed", impact: 9, frequency: 3 },             // unattributed -> dropped
    { key: "re-dispatch:execution", impact: null, frequency: 4 }, // unmeasurable -> dropped (never 0)
  ] }]);
  const vocab = [{ slug: "first-round-clean-accept", kind: "win" }];
  const out = culpritCostByKey(baseline, vocab);
  assert.deepEqual(Object.keys(out).sort(), ["gate-fail:execution"]);
  assert.equal(out["gate-fail:execution"], 11.01);
});

test("a lesson that is not held, and one that is not win-kind, never enter the ledger", () => {
  const period = aggregateKeys([summary([{ key: "first-round-accept:execution", frequency: 1, impact: 0 }])]);
  const notHeld = periodLedger({ period, baseline: new Map(), promotions: [LANDED[0]], vocab: VOCAB,
    scoreboard: [{ culpritId: "first-round-clean-accept", verdict: "recurred" }],
    from: "2026-08-01", to: "2026-09-01", sessions: 1, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 2 });
  assert.equal(notHeld.rows.length, 0);
  const notWin = periodLedger({ period, baseline: new Map(), promotions: [{ culpritId: "restated-instead-of-cited" }],
    vocab: VOCAB, scoreboard: [{ culpritId: "restated-instead-of-cited", verdict: "held" }],
    from: "2026-08-01", to: "2026-09-01", sessions: 1, baselineFrom: "2026-06-01", baselineTo: "2026-09-01", baselineSessions: 2 });
  assert.equal(notWin.rows.length, 0);
});
