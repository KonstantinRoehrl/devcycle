import { test } from "node:test";
import assert from "node:assert/strict";
import { routingAdvisories, costPerAccepted } from "../../scripts/routing-advisories.mjs";

const CONF = { confidence: 0.95, resamples: 2000 };

// One priced dispatch row of the shape scripts/dispatch-cost.mjs returns.
const row = (sessionHash, taskId, model, usd, measurement = "ok") => ({
  sessionHash, taskId, model, usd, measurement,
  models: model ? [model] : [], agentId: `agent-${sessionHash}-${taskId}`,
  sessionId: sessionHash, agentType: "devcycle:implementer", description: `Task ${taskId}`, turns: 1,
});

// One journal window of the shape readRunRecords returns, keyed by sessionHash.
const records = (entries) => new Map(entries.map(([hash, r]) => [hash, {
  runId: r.runId ?? "0".repeat(16),
  triage: r.requestKind ? { requestKind: r.requestKind, entryStage: "scoping" } : null,
  workload: null,
  verdicts: r.verdicts ?? [],
  dispatches: r.dispatches ?? [],
}]));

const clean = (taskId) => ({ kind: "verdict", taskId, round: 1, blockingCount: 0, conformance: "pass" });
const dirty = (taskId) => ({ kind: "verdict", taskId, round: 1, blockingCount: 2, conformance: "pass" });

// A cell of n dispatches at a fixed cost, all accepted unless `accept` says otherwise.
function cell(hash, requestKind, model, costs, accept = () => true) {
  const dispatches = costs.map((usd, i) => row(hash, String(i + 1), model, usd));
  const verdicts = costs.map((_, i) => (accept(i) ? clean(String(i + 1)) : dirty(String(i + 1))));
  return { dispatches, entry: [hash, { requestKind, verdicts }] };
}

test("four output states: a separating pair reports premium-not-justified", () => {
  const cheap = cell("h1", "feature", "claude-sonnet-5", Array(20).fill(1));
  const dear = cell("h2", "feature", "claude-opus-5", Array(20).fill(10));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const feature = a.classes.find((c) => c.requestKind === "feature");
  assert.equal(feature.cheapest, "claude-sonnet-5");
  const opus = feature.comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "premium-not-justified");
  assert.ok(opus.interval.low > 1, "the interval must sit wholly above 1.0");
});

test("four output states: the cheaper cell losing on quality reports premium-justified", () => {
  // sonnet is cheaper per dispatch but accepts 1 in 10; opus costs 3x and accepts every time.
  const cheap = cell("h1", "bug", "claude-sonnet-5", Array(20).fill(1), (i) => i === 0);
  const dear = cell("h2", "bug", "claude-opus-5", Array(20).fill(3));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const bug = a.classes.find((c) => c.requestKind === "bug");
  assert.equal(bug.cheapest, "claude-sonnet-5");
  const opus = bug.comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "premium-justified");
  assert.ok(opus.interval.high < 1, "the interval must sit wholly below 1.0");
});

test("four output states: an overlapping pair reports unresolved with its interval named", () => {
  // sonnet's mean ($2.00) is unambiguously cheaper than opus's ($2.33) -- this is not a tie, so
  // the reported "unresolved" state below comes only from the bootstrap intervals genuinely
  // overlapping 1.0, never from a tie-break (measured: low 0.75, high 2.333 with seed 20260912,
  // confidence 0.95, resamples 2000).
  const cheap = cell("h1", "docs", "claude-sonnet-5", [1, 3, 2]);
  const dear = cell("h2", "docs", "claude-opus-5", [2, 2, 3]);
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const docs = a.classes.find((c) => c.requestKind === "docs");
  assert.equal(docs.cheapest, "claude-sonnet-5", "sonnet is cheaper on mean cost alone, no tie involved");
  const opus = docs.comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "unresolved");
  assert.ok(opus.interval.low < 1 && opus.interval.high > 1, "an unresolved interval spans 1.0");
});

test("four output states: a class with one priced cell reports no-comparator", () => {
  const only = cell("h1", "refactor", "claude-sonnet-5", [1, 2, 3]);
  const a = routingAdvisories({
    dispatches: only.dispatches, runRecords: records([only.entry]), ...CONF,
  });
  const refactor = a.classes.find((c) => c.requestKind === "refactor");
  assert.equal(refactor.comparisons.length, 1);
  assert.equal(refactor.comparisons[0].state, "no-comparator");
  assert.equal(refactor.comparisons[0].interval, null);
});

test("tie-break ladder: an exact meanUSD tie is broken by lower costPerAccepted", () => {
  // Both cells total $4 over 2 dispatches (meanUSD $2 each, an exact tie). Sonnet accepts both
  // dispatches (costPerAccepted $2); opus accepts only one (costPerAccepted $4). The cheaper
  // cost-per-accepted-task cell must win the tie, regardless of model name -- sonnet here is the
  // lexicographically HIGHER id, so this fails if the ladder's rung 1 is ever bypassed in favor of
  // rung 3's alphabetical fallback (which would instead pick opus).
  const sonnet = cell("h1", "chore", "claude-sonnet-5", [2, 2]);
  const opus = cell("h2", "chore", "claude-opus-5", [2, 2], (i) => i === 0);
  const a = routingAdvisories({
    dispatches: [...sonnet.dispatches, ...opus.dispatches],
    runRecords: records([sonnet.entry, opus.entry]), ...CONF,
  });
  const chore = a.classes.find((c) => c.requestKind === "chore");
  assert.equal(chore.cheapest, "claude-sonnet-5", "the tied cell with the lower cost per accepted task wins, even though it is not the alphabetically-lower id");
  const compared = chore.comparisons.find((c) => c.model === "claude-opus-5");
  assert.notEqual(compared.state, "no-comparator", "the loser of the tie must get a real comparison");
});

test("tie-break ladder: a tie on meanUSD and costPerAccepted is broken by more dispatches", () => {
  // Both cells tie on meanUSD ($2) and on costPerAccepted ($2, everything accepted). Sonnet has
  // twice the sample size, which must win as the larger, more trustworthy sample -- sonnet here is
  // the lexicographically HIGHER id, so this fails if the ladder's rung 2 is ever bypassed in favor
  // of rung 3's alphabetical fallback (which would instead pick opus).
  const sonnet = cell("h1", "audit", "claude-sonnet-5", [2, 2, 2, 2]);
  const opus = cell("h2", "audit", "claude-opus-5", [2, 2]);
  const a = routingAdvisories({
    dispatches: [...sonnet.dispatches, ...opus.dispatches],
    runRecords: records([sonnet.entry, opus.entry]), ...CONF,
  });
  const audit = a.classes.find((c) => c.requestKind === "audit");
  assert.equal(audit.cheapest, "claude-sonnet-5", "the tied cell with more dispatches wins, even though it is not the alphabetically-lower id");
  const compared = audit.comparisons.find((c) => c.model === "claude-opus-5");
  assert.notEqual(compared.state, "no-comparator", "the loser of the tie must get a real comparison");
});

test("tie-break ladder: a null costPerAccepted never wins an exact meanUSD tie", () => {
  // Both cells tie on meanUSD ($2), but opus accepted nothing (costPerAccepted null) while sonnet
  // accepted everything (costPerAccepted $2). A null must never be treated as cheapest -- that
  // would crown a cell that shipped nothing as the bargain, which is exactly QC1's null-vs-zero
  // hazard applied to a tie-break.
  const opus = cell("h1", "bug", "claude-opus-5", [2, 2], () => false);
  const sonnet = cell("h2", "bug", "claude-sonnet-5", [2, 2]);
  const a = routingAdvisories({
    dispatches: [...opus.dispatches, ...sonnet.dispatches],
    runRecords: records([opus.entry, sonnet.entry]), ...CONF,
  });
  const bug = a.classes.find((c) => c.requestKind === "bug");
  assert.equal(bug.cheapest, "claude-sonnet-5", "a null costPerAccepted must never look cheapest");
  const compared = bug.comparisons.find((c) => c.model === "claude-opus-5");
  assert.notEqual(compared.state, "no-comparator", "the loser of the tie must get a real comparison");
});

test("acceptance is rework-free: a retried task is not accepted, though round 1 was clean", () => {
  const dispatches = [row("h1", "1", "claude-sonnet-5", 1), row("h1", "2", "claude-sonnet-5", 1)];
  const runRecords = records([["h1", {
    requestKind: "feature",
    verdicts: [clean("1"), clean("2")],
    // Task 1 needed a second attempt; task 2 did not.
    dispatches: [{ taskId: "1", retryIndex: 1, outcome: "complete" }, { taskId: "2", retryIndex: 0, outcome: "complete" }],
  }]]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  const c = a.cells.find((x) => x.model === "claude-sonnet-5");
  assert.equal(c.dispatches, 2);
  assert.equal(c.accepted, 1, "a clean round-1 verdict on a retried task is not rework-free acceptance");
});

test("acceptance is rework-free: a blocked dispatch on the task also disqualifies it", () => {
  const dispatches = [row("h1", "1", "claude-sonnet-5", 1)];
  const runRecords = records([["h1", {
    requestKind: "feature", verdicts: [clean("1")],
    dispatches: [{ taskId: "1", retryIndex: 0, outcome: "blocked" }],
  }]]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  assert.equal(a.cells.find((x) => x.model === "claude-sonnet-5").accepted, 0);
});

test("attribution is per dispatch: an escalated task credits both models separately", () => {
  const dispatches = [
    row("h1", "1", "claude-sonnet-5", 1),   // the failed cheaper attempt
    row("h1", "1", "claude-opus-5", 4),     // the escalation that landed
  ];
  const runRecords = records([["h1", { requestKind: "feature", verdicts: [clean("1")] }]]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  assert.equal(a.cells.length, 2, "a last-dispatch-wins map would hide the sonnet attempt entirely");
  assert.deepEqual(a.cells.map((c) => c.dispatches), [1, 1]);
});

test("every exclusion class is counted rather than dropped", () => {
  const dispatches = [
    { ...row("h1", null, "claude-sonnet-5", 1), taskId: null },
    row("h9", "1", "claude-sonnet-5", 1),                               // session in no journal window
    row("h2", "1", "claude-sonnet-5", 1),                               // known session, no requestKind
    { ...row("h1", "2", null, null, "missing-transcript"), models: [] },
    { ...row("h1", "3", null, null, "unpriced-model:claude-opus-99"), models: ["claude-opus-99"] },
    { ...row("h1", "4", null, 2, "multi-model"), models: ["claude-sonnet-5", "claude-opus-5"] },
    row("h1", "5", "claude-sonnet-5", 1),                               // no round-1 verdict
    { ...row("h1", "6", null, null, "no-priced-turns"), models: [] },   // transcript exists, nothing priceable
  ];
  const runRecords = records([
    ["h1", { requestKind: "feature", verdicts: [] }],
    ["h2", { requestKind: undefined, verdicts: [] }],
  ]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  assert.equal(a.exclusions.unparseableTask, 1);
  assert.equal(a.exclusions.unknownRequestKind, 2, "an unjoined session and a kindless one both count");
  assert.equal(a.exclusions.missingTranscript, 1);
  assert.equal(a.exclusions.unpricedModel, 1);
  assert.equal(a.exclusions.multiModel, 1);
  assert.equal(a.exclusions.noVerdict, 1);
  assert.equal(a.exclusions.noPricedTurns, 1);
  assert.equal(a.cells.length, 0, "nothing above is eligible for a cell");
});

test("no-priced-turns is its own exclusion, not folded into missingTranscript", () => {
  // scripts/dispatch-cost.mjs:54 emits this for a transcript that exists but priced zero turns --
  // a different, less alarming claim than "the transcript file itself is missing".
  const dispatches = [{ ...row("h1", "1", null, null, "no-priced-turns"), models: [] }];
  const runRecords = records([["h1", { requestKind: "feature", verdicts: [] }]]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  assert.equal(a.exclusions.noPricedTurns, 1);
  assert.equal(a.exclusions.missingTranscript, 0, "a transcript that exists is not a missing transcript");
});

test("cell order is canonical: reordering the same corpus, between OR within cells, does not change the reported classes", () => {
  // The "docs" pair is an exact meanUSD tie ($2 vs $2, the same {1,2,3} multiset for both models) so
  // any dependence on which cell the input array visited first would flip `cheapest` and swap which
  // model gets a real interval vs. `no-comparator` -- for byte-identical underlying facts.
  const cheap = cell("h1", "docs", "claude-sonnet-5", [1, 3, 2]);
  const dear = cell("h2", "docs", "claude-opus-5", [2, 1, 3]);
  const forward = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const reversed = routingAdvisories({
    dispatches: [...dear.dispatches, ...cheap.dispatches],
    runRecords: records([dear.entry, cheap.entry]), ...CONF,
  });
  assert.deepEqual(reversed.classes, forward.classes, "an identical corpus must report the same classes regardless of input order");

  // The pair above holds each cell's OWN row order fixed and only swaps which cell is visited
  // first, so it proves the between-cell property alone. resample() (scripts/routing-advisories.mjs)
  // draws row *indices*, so rows shuffled *within* one cell must not move the interval either --
  // both cells below use five distinct, non-tied costs so a naive index-based resample answers
  // differently for the two orderings (measured on the unfixed module: `low` moved from
  // 1.0952380952380951 to 1.0588235294117647 for this exact pair).
  const canonicalRows = cell("h1", "docs", "claude-sonnet-5", [1, 2, 3, 4, 5]);
  const shuffledRows = cell("h1", "docs", "claude-sonnet-5", [5, 4, 3, 2, 1]);
  const pricier = cell("h2", "docs", "claude-opus-5", [3, 4, 5, 6, 7]);
  const withCanonicalRowOrder = routingAdvisories({
    dispatches: [...canonicalRows.dispatches, ...pricier.dispatches],
    runRecords: records([canonicalRows.entry, pricier.entry]), ...CONF,
  });
  const withShuffledRowOrder = routingAdvisories({
    dispatches: [...shuffledRows.dispatches, ...pricier.dispatches],
    runRecords: records([shuffledRows.entry, pricier.entry]), ...CONF,
  });
  assert.deepEqual(withShuffledRowOrder.classes, withCanonicalRowOrder.classes, "shuffling one cell's row order must not move the bootstrap interval, intervals included");

  // A usd TIE with mixed acceptance: three rows share usd=2, two accepted and one not. A sort
  // keyed on usd alone (M4: the `|| Number(a.accepted) - Number(b.accepted)` term deleted) leaves
  // those three in whatever relative order the input array happened to visit them in, since a
  // stable sort never reorders equal keys -- while the canonical sort's `accepted` term pins one
  // order regardless of input order. `tiedCanonical` and `tiedShuffled` hold the identical five
  // (usd, accepted) pairs and differ only in which of the tied trio the input visits first, so
  // this is the pair that kills M4; the all-distinct-cost pair above never ties on usd at all and
  // passes unchanged under it.
  const tiedCanonical = cell("h3", "docs", "claude-sonnet-5", [1, 2, 2, 2, 3], (i) => i !== 1);
  const tiedShuffled = cell("h3", "docs", "claude-sonnet-5", [1, 2, 2, 2, 3], (i) => i !== 2);
  const tiedPricier = cell("h4", "docs", "claude-opus-5", [3, 4, 5, 6, 7]);
  const withTiedCanonicalOrder = routingAdvisories({
    dispatches: [...tiedCanonical.dispatches, ...tiedPricier.dispatches],
    runRecords: records([tiedCanonical.entry, tiedPricier.entry]), ...CONF,
  });
  const withTiedShuffledOrder = routingAdvisories({
    dispatches: [...tiedShuffled.dispatches, ...tiedPricier.dispatches],
    runRecords: records([tiedShuffled.entry, tiedPricier.entry]), ...CONF,
  });
  assert.deepEqual(withTiedShuffledOrder.classes, withTiedCanonicalOrder.classes, "a usd tie with mixed acceptance must sort the same way regardless of which of the tied rows the input visited first");
});

test("an empty corpus renders no zeros", () => {
  const a = routingAdvisories({ dispatches: [], runRecords: new Map(), ...CONF });
  assert.deepEqual(a.cells, []);
  assert.deepEqual(a.classes, []);
  assert.equal(a.corpus.measuredUSD, null, "no measured dollars is unmeasurable, not $0");
});

test("the bootstrap is seeded: the same corpus yields the same interval twice", () => {
  const cheap = cell("h1", "feature", "claude-sonnet-5", [1, 2, 1, 2, 1, 2]);
  const dear = cell("h2", "feature", "claude-opus-5", [3, 4, 3, 4, 3, 4]);
  const input = {
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  };
  const first = routingAdvisories(input);
  const second = routingAdvisories(input);
  assert.deepEqual(second.classes, first.classes, "an unseeded bootstrap would differ run to run");
});

test("costPerAccepted: a sample that accepted nothing is null, never zero", () => {
  assert.equal(costPerAccepted([{ usd: 5, accepted: false }]), null);
  assert.equal(costPerAccepted([{ usd: 5, accepted: true }, { usd: 5, accepted: false }]), 10);
});
