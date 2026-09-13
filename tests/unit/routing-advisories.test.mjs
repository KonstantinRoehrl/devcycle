import { test } from "node:test";
import assert from "node:assert/strict";
import { routingAdvisories, costPerAccepted } from "../../scripts/routing-advisories.mjs";

// comparatorFloor 2 is this file's default so the tie-break and state fixtures below stay small
// enough to read; the floor's own behaviour is exercised at the shipped value (5) by the
// comparator-floor and boundary tests, which size their cells accordingly.
const CONF = { confidence: 0.95, resamples: 2000, comparatorFloor: 2 };

// One priced dispatch row of the shape scripts/dispatch-cost.mjs returns.
const row = (sessionHash, taskId, model, usd, measurement = "ok") => ({
  sessionHash, taskId, model, usd, measurement,
  models: model ? [model] : [], agentId: `agent-${sessionHash}-${taskId}`,
  sessionId: sessionHash, agentType: "devcycle:implementer", description: `Task ${taskId}`, turns: 1,
});

// One journal window of the shape readRunRecords returns, keyed by sessionHash. Each window gets
// its own runId unless the caller pins one: a shared runId is what joins two windows into one run
// (the runId-keyed resolution below), so it must be asked for rather than inherited by default.
const records = (entries) => new Map(entries.map(([hash, r]) => [hash, {
  runId: r.runId ?? `run-${hash}`,
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
  assert.equal(refactor.comparisons[0].reason, "single-priced-cell",
    "§ 5's no-comparator is the one-priced-cell case, and says so");
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
    row("h9", "1", "claude-sonnet-5", 1),                               // session in no journal window: unjoined
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
  assert.equal(a.exclusions.unjoinedSession, 1, "a session the journal never saw is its own class");
  assert.equal(a.exclusions.unknownRequestKind, 1,
    "only the joined-but-kindless session is an unknown requestKind; the unjoined one is not billed to it");
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

// § 4.1: the comparator is chosen by a point estimate, so its own sample size never enters any
// interval -- a 2-row comparator makes every ratio in its class narrow and far from 1.0. The floor
// is on comparator eligibility only; the compared cell still has none.
test("comparator floor: a below-floor cell never becomes the comparator, and is still reported as a row", () => {
  const thin = cell("h1", "feature", "claude-haiku-4-5", [0.5, 0.5]);
  const cheap = cell("h2", "feature", "claude-sonnet-5", Array(6).fill(1));
  const dear = cell("h3", "feature", "claude-opus-5", Array(6).fill(4));
  const a = routingAdvisories({
    dispatches: [...thin.dispatches, ...cheap.dispatches, ...dear.dispatches],
    runRecords: records([thin.entry, cheap.entry, dear.entry]), ...CONF, comparatorFloor: 5,
  });
  const feature = a.classes.find((c) => c.requestKind === "feature");
  assert.equal(feature.cheapest, "claude-sonnet-5",
    "the cheapest ELIGIBLE cell is the comparator; two rows at $0.50 must not decide the class");
  assert.equal(feature.comparatorFloor, 5, "the artifact names the floor it applied");
  const thinRow = feature.comparisons.find((c) => c.model === "claude-haiku-4-5");
  assert.ok(thinRow, "a below-floor cell is reported, never silently dropped");
  assert.equal(thinRow.comparatorEligible, false, "and is named as excluded from comparator eligibility");
  assert.ok(thinRow.interval, "the compared cell has no floor, so it still gets a real interval");
  assert.equal(feature.comparisons.find((c) => c.model === "claude-sonnet-5").comparatorEligible, true);
});

test("comparator floor: a class with no eligible cell reports no-comparator for every row, and why", () => {
  const one = cell("h1", "docs", "claude-sonnet-5", [1, 1, 1]);
  const two = cell("h2", "docs", "claude-opus-5", [4, 4]);
  const a = routingAdvisories({
    dispatches: [...one.dispatches, ...two.dispatches],
    runRecords: records([one.entry, two.entry]), ...CONF, comparatorFloor: 5,
  });
  const docs = a.classes.find((c) => c.requestKind === "docs");
  assert.equal(docs.cheapest, null, "no eligible cell means the class has no baseline at all");
  assert.equal(docs.comparisons.length, 2, "both cells are still reported as rows");
  for (const c of docs.comparisons) {
    assert.equal(c.state, "no-comparator");
    assert.equal(c.reason, "no-cell-meets-floor");
    assert.equal(c.interval, null);
  }
});

test("comparator floor: an absent or degenerate floor throws rather than silently disabling comparison", () => {
  const only = cell("h1", "feature", "claude-sonnet-5", [1, 1]);
  const input = { dispatches: only.dispatches, runRecords: records([only.entry]), confidence: 0.95, resamples: 10 };
  assert.throws(() => routingAdvisories(input), /comparatorFloor/);
  assert.throws(() => routingAdvisories({ ...input, comparatorFloor: 0 }), /comparatorFloor/);
});

// The journal is keyed by session; a run is not. readRunRecords windows `workload` per session
// (scripts/doctor.mjs), and a pre-`triage` run writes its workload line at the finish stage -- the
// last window -- so an implementer dispatched in an earlier window resolves `workload: null` on its
// own session record. § 2's join table keys the class, and the verdict, on runId.
test("class and verdict resolve per run, not per session window", () => {
  const dispatches = [row("early", "1", "claude-sonnet-5", 1)];
  const runRecords = new Map([
    ["early", { runId: "r1", triage: null, workload: null, verdicts: [], dispatches: [] }],
    ["late", { runId: "r1", triage: null, workload: { requestKind: "refactor" },
      verdicts: [clean("1")], dispatches: [] }],
  ]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  assert.equal(a.exclusions.unknownRequestKind, 0, "the run's own workload line resolves the class");
  assert.equal(a.exclusions.noVerdict, 0, "the run's own round-1 verdict resolves the outcome");
  assert.equal(a.cells.length, 1);
  assert.equal(a.cells[0].requestKind, "refactor");
  assert.equal(a.cells[0].accepted, 1);
});

test("runId-less records stay their own scope rather than pooling into one run", () => {
  const dispatches = [row("h1", "1", "claude-sonnet-5", 1)];
  const runRecords = new Map([
    ["h1", { runId: null, triage: null, workload: null, verdicts: [clean("1")], dispatches: [] }],
    ["h2", { runId: null, triage: { requestKind: "feature" }, workload: null, verdicts: [], dispatches: [] }],
  ]);
  const a = routingAdvisories({ dispatches, runRecords, ...CONF });
  assert.equal(a.exclusions.unknownRequestKind, 1,
    "two records with no runId are two scopes, not one run whose classes cross-attribute");
});

// § 2's oracle skips a session the journal never saw; counting those transcripts as "joined" is
// what let 351 rows that joined to nothing be billed to unknown requestKind.
test("joined means joined: a transcript whose session is in no journal window is its own class", () => {
  const known = cell("h1", "feature", "claude-sonnet-5", [1, 1]);
  const orphan = row("h-nowhere", "1", "claude-sonnet-5", 3);
  const a = routingAdvisories({
    dispatches: [...known.dispatches, orphan], runRecords: records([known.entry]), ...CONF,
  });
  assert.equal(a.corpus.transcripts, 3, "every implementer transcript found is counted");
  assert.equal(a.corpus.joined, 2, "only dispatches whose session the journal knows are joined");
  assert.equal(a.exclusions.unjoinedSession, 1);
  assert.equal(a.exclusions.unknownRequestKind, 0, "an unjoined row is not billed to unknown requestKind");
  assert.equal(a.corpus.measuredUSD, 2, "an unjoined transcript's dollars are not the joined corpus's spend");
});

// § 5 defines unresolved as "the interval spans 1.0" and forbids an unmeasurable figure rendering
// as a hedge. A cell that spent money and accepted nothing is neither.
test("a cell that spent money and accepted nothing reports no-accepts, never unresolved", () => {
  const cheap = cell("h1", "bug", "claude-sonnet-5", Array(6).fill(1));
  const dear = cell("h2", "bug", "claude-opus-5", Array(6).fill(10), () => false);
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const opus = a.classes.find((c) => c.requestKind === "bug").comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "no-accepts", "the strongest premium-not-justified signal must not read as no data");
  assert.equal(opus.noAccepts, "compared");
  assert.equal(opus.interval, null, "there is no ratio to report, and inventing one would be the hedge");
  assert.equal(opus.cell.dispatches, 6);
  assert.equal(opus.cell.totalUSD, 60, "the dollars it did spend are still reported");
});

test("a comparator that accepted nothing is named as such, not reported as an unresolved ratio", () => {
  const cheap = cell("h1", "bug", "claude-sonnet-5", Array(6).fill(1), () => false);
  const dear = cell("h2", "bug", "claude-opus-5", Array(6).fill(10));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const opus = a.classes.find((c) => c.requestKind === "bug").comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "no-accepts");
  assert.equal(opus.noAccepts, "comparator", "the missing denominator is the comparator's, and the row says so");
  assert.equal(opus.interval, null);
});

// § 6's counting rule applied to the bootstrap's own discards: a resample where either cell drew
// zero accepts has no cost per accepted task and is skipped, so the interval is conditional on
// both cells accepting. The discard is directional, so its size has to be visible.
test("the bootstrap's discarded draws are counted alongside the interval", () => {
  const cheap = cell("h1", "feature", "claude-sonnet-5", Array(5).fill(1), (i) => i === 0);
  const dear = cell("h2", "feature", "claude-opus-5", Array(5).fill(4));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF,
  });
  const opus = a.classes.find((c) => c.requestKind === "feature").comparisons.find((c) => c.model === "claude-opus-5");
  assert.ok(opus.interval.discarded > 0, "a cell accepting 1 of 5 draws an all-rejected resample often");
  assert.equal(opus.interval.resamples, 2000);
  assert.equal(opus.interval.draws + opus.interval.discarded, 2000, "every draw is either kept or counted");
});

// Every baseline row reported `no-comparator`, which § 5 defines as "the class holds one priced
// cell" -- so the genuine one-cell case and the ordinary baseline were indistinguishable.
test("the class's own baseline row is distinguishable from a class with nothing to compare against", () => {
  const cheap = cell("h1", "feature", "claude-sonnet-5", Array(6).fill(1));
  const dear = cell("h2", "feature", "claude-opus-5", Array(6).fill(4));
  const alone = cell("h3", "chore", "claude-sonnet-5", Array(6).fill(1));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches, ...alone.dispatches],
    runRecords: records([cheap.entry, dear.entry, alone.entry]), ...CONF,
  });
  const baseline = a.classes.find((c) => c.requestKind === "feature").comparisons
    .find((c) => c.model === "claude-sonnet-5");
  assert.equal(baseline.state, "baseline", "this row IS the thing the others are compared against");
  const only = a.classes.find((c) => c.requestKind === "chore").comparisons[0];
  assert.equal(only.state, "no-comparator", "and this class genuinely has nothing to compare against");
  assert.equal(only.reason, "single-priced-cell");
});

// § 8: the dispatch record now carries the subagent's own transcript id, so attribution no longer
// depends on reading a task number out of a sidecar description.
test("task attribution prefers the recorded agentId and falls back to the description parse", () => {
  const byRecord = { ...row("h1", null, "claude-sonnet-5", 1), taskId: null,
    agentId: "agent-aaa", description: "Wire the renderer" };
  const byDescription = row("h1", "2", "claude-sonnet-5", 1);
  const runRecords = new Map([["h1", {
    runId: "r1", triage: { requestKind: "feature" }, workload: null,
    verdicts: [clean("1"), clean("2")],
    dispatches: [{ taskId: "1", agentId: "agent-aaa", retryIndex: 0, outcome: "complete" }],
  }]]);
  const a = routingAdvisories({ dispatches: [byRecord, byDescription], runRecords, ...CONF });
  assert.equal(a.exclusions.unparseableTask, 0,
    "a description with no task number is still attributable once the record carries the agentId");
  assert.equal(a.corpus.taskFromRecord, 1);
  assert.equal(a.corpus.taskFromDescription, 1);
  const c = a.cells.find((x) => x.model === "claude-sonnet-5");
  assert.equal(c.dispatches, 2);
  assert.equal(c.accepted, 2, "both dispatches reach their own round-1 verdict");
});

test("task attribution: a recorded agentId matches the transcript's filename form", () => {
  // The journal writes `agent-<hash>` (playbooks/executing-waves.md); a turn carries the bare
  // `<hash>`. Compared raw across that boundary the join silently never matches.
  const d = { ...row("h1", null, "claude-sonnet-5", 1), taskId: null, agentId: "agent-bbb" };
  const runRecords = new Map([["h1", {
    runId: "r1", triage: { requestKind: "feature" }, workload: null, verdicts: [clean("7")],
    dispatches: [{ taskId: "7", agentId: "bbb", retryIndex: 0, outcome: "complete" }],
  }]]);
  const a = routingAdvisories({ dispatches: [d], runRecords, ...CONF });
  assert.equal(a.corpus.taskFromRecord, 1, "the `agent-` prefix is reconciled, not compared raw");
  assert.equal(a.cells[0].accepted, 1);
});

test("task attribution: a record with no agentId never matches a dispatch with none either", () => {
  const d = { ...row("h1", null, "claude-sonnet-5", 1), taskId: null, agentId: null };
  const runRecords = new Map([["h1", {
    runId: "r1", triage: { requestKind: "feature" }, workload: null, verdicts: [clean("7")],
    dispatches: [{ taskId: "7", retryIndex: 0, outcome: "complete" }],
  }]]);
  const a = routingAdvisories({ dispatches: [d], runRecords, ...CONF });
  assert.equal(a.corpus.taskFromRecord, 0, "two absent ids are not a match");
  assert.equal(a.exclusions.unparseableTask, 1);
});

// § 14's boundary requirement: cells constructed so the interval falls just inside and just
// outside 1.0 under the fixed seed. The three state fixtures at the top of this file sit at
// [10, 10], [0.15, 0.60] and [0.75, 2.33] -- all far enough from the edge that a `>`/`>=` slip in
// verdictFor, or an off-by-one in the percentile index, moves none of them.
test("bootstrap boundary: an interval whose low bound IS 1.0 stays unresolved", () => {
  // 20 dispatches at $1 accepting 15, against 20 at $1.50 accepting 16. Measured under seed
  // 20260912 at 2000 resamples: exactly 50 ratios fall strictly below 1.0, the 2.5% index is 50,
  // and ratios[50] is 1.0 itself -- one draw either way moves the bound off the boundary. An
  // interval that touches 1.0 has not excluded it, so the honest verdict is unresolved.
  const cheap = cell("h1", "feature", "claude-sonnet-5", Array(20).fill(1), (i) => i < 15);
  const dear = cell("h2", "feature", "claude-opus-5", Array(20).fill(1.5), (i) => i < 16);
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF, comparatorFloor: 5,
  });
  const opus = a.classes.find((c) => c.requestKind === "feature").comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.interval.low, 1, "the fixture lands the bound exactly on 1.0");
  assert.equal(opus.state, "unresolved");
});

test("bootstrap boundary: an interval one order statistic above 1.0 separates", () => {
  // 20 at $1 accepting 14, against 20 at $2 accepting 19. Measured under the same seed: exactly 50
  // ratios are at or below 1.0 and the 2.5% index is 50, so the bound is the next order statistic
  // up (1.0526) while its neighbour one index below is exactly 1.0. One more draw at or below 1.0,
  // or an off-by-one in the percentile index, reports unresolved instead.
  const cheap = cell("h1", "feature", "claude-sonnet-5", Array(20).fill(1), (i) => i < 14);
  const dear = cell("h2", "feature", "claude-opus-5", Array(20).fill(2), (i) => i < 19);
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF, comparatorFloor: 5,
  });
  const opus = a.classes.find((c) => c.requestKind === "feature").comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "premium-not-justified");
  assert.ok(opus.interval.low > 1 && opus.interval.low < 1.06,
    `the bound clears 1.0 by one order statistic, got ${opus.interval.low}`);
});

test("bootstrap boundary: an interval whose high bound IS 1.0 stays unresolved", () => {
  // The same boundary on the other comparison: 15 at $1 accepting 7, against 15 at $1.50 accepting
  // all 15. Measured under the same seed, the 97.5% order statistic is exactly 1.0, so `high < 1`
  // is false and the verdict is unresolved -- an interval touching 1.0 is not a premium-justified.
  const cheap = cell("h1", "bug", "claude-sonnet-5", Array(15).fill(1), (i) => i < 7);
  const dear = cell("h2", "bug", "claude-opus-5", Array(15).fill(1.5));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF, comparatorFloor: 5,
  });
  const opus = a.classes.find((c) => c.requestKind === "bug").comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(opus.interval.high, 1, "the fixture lands the upper bound exactly on 1.0");
  assert.equal(opus.state, "unresolved");
});

// The comparator is the cheapest ELIGIBLE cell, so a below-floor cell can be cheaper than it on the
// very ranking that selects it. For those rows `ratio < 1` does not mean a premium paid off -- there
// is no premium -- so § 5's premium words must not be reachable from them.
test("direction: a cell cheaper than its comparator never reports a premium verdict", () => {
  const thin = cell("h1", "bug", "claude-haiku-4-5", [0.25, 0.25]);
  const baseline = cell("h2", "bug", "claude-sonnet-5", Array(8).fill(2), (i) => i < 6);
  const a = routingAdvisories({
    dispatches: [...thin.dispatches, ...baseline.dispatches],
    runRecords: records([thin.entry, baseline.entry]), ...CONF, comparatorFloor: 5,
  });
  const bug = a.classes.find((c) => c.requestKind === "bug");
  assert.equal(bug.cheapest, "claude-sonnet-5");
  const haiku = bug.comparisons.find((c) => c.model === "claude-haiku-4-5");
  assert.ok(haiku.interval.high < 1, "it costs less per accepted task, with the interval excluding 1.0");
  assert.equal(haiku.state, "costs-less-per-accepted",
    "the cheap cell winning is a route-down hint, not a justified premium");
  assert.equal(haiku.direction, "discount", "it is cheaper per dispatch than the cell it is compared against");
});

test("direction: a cheaper cell whose acceptance eats its saving reports costs-more-per-accepted", () => {
  const thin = cell("h1", "docs", "claude-haiku-4-5", Array(10).fill(1), (i) => i === 0);
  const baseline = cell("h2", "docs", "claude-sonnet-5", Array(12).fill(2));
  const a = routingAdvisories({
    dispatches: [...thin.dispatches, ...baseline.dispatches],
    runRecords: records([thin.entry, baseline.entry]), ...CONF, comparatorFloor: 12,
  });
  const docs = a.classes.find((c) => c.requestKind === "docs");
  assert.equal(docs.cheapest, "claude-sonnet-5");
  const haiku = docs.comparisons.find((c) => c.model === "claude-haiku-4-5");
  assert.ok(haiku.interval.low > 1, "it costs more per accepted task despite the lower per-dispatch price");
  assert.equal(haiku.state, "costs-more-per-accepted",
    "a cell that pays no premium cannot have one declared unjustified");
  assert.equal(haiku.direction, "discount");
});

test("direction: two identically priced cells make no premium claim in either direction", () => {
  // § 7's same-tier confound: the tie-break loser is priced exactly like the comparator, so the
  // comparison tests acceptance and token use alone. Calling that a premium verdict names a price
  // difference that does not exist.
  const sonnet = cell("h1", "chore", "claude-sonnet-5", Array(5).fill(2));
  const opus = cell("h2", "chore", "claude-opus-5", Array(5).fill(2), (i) => i === 0);
  const a = routingAdvisories({
    dispatches: [...sonnet.dispatches, ...opus.dispatches],
    runRecords: records([sonnet.entry, opus.entry]), ...CONF,
  });
  const chore = a.classes.find((c) => c.requestKind === "chore");
  assert.equal(chore.cheapest, "claude-sonnet-5");
  const compared = chore.comparisons.find((c) => c.model === "claude-opus-5");
  assert.equal(compared.state, "costs-more-per-accepted");
  assert.equal(compared.direction, "same-price");
});

test("direction: a genuinely pricier cell keeps § 5's premium wording", () => {
  const cheap = cell("h1", "feature", "claude-sonnet-5", Array(8).fill(1));
  const dear = cell("h2", "feature", "claude-opus-5", Array(8).fill(10));
  const a = routingAdvisories({
    dispatches: [...cheap.dispatches, ...dear.dispatches],
    runRecords: records([cheap.entry, dear.entry]), ...CONF, comparatorFloor: 5,
  });
  const opus = a.classes.find((c) => c.requestKind === "feature").comparisons
    .find((c) => c.model === "claude-opus-5");
  assert.equal(opus.state, "premium-not-justified");
  assert.equal(opus.direction, "premium");
});
