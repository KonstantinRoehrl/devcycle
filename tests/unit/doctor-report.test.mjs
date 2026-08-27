// The report layer of scripts/doctor.mjs: the table seams, the markdown renderer, and the
// issue draft. Split from doctor.test.mjs, which is already 1882 lines and covers the metric
// computation underneath. No real session transcript is ever read and no test touches gh.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeSession, journalEvents, cycleGroups, impactScores,
  versionProfileTable, stageByVersionTable, stageWindowTable, culpritTable, winTable, WIN_EVENTS,
  parseDraftedMarkers, outerLoop, compiledKnowledge, DEVCYCLE_UPSTREAM,
  renderReport, repoShape, issueBody, issueDraftLines, parseArgs, revertCandidates,
  recencyBand, lifecycle, StaleCulpritError, emitCandidates, formatCandidate,
  matchedCohorts, excessCost, workloadAdjustedSteps,
  changelogEntry, regressionAttribution,
} from "../../scripts/doctor.mjs";
import { verify, releaseDates, defaultRunCheck, installedVersion } from "../../scripts/verification.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const usage = (i, cw, cr, o) => ({
  input_tokens: i, cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr, output_tokens: o,
});

const turn = (over = {}) => ({
  sessionId: "sess-abcdef123456", isSidechain: false, type: "assistant",
  timestamp: "2026-07-20T10:00:00.000Z",
  message: { model: "claude-opus-5", usage: usage(10, 100, 1000, 20) },
  ...over,
});

// A run record shaped exactly as readRunRecords returns one: the run-line fields flattened
// onto the per-session window. Matches tests/fixtures/run-record.schema.json.
const record = (over = {}) => ({
  runId: "0123456789abcdef",
  pluginVersion: "0.12.0",
  profile: "thorough",
  knobs: {},
  stages: [{ stage: "execution", startedAt: "2026-07-20T09:00:00.000Z", endedAt: "2026-07-20T11:00:00.000Z", outcome: "complete" }],
  dispatches: [{ taskId: "1", agentType: "devcycle:implementer", model: "claude-opus-5", modelSource: "explicit", startedAt: "2026-07-20T09:30:00.000Z", endedAt: "2026-07-20T10:30:00.000Z", outcome: "complete", reviewRound: 1, retryIndex: 0 }],
  verdicts: [],
  events: [],
  ...over,
});

const withRecord = (rec, sessionId = "sess-abcdef123456", records = [turn()]) =>
  summarizeSession(sessionId, records, new Map([[sha256(sessionId), rec]]));

test("journalEvents concatenates the journal with the derived signals", () => {
  const rec = record({
    events: [{ kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: "partial-evidence-capture", ts: "2026-07-20T10:00:00.000Z" }],
    verdicts: [{ taskId: "1", round: 1, blockingCount: 0, evidenceClass: "red-green", conformance: "pass" }],
  });
  const evs = journalEvents(rec);
  assert.deepEqual(evs.map((e) => e.event).sort(), ["first-round-accept", "gate-fail"]);
});

test("journalEvents returns nothing for a record-less session rather than throwing", () => {
  assert.deepEqual(journalEvents(null), []);
  assert.deepEqual(journalEvents(undefined), []);
});

test("impactScores reads the same event set journalEvents returns — one owner, no second walk", () => {
  const rec = record({
    events: [{ kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: null, ts: "2026-07-20T10:00:00.000Z" }],
  });
  const keys = impactScores(rec, { execution: 4 }).map((r) => r.key);
  const expected = [...new Set(journalEvents(rec).map((e) => `${e.event}:${e.stage}`))];
  assert.deepEqual(keys.sort(), expected.sort());
});

test("a summary carries the run id, so a cycle can be reconstructed after the fact", () => {
  assert.equal(withRecord(record()).runId, "0123456789abcdef");
});

test("a record-less summary carries a null run id, never a fabricated one", () => {
  assert.equal(summarizeSession("sess-abcdef123456", [turn()]).runId, null);
});

test("a summary carries its impact scores, and null when there is no record to score", () => {
  const s = withRecord(record({
    events: [{ kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: null, ts: "2026-07-20T10:00:00.000Z" }],
  }));
  assert.ok(Array.isArray(s.impact));
  assert.ok(s.impact.some((r) => r.event === "gate-fail"));
  assert.equal(summarizeSession("sess-abcdef123456", [turn()]).impact, null);
});

test("a summary carries the culprit slugs each impact key's events named", () => {
  const s = withRecord(record({
    events: [
      { kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: "partial-evidence-capture", ts: "2026-07-20T10:00:00.000Z" },
      { kind: "event", event: "gate-fail", stage: "execution", task: "2", culprit: "partial-evidence-capture", ts: "2026-07-20T10:05:00.000Z" },
    ],
  }));
  assert.deepEqual(s.culpritsByKey["gate-fail:execution"], ["partial-evidence-capture"]);
});

test("an event with no culprit slug contributes no key rather than an empty-string slug", () => {
  const s = withRecord(record({
    events: [{ kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: null, ts: "2026-07-20T10:00:00.000Z" }],
  }));
  assert.equal(s.culpritsByKey["gate-fail:execution"], undefined);
});

test("cycleGroups folds every session of one run into a single cycle", () => {
  const groups = cycleGroups([
    { id: "aaaaaaaa", runId: "0123456789abcdef", costUSD: 1 },
    { id: "bbbbbbbb", runId: "0123456789abcdef", costUSD: 2 },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sessions.sort(), ["aaaaaaaa", "bbbbbbbb"]);
  assert.equal(groups[0].cost, 3);
});

test("a session joining no run record is its own cycle, never merged with the other record-less ones", () => {
  const groups = cycleGroups([
    { id: "aaaaaaaa", runId: null, costUSD: 1 },
    { id: "bbbbbbbb", runId: null, costUSD: 2 },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.cost).sort(), [1, 2]);
});

// A summary carrying only the fields the table under test reads. Hand-built rather than routed
// through summarizeSession, so a table's inputs are visible in the test that pins its output.
const sum = (over = {}) => ({
  id: "aaaaaaaa", runId: null, costUSD: 1, costByStage: { execution: 1 },
  pluginVersion: "0.12.0", profile: "thorough", medianDepth: 40000, quality: null,
  inFlight: false, impact: null, culpritsByKey: {}, ...over,
});

test("versionProfileTable splits one version into a row per profile", () => {
  const rows = versionProfileTable([
    sum({ id: "a", profile: "thorough" }), sum({ id: "b", profile: "lean" }),
  ]);
  assert.deepEqual(rows.map((r) => `${r.version}/${r.profile}`).sort(), ["0.12.0/lean", "0.12.0/thorough"]);
});

test("a version×profile row with fewer than three sessions is low confidence", () => {
  const [row] = versionProfileTable([sum(), sum({ id: "b" })]);
  assert.equal(row.sessions, 2);
  assert.equal(row.lowConfidence, true);
});

test("a low-confidence row is used on neither side of a delta", () => {
  const rows = versionProfileTable([
    // 0.11.0/thorough: 3 sessions, comparable. 0.12.0/thorough: 2 sessions, not.
    sum({ id: "a", pluginVersion: "0.11.0" }), sum({ id: "b", pluginVersion: "0.11.0" }),
    sum({ id: "c", pluginVersion: "0.11.0" }),
    sum({ id: "d" }), sum({ id: "e" }),
  ]);
  const newest = rows.find((r) => r.version === "0.12.0");
  assert.equal(newest.delta.state, "not-compared");
  assert.equal(newest.delta.pct, null);
});

test("a row with no older same-profile row reads first-seen, not a zero delta", () => {
  const [row] = versionProfileTable([sum(), sum({ id: "b" }), sum({ id: "c" })]);
  assert.equal(row.delta.state, "first-seen");
  assert.equal(row.delta.pct, null);
});

test("a delta is computed when both sides carry three or more sessions", () => {
  const old = [1, 2, 3].map((n) => sum({ id: `o${n}`, pluginVersion: "0.11.0", costUSD: 10, costByStage: { execution: 10 } }));
  const now = [1, 2, 3].map((n) => sum({ id: `n${n}`, costUSD: 5, costByStage: { execution: 5 } }));
  const row = versionProfileTable([...old, ...now]).find((r) => r.version === "0.12.0");
  assert.equal(row.delta.state, "compared");
  assert.equal(Math.round(row.delta.pct), -50);
});

test("a session with no extractable version renders under unknown and keeps its cost", () => {
  const rows = versionProfileTable([
    sum({ costUSD: 7, costByStage: { execution: 7 } }),
    sum({ id: "b", pluginVersion: "unknown", costUSD: 11, costByStage: { execution: 11 } }),
  ]);
  const unknown = rows.find((r) => r.version === "unknown");
  assert.ok(unknown, "the unknown-version cohort was dropped");
  assert.equal(unknown.sessions, 1);
  // Its cost survives into the row rather than being silently excluded from the totals.
  assert.equal(unknown.medianCostPerCycle, 11);
  assert.equal(rows.reduce((n, r) => n + r.medianCostPerCycle, 0), 18);
  // Ordered last, so it never sits between two real versions.
  assert.equal(rows[rows.length - 1].version, "unknown");
});

test("a session with no run record renders under profile unknown rather than being dropped", () => {
  const rows = versionProfileTable([sum({ profile: "unknown" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].profile, "unknown");
});

test("cost per cycle is per cycle, not per session", () => {
  // Two sessions of one run are one $6 cycle, not two $3 sessions.
  const [row] = versionProfileTable([
    sum({ id: "a", runId: "0123456789abcdef", costUSD: 3 }),
    sum({ id: "b", runId: "0123456789abcdef", costUSD: 3 }),
  ]);
  assert.equal(row.cycles, 1);
  assert.equal(row.medianCostPerCycle, 6);
});

test("the priciest stage is the largest summed cost inside the row", () => {
  const [row] = versionProfileTable([sum({ costByStage: { execution: 1, planning: 9 } })]);
  assert.equal(row.priciestStage, "planning");
});

test("shipped names the culprits a version shipped, and only that version's", () => {
  const [row] = versionProfileTable([sum()], [
    { pluginVersion: "0.12.0", culpritId: "partial-evidence-capture" },
    { pluginVersion: "0.11.0", culpritId: "reviewer-role-confusion" },
  ]);
  assert.deepEqual(row.shipped, ["partial-evidence-capture"]);
});

test("a promotion carrying no culprit id contributes nothing rather than an empty entry", () => {
  // What today's records look like: recordPromotion does not write culprit-id yet, so the
  // column is empty because the data is, not because the parser cannot see the field.
  const [row] = versionProfileTable([sum()], [{ pluginVersion: "0.12.0", culpritId: null }]);
  assert.deepEqual(row.shipped, []);
});

test("versionProfileTable emits stratified $/turn that reconstructs cost, never blended", () => {
  const s = sum({ id:"aaaa", runId:"r".repeat(16), pluginVersion:"0.14.3", profile:"thorough",
    costUSD:15, mainTurns:100, subagentTurns:50,
    costByAgentType:{ main:10, subagent:5 } });
  const [row] = versionProfileTable([s]);
  assert.ok("dollarsPerMainTurn" in row && "dollarsPerSubTurn" in row);
  assert.ok(!("dollarsPerTurn" in row));
  assert.ok(Math.abs(row.dollarsPerMainTurn - 10/100) < 1e-9);
  assert.ok(Math.abs(row.dollarsPerSubTurn - 5/50) < 1e-9);
});

test("excessCost is a residual vs the matched cohort, and size-1 cohorts get no expectation", () => {
  const mk = (id, cost) => ({ runId:id.padEnd(16,"0"), version:"0.14.3", profile:"thorough",
    requestKind:"feature", workloadBand:"M", costUSD:cost, mainTurns:1, subagentTurns:0 });
  const runs = [mk("a",10), mk("b",12), mk("c",30)];        // one M-feature-thorough cohort, n=3
  const res = excessCost(runs);
  const c = res.find((r) => r.runId.startsWith("c"));
  assert.equal(c.expected, 12);                              // median(10,12,30)
  assert.equal(c.excess, 18);
  assert.equal(c.confidence, "low");                         // 2<=n<5
  const solo = excessCost([mk("z",99)])[0];
  assert.equal(solo.expected, null);
  assert.equal(solo.confidence, "insufficient");
});

test("matchedCohorts groups only runs carrying both a requestKind and a workload band", () => {
  const mk = (id, over) => ({ runId:id.padEnd(16,"0"), version:"0.14.3", profile:"thorough",
    requestKind:"feature", workloadBand:"M", costUSD:1, ...over });
  const cohorts = matchedCohorts([
    mk("a"), mk("b"),
    mk("c", { requestKind: null }),          // observational — no requestKind
    mk("d", { workloadBand: null }),         // observational — no band
  ]);
  assert.deepEqual([...cohorts.keys()], ["thorough|feature|M"]);
  assert.equal(cohorts.get("thorough|feature|M").length, 2);
});

test("workloadAdjustedSteps emits a delta only where both adjacent versions have >=2 matched runs", () => {
  const mk = (id, version, cost) => ({ runId:id.padEnd(16,"0"), version, profile:"thorough",
    requestKind:"feature", workloadBand:"M", costUSD:cost, mainTurns:10, subagentTurns:4,
    medianDepth:40000, conformancePass:true });
  const band = ["0.14.2", "0.14.3"];
  const runs = [
    mk("a","0.14.2",10), mk("b","0.14.2",10),
    mk("c","0.14.3",12), mk("d","0.14.3",12),
  ];
  const [step] = workloadAdjustedSteps(runs, band);
  assert.equal(step.from, "0.14.2");
  assert.equal(step.to, "0.14.3");
  assert.equal(step.matchKey, "thorough|feature|M");
  assert.ok(Math.abs(step.costDeltaPct - 20) < 1e-9);
  assert.equal(step.n, 2);
  assert.equal(step.confidence, "low");
  // A single run on one side fabricates no delta.
  assert.deepEqual(workloadAdjustedSteps(runs.slice(0, 3), band), []);
});

test("stageByVersionTable renders at most the six most recent versions, oldest first", () => {
  const summaries = ["0.6.0", "0.7.0", "0.8.0", "0.9.0", "0.10.0", "0.11.0", "0.12.0"]
    .map((v, i) => sum({ id: `s${i}`, pluginVersion: v }));
  const t = stageByVersionTable(summaries);
  assert.equal(t.versions.length, 6);
  assert.deepEqual(t.versions, ["0.7.0", "0.8.0", "0.9.0", "0.10.0", "0.11.0", "0.12.0"]);
});

test("a stage carried by fewer than two versions has insufficient data, not a flat trend", () => {
  const t = stageByVersionTable([sum({ costByStage: { execution: 5 } })]);
  assert.equal(t.rows.find((r) => r.stage === "execution").trend, "insufficient data");
});

test("a stage that halved across the rendered versions trends down", () => {
  const t = stageByVersionTable([
    sum({ id: "a", pluginVersion: "0.11.0", costByStage: { execution: 10 } }),
    sum({ id: "b", pluginVersion: "0.12.0", costByStage: { execution: 5 } }),
  ]);
  assert.equal(t.rows.find((r) => r.stage === "execution").trend, "down");
});

test("a stage that moved less than five percent is flat", () => {
  const t = stageByVersionTable([
    sum({ id: "a", pluginVersion: "0.11.0", costByStage: { execution: 100 } }),
    sum({ id: "b", pluginVersion: "0.12.0", costByStage: { execution: 102 } }),
  ]);
  assert.equal(t.rows.find((r) => r.stage === "execution").trend, "flat");
});

test("trend vs previous window reads n/a with no window, never a fabricated zero", () => {
  const rows = stageWindowTable([sum({ costByStage: { execution: 4 } })], null);
  assert.equal(rows[0].trend, "n/a (no window)");
});

test("trend vs previous window compares against the preceding window when there is one", () => {
  const rows = stageWindowTable(
    [sum({ costByStage: { execution: 5 } })],
    [sum({ id: "p", costByStage: { execution: 10 } })],
  );
  assert.equal(rows[0].trend, "down");
});

test("a stage absent from the previous window reads first seen, not a 100% rise", () => {
  const rows = stageWindowTable(
    [sum({ costByStage: { planning: 5 } })],
    [sum({ id: "p", costByStage: { execution: 10 } })],
  );
  assert.equal(rows.find((r) => r.stage === "planning").trend, "first seen");
});

test("stage percentages of the window sum to one hundred", () => {
  const rows = stageWindowTable([sum({ costByStage: { execution: 3, planning: 1 } })], null);
  assert.equal(Math.round(rows.reduce((n, r) => n + r.pctOfWindow, 0)), 100);
});

const VOCAB = [
  { slug: "partial-evidence-capture", kind: "friction", desc: "Captured evidence covered less than the whole verification gate command." },
  { slug: "first-round-clean-accept", kind: "win", desc: "A task passed review and the green gate on its first round, with no rework." },
];

test("culpritTable prices a culprit from impactScores and names it from the vocabulary", () => {
  const rows = culpritTable([sum({
    impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 2, impact: 6 }],
    culpritsByKey: { "gate-fail:execution": ["partial-evidence-capture"] },
  })], VOCAB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].culprit, "partial-evidence-capture");
  assert.equal(rows[0].kind, "friction");
  assert.equal(rows[0].impact, 6);
  assert.equal(rows[0].occurrences, 2);
});

test("a culprit with no vocabulary slug is still offered, keyed by event and stage", () => {
  const rows = culpritTable([sum({
    impact: [{ key: "review-reject:execution", event: "review-reject", stage: "execution", frequency: 1, impact: 2 }],
  })], VOCAB);
  assert.equal(rows[0].culprit, "review-reject:execution");
  assert.equal(rows[0].kind, "unclassified");
});

test("an unmeasurable impact stays null and sorts last, never zero", () => {
  const rows = culpritTable([sum({
    impact: [
      { key: "review-reject:execution", event: "review-reject", stage: "execution", frequency: 1, impact: null },
      { key: "re-dispatch:planning", event: "re-dispatch", stage: "planning", frequency: 1, impact: 3 },
    ],
  })], VOCAB);
  assert.equal(rows[0].impact, 3);
  assert.equal(rows[1].impact, null);
});

test("win events go to the wins table and never to the culprits table", () => {
  const summaries = [sum({
    impact: [{ key: "first-round-accept:execution", event: "first-round-accept", stage: "execution", frequency: 3, impact: 9 }],
  })];
  assert.deepEqual(culpritTable(summaries, VOCAB), []);
  const wins = winTable(summaries, VOCAB, []);
  assert.equal(wins[0].occurrences, 3);
  assert.equal(wins[0].impact, 9);
});

test("WIN_EVENTS names the classification once rather than leaving it to each render site", () => {
  assert.ok(WIN_EVENTS.has("gate-pass-clean"));
  assert.ok(WIN_EVENTS.has("first-round-accept"));
  assert.ok(!WIN_EVENTS.has("gate-fail"));
});

test("culprit impact figures come from impactScores and from no second formula", () => {
  // Spec §10 case 10, and the Global Constraint it enforces. The table's dollar figure is
  // compared against impactScores' own output for the same record, so a second formula quietly
  // growing beside it fails here rather than in a report nobody can reconcile.
  const rec = record({
    events: [
      { kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: "partial-evidence-capture", ts: "2026-07-20T10:00:00.000Z" },
      { kind: "event", event: "gate-fail", stage: "execution", task: "2", culprit: "partial-evidence-capture", ts: "2026-07-20T10:05:00.000Z" },
    ],
  });
  const s = withRecord(rec);
  const expected = impactScores(rec, s.costByStage).find((r) => r.key === "gate-fail:execution");
  const [row] = culpritTable([s], VOCAB);
  assert.equal(row.impact, expected.impact);
  assert.equal(row.occurrences, expected.frequency);
});

test("the cross-version culprit delta is per-session, so more sessions alone is not a regression", () => {
  // Same culprit, equal per-session impact ($10) on both versions, but version B ran four times
  // as many sessions. The version-over-version delta must read ~0, not the +166% a summed total
  // would show — while the ranking/display impact still reflects the totals (30 + 80).
  const mk = (id, version) => sum({
    id, pluginVersion: version,
    impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 1, impact: 10 }],
    culpritsByKey: { "gate-fail:execution": ["culprit-x"] },
  });
  const a = [1, 2, 3].map((n) => mk(`a${n}`, "0.11.0"));
  const b = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => mk(`b${n}`, "0.12.0"));
  const [row] = culpritTable([...a, ...b], []);
  assert.equal(row.delta.state, "compared");
  assert.ok(Math.abs(row.delta.pct) < 1e-9, `expected ~0 per-session delta, got ${row.delta.pct}`);
  assert.equal(row.impact, 110);   // summed total, ranking value unchanged (GC1)
});

test("lifecycle classifies by occurrence versions against the band", () => {
  const dates = new Map([["0.12.0","2026-08-05"],["0.13.0","2026-08-10"],["0.14.0","2026-08-15"],
    ["0.14.1","2026-08-18"],["0.14.2","2026-08-20"],["0.14.3","2026-08-21"]]);
  const band = recencyBand("0.14.3", dates, 2);  // [0.14.1,0.14.2,0.14.3]
  assert.deepEqual(band, ["0.14.1", "0.14.2", "0.14.3"]);
  assert.equal(lifecycle(["0.14.2","0.14.3"], band, dates), "active");
  assert.equal(lifecycle(["0.14.3"], band, dates), "active");
  assert.equal(lifecycle(["0.12.0","0.14.1"], band, dates), "active"); // one in band
  assert.equal(lifecycle(["0.14.0"], band, dates), "unresolved");      // immediate pre-band
  assert.equal(lifecycle(["0.12.0"], band, dates), "legacy");          // far pre-band
});

test("emitCandidates gives a depth-outlier a version range and formatCandidate renders it", () => {
  const s = sum({ pluginVersion: "0.13.0", startupFloor: { main: [10000] }, medianDepth: 40000 });
  const depth = emitCandidates([s]).find((c) => c.type === "depth-outlier");
  assert.ok(depth, "no depth-outlier candidate");
  assert.deepEqual(depth.versions, ["0.13.0", "0.13.0"]);
  const line = formatCandidate(depth);
  assert.match(line, /versions=\[/);
  assert.match(line, /0\.13\.0/);
});

test("a version-improvement candidate is a win, not a neutral candidate", () => {
  const wins = winTable([sum()], VOCAB, [
    { type: "version-improvement", skill: "execution", version_from: "0.11.0", version_to: "0.12.0", delta_pct: -40, delta_dollars: -12, sessions_sampled: 4 },
    { type: "version-regression", skill: "planning", version_from: "0.11.0", version_to: "0.12.0", delta_pct: 40, delta_dollars: 12, sessions_sampled: 4 },
  ]);
  assert.equal(wins.length, 1);
  assert.match(wins[0].win, /execution/);
  assert.equal(wins[0].impact, 12);
});

const GH_RESPONSE = JSON.stringify([
  { number: 7, title: "[culprit:partial-evidence-capture] evidence capture", labels: [{ name: "from-doctor" }, { name: "culprit:partial-evidence-capture" }], createdAt: "2026-08-01T00:00:00Z", closedAt: "2026-08-07T00:00:00Z", state: "CLOSED" },
  { number: 8, title: "[culprit:reviewer-role-confusion] roles", labels: [{ name: "from-doctor" }, { name: "culprit:reviewer-role-confusion" }], createdAt: "2026-08-03T00:00:00Z", closedAt: null, state: "OPEN" },
]);

function reportsFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-reports-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

test("parseDraftedMarkers reads the slug and title out of the marker line", () => {
  const found = parseDraftedMarkers("prose\nDrafted: [culprit:partial-evidence-capture] Evidence capture is partial\nmore prose\n");
  assert.deepEqual(found, [{ slug: "partial-evidence-capture", title: "Evidence capture is partial" }]);
});

test("parseDraftedMarkers ignores prose that merely mentions the word drafted", () => {
  assert.deepEqual(parseDraftedMarkers("We drafted an issue about culprit: things\n"), []);
});

// Spec §8: the flow offers a draft for every culprit, not only vocabulary members — so
// issueBody writes `novel:` slugs and bare `event:stage` keys into the marker's title. A parser
// that cannot read them back drops those drafts from the Drafted count without saying so.
test("parseDraftedMarkers reads back every slug shape the issue draft can write", () => {
  assert.deepEqual(
    parseDraftedMarkers([
      "Drafted: [culprit:partial-evidence-capture] Evidence capture is partial",
      "Drafted: [culprit:novel:evidence-drift] A culprit no vocabulary names",
      "Drafted: [culprit:review-reject:execution] Reviews reject execution work",
      "",
    ].join("\n")),
    [
      { slug: "partial-evidence-capture", title: "Evidence capture is partial" },
      { slug: "novel:evidence-drift", title: "A culprit no vocabulary names" },
      { slug: "review-reject:execution", title: "Reviews reject execution work" },
    ],
  );
});

test("the slug stops at the closing bracket rather than swallowing it", () => {
  assert.deepEqual(
    parseDraftedMarkers("Drafted: [culprit:stale-brief] A title with a ] in it\n"),
    [{ slug: "stale-brief", title: "A title with a ] in it" }],
  );
});

// The playbook states the marker inside an indented fenced block, so a marker copied from it
// verbatim carries leading whitespace.
test("a marker indented as the playbook states it still parses", () => {
  assert.deepEqual(
    parseDraftedMarkers("   Drafted: [culprit:stale-brief] Briefs go stale\n"),
    [{ slug: "stale-brief", title: "Briefs go stale" }],
  );
});

test("releaseDates reads a version's date off the dated changelog heading", () => {
  const dates = releaseDates("# Changelog\n\n## 0.12.0 — 2026-08-07\n\n- feat\n\n## 0.11.0 — 2026-08-05\n\n- fix\n");
  assert.equal(dates.get("0.12.0"), "2026-08-07");
  assert.equal(dates.get("0.11.0"), "2026-08-05");
});

test("releaseDates omits an undated heading rather than inventing a date for it", () => {
  assert.equal(releaseDates("# Changelog\n\n## 0.1.0\n\n- feat\n").get("0.1.0"), undefined);
});

test("outerLoop counts the distinct culprits drafted across persisted reports", () => {
  const dir = reportsFixture({
    "2026-08-01-report.md": "Drafted: [culprit:partial-evidence-capture] one\n",
    // The re-drafted culprit below carries the same title as its first marker — culpritTitle is
    // deterministic per slug, so a real re-draft of the same culprit always repeats it verbatim.
    "2026-08-08-report.md": "Drafted: [culprit:reviewer-role-confusion] two\nDrafted: [culprit:partial-evidence-capture] one\n",
  });
  try {
    // Three marker lines, two culprits.
    assert.equal(outerLoop(dir, () => GH_RESPONSE).drafted, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The marker records drafting rather than posting, so one culprit drafted, declined at a gate and
// drafted again writes two marker lines for what is still one drafted culprit — and a run that
// re-offers a recurring culprit in a later report writes another. Counting lines inflates Drafted
// against Filed, which is the one comparison this section exists to support.
test("a culprit drafted twice counts once, so Drafted cannot outrun Filed by re-drafting", () => {
  const dir = reportsFixture({
    "2026-08-01-report.md":
      "Drafted: [culprit:partial-evidence-capture] Evidence capture is partial\n" +
      "Drafted: [culprit:partial-evidence-capture] Evidence capture is partial\n",
  });
  try {
    assert.equal(outerLoop(dir, () => GH_RESPONSE).drafted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// D-4: Drafted is an issue count, matching Filed and Resolved. The dedup above still holds — a
// re-drafted culprit is one draft — but the key is the draft, not the culprit alone, so two
// genuinely different issues opened for the same culprit are two drafts.
test("Drafted counts issues: two different issues for one culprit count twice", () => {
  const dir = reportsFixture({
    "2026-08-01-report.md":
      "Drafted: [culprit:friction:x] evidence tail truncated\n" +
      "Drafted: [culprit:friction:x] evidence file missing entirely\n",
  });
  try {
    assert.equal(outerLoop(dir, () => "[]").drafted, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Drafted still counts one draft once when its marker is repeated verbatim", () => {
  const dir = reportsFixture({
    "2026-08-01-report.md":
      "Drafted: [culprit:friction:x] evidence tail truncated\n" +
      "Drafted: [culprit:friction:x] evidence tail truncated\n",
  });
  try {
    assert.equal(
      outerLoop(dir, () => "[]").drafted, 1,
      "one culprit drafted, declined at a gate and drafted again is one draft, not two",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outerLoop queries devcycle's upstream, never the ambient repo, and filters by no label", () => {
  const dir = reportsFixture({});
  const seen = [];
  try {
    outerLoop(dir, (args) => { seen.push(args); return GH_RESPONSE; });
    const argv = seen[0];
    const i = argv.indexOf("--repo");
    assert.ok(i !== -1, "gh was invoked without --repo, so it resolves to the host repo");
    assert.equal(argv[i + 1], DEVCYCLE_UPSTREAM);
    assert.ok(argv.includes("--author") && argv.includes("@me"));
    // A label filter can never match for a filer without push access on the upstream: GitHub
    // drops the labels such a user supplies, so the query would return nothing for the very
    // people this loop exists to serve.
    assert.ok(
      !argv.includes("--label"),
      "the query still filters by a label only a maintainer can apply, so Filed reads zero for everyone else",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failing gh renders unavailable, never zero", () => {
  const dir = reportsFixture({ "2026-08-01-report.md": "Drafted: [culprit:x] one\n" });
  try {
    const r = outerLoop(dir, () => { const e = new Error("gh: command not found"); e.code = "ENOENT"; throw e; });
    assert.equal(r.filed, "unavailable");
    assert.equal(r.resolved, "unavailable");
    assert.equal(r.medianTurnaroundDays, "unavailable");
    // Drafted comes from local files, so it still renders.
    assert.equal(r.drafted, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gh returning something that is not JSON renders unavailable rather than throwing", () => {
  const dir = reportsFixture({});
  try {
    assert.equal(outerLoop(dir, () => "gh: not logged in").filed, "unavailable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing reports directory is no drafts, not a crash", () => {
  assert.equal(outerLoop(join(tmpdir(), "doctor-reports-absent-xyz"), () => GH_RESPONSE).drafted, 0);
});

// Spec §12: filed/resolved/turnaround render from a fixture gh response, never from the network.
// The vocabulary is injected on the same principle as the gh runner — references/culprits.json
// carries no `resolved-in:` today, so the resolved and turnaround arithmetic would otherwise run
// in no test at all.
//
// Release dates come from this repo's own CHANGELOG.md, whose 0.12.0 heading is dated
// 2026-08-07; each createdAt below is that date minus the turnaround it is meant to produce.
const TURNAROUND_VOCAB = [
  { slug: "partial-evidence-capture", kind: "friction", "resolved-in": "0.12.0" },
  { slug: "reviewer-role-confusion", kind: "friction", "resolved-in": "0.12.0" },
  { slug: "stale-brief", kind: "friction", "resolved-in": "0.12.0" },
  { slug: "fixed-but-unreleased", kind: "friction", "resolved-in": "99.0.0" },
  { slug: "still-open", kind: "friction" },
];

// A slug of null is an issue the author opened by hand: no `[culprit:…]` title prefix, and so no
// business in a count of what this report produced. The query carries no label filter any more,
// so every issue the author ever opened on the upstream comes back and the title is what sorts
// them.
const issue = (number, slug, createdAt) => ({
  number,
  title: slug ? `[culprit:${slug}] an issue` : "an issue this author filed by hand",
  labels: slug ? [{ name: "from-doctor" }, { name: `culprit:${slug}` }] : [],
  createdAt,
  closedAt: null,
  state: "OPEN",
});

const TURNAROUND_ISSUES = JSON.stringify([
  issue(1, "partial-evidence-capture", "2026-08-05T00:00:00Z"), // 2 days to 0.12.0
  issue(2, "reviewer-role-confusion", "2026-07-28T00:00:00Z"), // 10 days to 0.12.0
  issue(3, "stale-brief", "2026-07-08T00:00:00Z"), // 30 days to 0.12.0
  issue(4, "fixed-but-unreleased", "2026-08-01T00:00:00Z"), // resolved, but 99.0.0 has no date
  issue(5, "still-open", "2026-08-01T00:00:00Z"), // no resolved-in
  issue(6, null, "2026-08-01T00:00:00Z"), // not from this report at all
]);

test("outerLoop counts the issues this report produced, resolves the ones the vocabulary marks fixed, and medians their turnaround", () => {
  const dir = reportsFixture({});
  try {
    const r = outerLoop(dir, () => TURNAROUND_ISSUES, TURNAROUND_VOCAB);
    // Five of the six carry the title prefix; the hand-filed one is not this report's work.
    assert.equal(r.filed, 5);
    // The three dated ones plus the one fixed in an undated release; the other two are not fixed.
    assert.equal(r.resolved, 4);
    // Median of 2, 10 and 30 days — not their mean, which would be 14.
    assert.equal(r.medianTurnaroundDays, 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The filer this loop exists to serve has no push access on the upstream, so their issue carries
// no labels at all — GitHub drops the ones they supply. Everything the section counts therefore
// has to be readable from the title, which is the one part of the draft they can always set.
test("an issue filed with no labels still counts and still resolves, read from its title", () => {
  const dir = reportsFixture({});
  const unlabelled = JSON.stringify([{
    number: 9, title: "[culprit:partial-evidence-capture] evidence capture",
    labels: [], createdAt: "2026-08-05T00:00:00Z", closedAt: null, state: "OPEN",
  }]);
  try {
    const r = outerLoop(dir, () => unlabelled, TURNAROUND_VOCAB);
    assert.equal(r.filed, 1);
    assert.equal(r.resolved, 1);
    assert.equal(r.medianTurnaroundDays, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an issue whose culprit is not marked fixed is excluded, never counted as an infinite turnaround", () => {
  const dir = reportsFixture({});
  try {
    const r = outerLoop(dir, () => JSON.stringify([issue(5, "still-open", "2026-08-01T00:00:00Z")]), TURNAROUND_VOCAB);
    assert.equal(r.filed, 1);
    assert.equal(r.resolved, 0);
    // null, not 0 and not "unavailable": gh answered, and no resolved culprit had a dated release.
    assert.equal(r.medianTurnaroundDays, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gh answering with JSON that is not a list of issues renders unavailable, never a count", () => {
  const dir = reportsFixture({});
  try {
    const r = outerLoop(dir, () => JSON.stringify({ message: "Not Found" }), TURNAROUND_VOCAB);
    assert.equal(r.filed, "unavailable");
    assert.equal(r.resolved, "unavailable");
    assert.equal(r.medianTurnaroundDays, "unavailable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compiled knowledge renders no rows and says why when no record carries a rung", () => {
  // A promotion parsed by readPromotions but predating rung: is a record with rung === null — it
  // contributes no row, and the note still names what fills the table in.
  const ck = compiledKnowledge([
    { culpritId: null, rung: null, pluginVersion: "0.12.0", lifecycle: null },
  ]);
  assert.deepEqual(ck.rows, []);
  assert.match(ck.note, /rung/);
});

test("compiled knowledge on no promotions renders the same no-data state", () => {
  const ck = compiledKnowledge([]);
  assert.deepEqual(ck.rows, []);
  assert.match(ck.note, /rung/);
});

test("compiled knowledge groups landed lessons by version and rung, excluding retired records", () => {
  const ck = compiledKnowledge([
    { culpritId: "friction:a", rung: "r2", pluginVersion: "0.12.0", lifecycle: null },
    { culpritId: "friction:b", rung: "r2", pluginVersion: "0.12.0", lifecycle: null },
    { culpritId: "friction:c", rung: "r3", pluginVersion: "0.12.0", lifecycle: null },
    // A retired lesson is a lifecycle record: counted as retired, never as a standing lesson.
    { culpritId: "friction:a", rung: "r2", pluginVersion: "0.12.0", lifecycle: "retirement", landed: "2026-07-01", at: "2026-08-10" },
  ]);
  const r2 = ck.rows.find((r) => r.rung === "r2");
  assert.equal(r2.version, "0.12.0");
  assert.equal(r2.lessons, 2);
  assert.ok(ck.rows.some((r) => r.rung === "r3" && r.lessons === 1));
});

// --- the markdown report ---

// A real fixture promotions set + journal, run through the shared verification engine so the
// "Previously promoted" section renders engine output rather than a mock. r2 recurred (escalates),
// r1 held, r2 unmeasurable (no run after it landed), r3 broken (a verify command that exits
// non-zero) — one of each of the four verdict words the section renders.
const PROMOTED_PROMOTIONS = [
  { culpritId: "friction:recurred-one", rung: "r2", landed: "2026-07-01", lifecycle: null, aliases: [] },
  { culpritId: "friction:held-one", rung: "r1", landed: "2026-07-01", lifecycle: null, aliases: [] },
  { culpritId: "friction:unmeasured-one", rung: "r2", landed: "2026-08-20", lifecycle: null, aliases: [] },
  { culpritId: "friction:broken-one", rung: "r3", verify: "false", landed: "2026-07-01", lifecycle: null, aliases: [] },
];
const PROMOTED_JOURNAL = [
  { event: "gate-fail", culprit: "recurred-one", ts: "2026-07-15T10:00:00.000Z", runId: "run-1" },
];
const PROMOTED_VERIFICATION = verify(PROMOTED_PROMOTIONS, PROMOTED_JOURNAL, "0.14.0", { runCheck: defaultRunCheck });

const ctx = (over = {}) => ({
  repo: "devcycle", today: "2026-08-13", scope: "every devcycle-tagged session",
  previousSummaries: null, vocab: VOCAB, promotions: [],
  outerLoop: { drafted: 0, draftedSince: "0.13.0", filed: "unavailable", resolved: "unavailable", medianTurnaroundDays: "unavailable" },
  compiledKnowledge: { rows: [], note: "No data yet — this table fills in from the release that records `rung:` on promotion records." },
  verification: PROMOTED_VERIFICATION,
  ...over,
});

test("both playbook anchors render, in their specified positions", () => {
  const out = renderReport([sum()], ctx());
  const at = (needle) => out.indexOf(needle);
  assert.ok(at("<!-- devcycle:highlights -->") !== -1, "the highlights anchor is missing");
  assert.ok(at("<!-- devcycle:findings -->") !== -1, "the findings anchor is missing");
  // At a glance sits between the caveat block and Highlights; Highlights before Cost by version.
  assert.ok(at("## Read this first") < at("## At a glance"));
  assert.ok(at("## At a glance") < at("<!-- devcycle:highlights -->"));
  assert.ok(at("<!-- devcycle:highlights -->") < at("## Cost by version"));
  // Findings sits between Compiled knowledge and the Appendix.
  assert.ok(at("## Compiled knowledge") < at("<!-- devcycle:findings -->"));
  assert.ok(at("<!-- devcycle:findings -->") < at("## Appendix"));
});

test("the section order is fixed", () => {
  const out = renderReport([sum()], ctx());
  const order = [
    "# Doctor Report", "## Read this first", "## At a glance", "## Highlights",
    "## Workload (observed)", "## Cost by version",
    "## Cost by stage", "### Cost by stage (this window)", "## Outcome (observed)",
    "## Your culprits", "### Compliance",
    "## Your wins", "## Cost anomalies", "## Previously promoted — did it hold", "## Outer loop",
    "## Compiled knowledge", "## Findings", "## Appendix",
  ];
  const positions = order.map((h) => out.indexOf(h));
  assert.ok(positions.every((p) => p !== -1), `a section is missing: ${order.filter((h, i) => positions[i] === -1)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "sections are out of order");
});

test("the report leads with an At a glance workload-adjusted step, carrying its confidence", () => {
  const dates = releaseDates(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8"));
  const band = recencyBand(installedVersion(), dates);
  const [vOld, vNew] = [band.at(-2), band.at(-1)];
  const workload = { requestKind: "feature", insertions: 100, deletions: 100, plannedTaskCount: 3 };
  const run = (id, version, cost) => sum({
    id, runId: id.padEnd(16, "0"), pluginVersion: version, profile: "thorough",
    costUSD: cost, mainTurns: 10, subagentTurns: 4, medianDepth: 40000, workload,
  });
  const out = renderReport([
    run("o1", vOld, 10), run("o2", vOld, 10),
    run("n1", vNew, 12), run("n2", vNew, 12),
  ], ctx());
  const at = (needle) => out.indexOf(needle);
  assert.ok(at("## At a glance") !== -1, "the At a glance section is missing");
  assert.ok(at("## Read this first") < at("## At a glance"));
  assert.ok(at("## At a glance") < at("## Highlights"));
  const glance = out.slice(at("## At a glance"), at("## Highlights"));
  assert.match(glance, new RegExp(`${vOld}→${vNew}`), "the matched step is missing");
  assert.match(glance, /\+20\.0%/, "the cost delta is missing");
  assert.match(glance, /\blow\b/, "the confidence label is missing");
});

test("the At a glance percentage column carries no $ glyph over a percent (issue #114)", () => {
  const out = renderReport([sum()], ctx());
  const glance = out.slice(out.indexOf("## At a glance"), out.indexOf("## Highlights"));
  assert.ok(!/workload-adj \$ Δ/.test(glance), "a $ glyph still sits over the percentage cell");
  assert.match(glance, /workload-adj cost Δ% \(derived\)/, "the honest percentage header is missing");
});

test("changelogEntry returns a version's body bullets, or null when absent", () => {
  const cl = "# Changelog\n\n## 0.12.0 — 2026-08-07\n\n- feat(x): a thing\n- fix(y): another\n\n## 0.11.0 — 2026-08-05\n\n- fix\n";
  assert.deepEqual(changelogEntry(cl, "0.12.0"), ["- feat(x): a thing", "- fix(y): another"]);
  assert.equal(changelogEntry(cl, "0.9.9"), null);
});

test("regressionAttribution cites the changelog only when no promotion explains the regression (QC4)", () => {
  const cl = "# Changelog\n\n## 0.12.0 — 2026-08-07\n\n- feat(x): a thing\n";
  const candidate = { type: "version-regression", skill: "planning", version_from: "0.11.0", version_to: "0.12.0" };
  // No matching promotion → a correlational citation of the version's own entry.
  const attr = regressionAttribution(candidate, [], cl);
  assert.equal(attr.correlational, true);
  assert.equal(attr.version, "0.12.0");
  assert.deepEqual(attr.entry, ["- feat(x): a thing"]);
  // A promotion that shipped a culprit fix for the regressed-to version → revertCandidates owns it.
  assert.equal(regressionAttribution(candidate, [{ pluginVersion: "0.12.0", culpritId: "a-culprit" }], cl), null);
});

// A version-regression the plugin's own promotions do not explain regresses "around the time of" a
// release; the render cites that release's changelog entry, labelled correlational and lower
// confidence than a revertCandidates hit (issue D1, QC4).
const REGRESSION_CORPUS = [
  sum({ id: "o1", pluginVersion: "0.11.0", costByStage: { planning: 1 }, costUSD: 1 }),
  sum({ id: "o2", pluginVersion: "0.11.0", costByStage: { planning: 1 }, costUSD: 1 }),
  sum({ id: "o3", pluginVersion: "0.11.0", costByStage: { planning: 1 }, costUSD: 1 }),
  sum({ id: "n1", pluginVersion: "0.12.0", costByStage: { planning: 10 }, costUSD: 10 }),
  sum({ id: "n2", pluginVersion: "0.12.0", costByStage: { planning: 10 }, costUSD: 10 }),
  sum({ id: "n3", pluginVersion: "0.12.0", costByStage: { planning: 10 }, costUSD: 10 }),
];

test("a version-regression with no explaining promotion carries a correlational changelog citation", () => {
  const out = renderReport(REGRESSION_CORPUS, ctx());
  const anomalies = out.slice(out.indexOf("## Cost anomalies"), out.indexOf("## Previously promoted"));
  assert.match(anomalies, /- CANDIDATE: version-regression skill=planning 0\.11\.0->0\.12\.0/);
  assert.match(anomalies, /↳ correlated change \(unverified\):/);
});

test("a version-regression a promotion already explains carries no correlational citation", () => {
  const out = renderReport(REGRESSION_CORPUS, ctx({ promotions: [{ pluginVersion: "0.12.0", culpritId: "a-culprit" }] }));
  const anomalies = out.slice(out.indexOf("## Cost anomalies"), out.indexOf("## Previously promoted"));
  assert.match(anomalies, /- CANDIDATE: version-regression skill=planning 0\.11\.0->0\.12\.0/);
  assert.ok(!/↳ correlated change \(unverified\):/.test(anomalies), "revertCandidates owns a promotion-sourced regression; no correlational line");
});

test("the report renders observed workload and outcome families, each metric tagged observed", () => {
  const workload = {
    requestKind: "feature", filesChanged: 4, insertions: 80, deletions: 20,
    plannedTaskCount: 3, waveCount: 2,
  };
  const quality = {
    tasks: 3, reviewRounds: 2, retries: 1, blockingFindings: 0,
    conformanceFailures: 0, roundsPerTask: 0.67,
  };
  const runId = "r1".padEnd(16, "0");
  const out = renderReport([
    sum({ id: "r1aaaaaa", runId, pluginVersion: "0.12.0", profile: "thorough",
      costUSD: 10, mainTurns: 10, subagentTurns: 4, medianDepth: 40000, workload, quality }),
    sum({ id: "r1bbbbbb", runId, pluginVersion: "0.12.0", profile: "thorough",
      costUSD: 8, mainTurns: 8, subagentTurns: 3, medianDepth: 40000, workload, quality }),
  ], ctx());
  const at = (n) => out.indexOf(n);
  assert.ok(at("## Workload (observed)") !== -1, "the Workload (observed) section is missing");
  assert.ok(at("## Outcome (observed)") !== -1, "the Outcome (observed) section is missing");
  // Workload family: raw counts, tagged observed, the changed-lines total actually rendered.
  const wl = out.slice(at("## Workload (observed)"), at("## Cost by version"));
  assert.match(wl, /Changed lines \(observed\)/, "the changed-lines column is untagged or missing");
  assert.match(wl, /Tasks \(observed\)/, "the tasks column is untagged or missing");
  assert.match(wl, /\| 100 \|/, "the raw changed-lines figure (80+20) is not rendered");
  // Outcome family: raw verdicts/counts, tagged observed.
  const oc = out.slice(at("## Outcome (observed)"), at("## Your culprits"));
  assert.match(oc, /Conformance pass \(observed\)/, "the conformance column is untagged or missing");
  assert.match(oc, /Review rounds \(observed\)/, "the review-rounds column is untagged or missing");
});

test("every rendered metric column in the pre-existing tables is tagged observed or derived (spec C3)", () => {
  // Cost by version, Cost by stage (+ its window sibling), and Your culprits predate the
  // observed/derived convention; this pins that the whole report now meets it, not just the
  // two new observed families. Dimension/key columns (Version, Profile, Stage, Culprit, Kind)
  // stay untagged on purpose.
  const out = renderReport([sum()], ctx());
  const version = out.slice(out.indexOf("## Cost by version"), out.indexOf("## Cost by stage"));
  assert.match(version, /\| Sessions \(observed\) \| Cycles \(observed\) \| Median \$\/cycle \(derived\) \|/,
    "Sessions/Cycles/Median $/cycle are not tagged");
  assert.match(version, /Δ vs previous \(derived\)/, "Δ vs previous is not tagged");
  assert.match(version, /Priciest stage \(derived\)/, "Priciest stage is not tagged");
  assert.match(version, /Median depth \(derived\)/, "Median depth is not tagged");
  assert.match(version, /Quality \(derived\)/, "Quality is not tagged");
  assert.match(version, /Shipped \(observed\)/, "Shipped is not tagged");

  const stage = out.slice(out.indexOf("## Cost by stage"), out.indexOf("### Cost by stage (this window)"));
  assert.match(stage, /\| Trend \(derived\) \|/, "Cost by stage's Trend column is not tagged");
  assert.ok(
    stage.includes("_Dollar cells are derived per-version medians; Trend is derived._"),
    "the Cost by stage caption is missing",
  );

  const window = out.slice(
    out.indexOf("### Cost by stage (this window)"),
    out.indexOf("## Outcome (observed)"),
  );
  assert.match(
    window,
    /\| Cost \(observed\) \| % of window \(derived\) \| Median depth \(derived\) \| Trend vs previous window \(derived\) \|/,
    "Cost by stage (this window) columns are not tagged",
  );

  const culprits = out.slice(out.indexOf("## Your culprits"), out.indexOf("### Compliance"));
  assert.match(
    culprits,
    /\| Cost \(observed\) \| Occurrences \(observed\) \| Δ vs previous \(derived\) \| Trend \(derived\) \| Versions \(observed\) \| Lifecycle \(derived\) \|/,
    "Your culprits columns are not tagged",
  );
});

test("compliance candidates carry a session count like version-regression (#128)", () => {
  const out = renderReport([
    sum({ id: "z", pluginVersion: "0.12.0",
      complianceCandidates: [{ type: "inherited-model", inherited: 2, total: 5, sessions_sampled: 1 }] }),
  ], ctx());
  assert.match(out, /CANDIDATE: inherited-model inherited=2\/5 sessions=1 versions=\[0\.12\.0\.\.0\.12\.0\]/);
});

test("every section carries a one-line gloss", () => {
  const out = renderReport([sum()], ctx());
  // Each `## ` or `### ` heading (except the two anchored ones, whose gloss precedes the
  // anchor, and the H1) is followed within three lines by an italic gloss line.
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{2,3} /.test(lines[i])) continue;
    const window = lines.slice(i + 1, i + 4).join("\n");
    assert.match(window, /^\s*\*.+\*\s*$/m, `no gloss under "${lines[i]}"`);
  }
});

test("the report renders no path, no session id, and no machine identity", () => {
  const out = renderReport([sum()], ctx());
  assert.ok(!/\/Users\/|\/home\//.test(out), "the report leaked a home-directory path");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(out), "the report leaked a session id");
});

// Spec §5's coverage fixture. Every metric class the report can render has to actually render a
// row here, or the coverage test below degrades into asserting that headings exist. Two adjacent
// version cohorts (so the version comparisons fire), one dear outlier session, one in-flight
// session, one session carrying the appendix's raw aggregates, one carrying a win, and one
// carrying a compliance breach.
const coverageSession = (over = {}) => sum({
  profile: "thorough", knobs: { reviewDepth: "panel" },
  turns: 20, mainTurns: 15, subagentTurns: 5, maxDepth: 60000,
  models: { "claude-opus-5": 1 }, tools: { Read: 2 },
  ...over,
});

// Quality is rendered in three cohort tables, and every one of them read "unavailable (no run
// record)" while the corpus carried no quality signal at all — so nothing pinned the column and
// deleting it broke no test. One session carries a real signal; these are the figures it makes
// each of those three tables render.
const COVERAGE_QUALITY_TEXT = "1.5 rounds/task (2 tasks, 1 retries, 4 blocking, 1 conformance fail)";

const COVERAGE_CORPUS = [
  // 0.11.0: the baseline cohort the 0.12.0 comparisons are taken against.
  ...[1, 2, 3].map((n) => coverageSession({
    id: `1111111${n}`, pluginVersion: "0.11.0",
    costUSD: 11, costByStage: { execution: 10, planning: 1 },
    costByModel: { "claude-opus-5": 11 }, costByAgentType: { main: 8, subagent: 3 },
  })),
  // execution got cheaper (a win), planning got dearer (an anomaly).
  coverageSession({
    id: "22222221", costUSD: 15, costByStage: { execution: 5, planning: 10 },
    costByModel: { "claude-opus-5": 15 }, costByAgentType: { main: 12, subagent: 3 },
    bandCounts: { "0-50k": 2, "50-100k": 1 },
    startupFloor: { main: [12000], subagent: [4000] },
    carryWeighted: { Read: 900, Bash: 400 },
    dispatches: { total: 5, withoutModel: 2 },
    unpriced: { "some-unpriced-model": 3 },
    attributionSource: "forward-filled",
    cacheBand: { point: 4, low: 3, high: 6, fallbackShare: 0.5, collapsed: false },
    impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 2, impact: 6 }],
    culpritsByKey: { "gate-fail:execution": ["partial-evidence-capture"] },
    complianceCandidates: [{ type: "inherited-model", inherited: 2, total: 5, sessions_sampled: 1 }],
  }),
  coverageSession({
    id: "22222222", costUSD: 15, costByStage: { execution: 5, planning: 10 },
    impact: [{ key: "first-round-accept:execution", event: "first-round-accept", stage: "execution", frequency: 3, impact: 9 }],
    culpritsByKey: { "first-round-accept:execution": ["first-round-clean-accept"] },
  }),
  coverageSession({
    id: "22222223", costUSD: 15, costByStage: { execution: 5, planning: 10 },
    quality: {
      tasks: 2, reviewRounds: 3, retries: 1, blockingFindings: 4,
      conformanceFailures: 1, roundsPerTask: 1.5,
    },
  }),
  // Far dearer than its peers for the same stage: the cost outlier.
  coverageSession({ id: "22222224", costUSD: 100, costByStage: { execution: 100 } }),
  coverageSession({ id: "33333333", costUSD: 2, costByStage: { execution: 2 }, inFlight: true }),
];

test("every legacy line-class still has a home in the rendered report", () => {
  // Spec §5's coverage test: a future change that silently drops a metric fails here rather
  // than passing review. Every needle is a rendered value, never a heading — a heading is
  // emitted unconditionally, so a needle pointed at one survives the deletion of the metric
  // underneath it.
  const out = renderReport(COVERAGE_CORPUS, ctx());
  for (const needle of [
    // Header
    "· Total cost: $180.00 ·",
    // Read this first
    "- UNPRICED MODEL: some-unpriced-model (3 requests)",
    "- Cost $4.00 (inferred: cache-write TTL, range $3.00–$6.00; 50.0% of cache-write tokens lack a TTL split).",
    "- 1 session(s) have inferred stage costs (forward-filled — no run record)",
    "- 1 session(s) still in flight (newest record < 30 min old) — in-flight sessions have only part of their cost recorded",
    // Cost by version — the whole row, out to its last cell: a needle that stopped at the depth
    // column still matched after the Quality and Shipped columns were deleted.
    `| 0.12.0 | thorough | 4 | 4 | $15.00 | $0.2000 | $6.65 | — | +36.4% | execution | 40000 | ${COVERAGE_QUALITY_TEXT} | — |`,
    // Cost by stage, across versions and within this window
    "| execution | $10.00 | $5.00 | down |",
    "| execution | $147.00 | 81.7% | 40000 | n/a (no window) |",
    // Your culprits — out to the row's end, for the same reason as the cohort row above: a
    // needle that stopped at the Δ column still matched after the Trend column was deleted.
    "| partial-evidence-capture | friction | $6.00 | 2 | first seen | insufficient data | 0.12.0..0.12.0 | legacy |",
    // Compliance — now version-scoped from the source session (spec C5)
    "- CANDIDATE: inherited-model inherited=2/5 sessions=1 versions=[0.12.0..0.12.0]",
    // Your wins: a win event, and a version-over-version improvement
    "| first-round-clean-accept | $9.00 | 3 |",
    "| execution 0.11.0→0.12.0 | $5.00 | 4 | down |",
    // Cost anomalies, one line per candidate type the report can raise (the global-median
    // cost-outlier is retired — issue #114 — and its role is the matched-cohort EXCESS-COST residual,
    // which this run-less corpus produces no rows for).
    "- CANDIDATE: depth-outlier dollars=$15.00 sessions=1 versions=[0.12.0..0.12.0] low confidence: n=1",
    // The from->to span is canonical for a version-regression; the redundant versions=[..] is suppressed (item 6c).
    "- CANDIDATE: version-regression skill=planning 0.11.0->0.12.0 delta=+$9.00 (900.0%) dollars=$10.00 sessions=3",
    "- CANDIDATE: unpriced-model model=some-unpriced-model count=3 sessions=1 low confidence: n=1",
    // Appendix
    "claude-opus-5 $48.00",
    "main $36.00, subagent $12.00",
    "0-50k 2, 50-100k 1, 100-150k 0, 150-200k 0, 200-300k 0, 300k+ 0",
    "main median 12000 min 12000 (n=1), subagent median 4000 min 4000 (n=1)",
    "Read 900, Bash 400",
    "5 dispatched, 2 without an explicit model",
    `| panel | 7 | $178.00 | $15.00 | ${COVERAGE_QUALITY_TEXT} |`,
    `| 0.12.0 | 4 | $145.00 | $15.00 | 40000 | ${COVERAGE_QUALITY_TEXT} |`,
    // No session in this fixture carries a runId, so no run projection exists to score (#127).
    "Direction of travel: insufficient data (no matched cohort spans two versions with n>=3)",
    "session 22222221 — turns 20 (main 15, subagent 5), depth median 40000 max 60000, cost $15.00, " +
      "models [claude-opus-5], tools [Read:2], quality: unavailable (no run record) " +
      "[stage costs inferred — forward-filled, no run record]",
    // The vintage itself, not the label: a report rendering "prices as of undefined" passed the
    // label-only needle, which is the failure the whole appendix footer exists to prevent.
    "prices as of 2026-08-01", // appendix footer
    "forward-filled within each transcript", // the attribution disclosure
    "fraction of the model's context window", // the depth disclosure
  ]) assert.ok(out.includes(needle), `the rendered report dropped "${needle}"`);
});

test("the cost-by-stage table names the unknown-version cohort it excluded", () => {
  // stageByVersionTable cannot place "unknown" on a version axis, so it drops that cohort. The
  // render site says so rather than letting the omission read as a clean bill of health.
  const out = renderReport([
    sum({ id: "a", costByStage: { execution: 3 } }),
    sum({ id: "b", pluginVersion: "unknown", costByStage: { execution: 4 } }),
    sum({ id: "c", pluginVersion: "unknown", costByStage: { planning: 1 } }),
  ], ctx());
  const line = "_Excluded from this table: 2 session(s), $5.00 (inferred: no version detectable). " +
    "Their cost is in Total cost by version, in the appendix._";
  assert.ok(out.includes(line), "the excluded unknown-version cohort is not named");
  // Under the across-versions table, not the window one.
  assert.ok(out.indexOf("## Cost by stage") < out.indexOf(line));
  assert.ok(out.indexOf(line) < out.indexOf("### Cost by stage (this window)"));
  // Nothing dropped, nothing claimed: no line at all rather than a zero.
  assert.ok(!renderReport([sum()], ctx()).includes("Excluded from this table"));
});

// Every needle above pins the Shipped cell as `—`, the placeholder an empty shipped list renders
// as — which a deleted cell would produce too. This is the one assertion on a rendered non-empty
// Shipped value, so the column has to actually carry what the promotion record named.
test("the Shipped cell renders the culprit id the version's promotion recorded", () => {
  const out = renderReport([sum(), sum({ id: "b" }), sum({ id: "c" })], ctx({
    promotions: [
      { pluginVersion: "0.12.0", culpritId: "partial-evidence-capture" },
      { pluginVersion: "0.11.0", culpritId: "reviewer-role-confusion" },
    ],
  }));
  assert.ok(
    out.includes(
      "| 0.12.0 | thorough | 3 | 3 | $1.00 | — | — | — | first seen | execution | 40000 | " +
        "unavailable (no run record) | partial-evidence-capture |",
    ),
    "the cohort row does not carry the culprit its version shipped",
  );
  // The other version's promotion belongs to its own row and must not bleed into this one.
  assert.ok(!out.includes("reviewer-role-confusion"), "a promotion from another version was rendered here");
});

test("compiled knowledge and the shipped column render empty rather than throwing", () => {
  const out = renderReport([sum()], ctx());
  assert.match(out, /## Compiled knowledge/);
  assert.match(out, /fills in from the release that records/);
  // The Shipped column exists and its cell is the em dash, never a blank that reads as
  // "nothing shipped".
  assert.match(out, /\| Shipped \(observed\) \|/);
});

// The shipped report's own direction-of-travel line. Its only assertion used to sit on
// formatReport, which main() no longer prints — so the line a reader actually sees could have
// been dropped without failing anything.
test("the rendered report states the corpus direction of travel, under the cohort table it summarises", () => {
  // Normalized (#127): the trend only fires within one matched (profile|requestKind|
  // workloadBand) cohort, reliable (n>=3) on both ends — so every run below shares one workload.
  const wl = { requestKind: "feature", insertions: 100, deletions: 100, plannedTaskCount: 3 };
  const run = (id, version, cost) => sum({
    id, runId: id.padEnd(16, "0"), pluginVersion: version, profile: "thorough",
    costUSD: cost, workload: wl,
  });
  const out = renderReport([
    run("a", "0.11.0", 10), run("b", "0.11.0", 10), run("c", "0.11.0", 10),
    run("d", "0.12.0", 5), run("e", "0.12.0", 5), run("f", "0.12.0", 5),
  ], ctx());
  const directionAt = out.indexOf("Direction of travel:");
  assert.ok(directionAt !== -1, "the shipped report states no direction of travel");
  const line = out.slice(directionAt, out.indexOf("\n", directionAt));
  assert.match(line, /Direction of travel: down \(-50\.0% median cost, .+, 0\.11\.0→0\.12\.0\)/);
  assert.ok(out.indexOf("### Total cost by version") < directionAt, "the direction precedes the table it summarises");
  assert.ok(directionAt < out.indexOf("### Per-session detail"));
});

test("one known version is insufficient data, never a flat trend", () => {
  // Even a reliable (n>=3) cohort on a single version cannot show a trend — a trend needs two.
  const wl = { requestKind: "feature", insertions: 10, deletions: 5, plannedTaskCount: 1 };
  const run = (id) => sum({
    id, runId: id.padEnd(16, "0"), pluginVersion: "0.12.0", profile: "thorough",
    costUSD: 1, workload: wl,
  });
  const out = renderReport([run("a"), run("b"), run("c")], ctx());
  assert.ok(out.includes("Direction of travel: insufficient data (no matched cohort spans two versions with n>=3)"));
});

test("an in-flight session cannot set the direction of travel", () => {
  // A part-recorded session carries part of its cost, so letting it count toward a version's
  // reliable-cohort size (n>=3) would report a trend the corpus never reliably made.
  const wl = { requestKind: "feature", insertions: 100, deletions: 100, plannedTaskCount: 3 };
  const run = (id, version, cost, over = {}) => sum({
    id, runId: id.padEnd(16, "0"), pluginVersion: version, profile: "thorough",
    costUSD: cost, workload: wl, ...over,
  });
  const out = renderReport([
    run("a", "0.11.0", 10), run("b", "0.11.0", 10), run("c", "0.11.0", 10),
    run("d", "0.12.0", 5), run("e", "0.12.0", 5),
    run("f", "0.12.0", 90, { inFlight: true }),
  ], ctx());
  assert.ok(out.includes("Direction of travel: insufficient data (no matched cohort spans two versions with n>=3)"));
});

test("direction of travel normalizes and never anchors on an n<3 endpoint (#127)", () => {
  // Same workload on every run (mirrors the At-a-glance test :793-814) so runAggregates derives
  // one matched cohort; requestKind/workloadBand come from `workload`, never set directly.
  const wl = { requestKind: "feature", insertions: 100, deletions: 100, plannedTaskCount: 3 };
  const run = (id, version, cost) => sum({
    id, runId: id.padEnd(16, "0"), pluginVersion: version, profile: "thorough",
    costUSD: cost, workload: wl,
  });
  const out = renderReport([
    run("a", "0.10.0", 1), run("b", "0.10.0", 1),                            // n=2 outlier — ignored
    run("c", "0.11.0", 10), run("d", "0.11.0", 10), run("e", "0.11.0", 10),  // n=3 reliable
    run("f", "0.12.0", 13), run("g", "0.12.0", 13), run("h", "0.12.0", 13),  // n=3 reliable, +30%
  ], ctx());
  assert.match(out, /Direction of travel: up \(\+?30\.0% median/);
  assert.doesNotMatch(out, /900\.0%|1200\.0%/);
});

test("an unavailable outer loop renders unavailable, not zeros", () => {
  const out = renderReport([sum()], ctx());
  assert.match(out, /Filed: unavailable/);
  assert.ok(!/Filed: 0/.test(out));
});

// D-4: the unit is issues, matching Filed and Resolved, so the outer-loop line reads as one
// monotonic funnel rather than mixing units.
test("the Drafted line names its unit as issues, matching Filed and Resolved", () => {
  const out = renderReport([sum()], ctx({
    outerLoop: { drafted: 2, draftedSince: "0.13.0", filed: 1, resolved: 0, medianTurnaroundDays: null, truncated: false },
  }));
  assert.match(out, /^- Drafted: 2 \(issues; markers recorded since 0\.13\.0\)$/m);
});

test("an outer-loop query that hits its limit says so rather than under-reporting silently", () => {
  const dir = reportsFixture({});
  const issues = Array.from({ length: 200 }, (_, i) => ({
    number: i + 1, title: `[culprit:friction:x] issue ${i}`, labels: [],
    createdAt: "2026-08-01T00:00:00Z", closedAt: null, state: "open",
  }));
  try {
    const l = outerLoop(dir, () => JSON.stringify(issues));
    assert.equal(l.truncated, true);
    const out = renderReport([sum()], ctx({ outerLoop: l }));
    assert.match(out, /at the 200-issue query limit — the counts below are a lower bound/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a query below the limit carries no truncation marker", () => {
  const dir = reportsFixture({});
  const issues = [{
    number: 1, title: "[culprit:friction:x] one", labels: [],
    createdAt: "2026-08-01T00:00:00Z", closedAt: null, state: "open",
  }];
  try {
    const l = outerLoop(dir, () => JSON.stringify(issues));
    assert.equal(l.truncated, false);
    const out = renderReport([sum()], ctx({ outerLoop: l }));
    assert.doesNotMatch(out, /lower bound/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the empty corpus renders a report rather than throwing", () => {
  const out = renderReport([], ctx());
  assert.match(out, /# Doctor Report/);
  assert.match(out, /no sessions matched/i);
});

// The cache-band caveat lines, pinned as whole strings rather than by shape. They are shipped
// prose a reader acts on, and until now neither was asserted anywhere — which is exactly how the
// affirmation came to be dropped from this report while formatReport still emitted it.
const EXACT_LINE = "- Cost is exact: every cache write in this corpus carries its TTL split.";
const NO_CAVEATS_LINE = "- No caveats apply to this corpus.";
const FORWARD_FILLED_LINE =
  "- 1 session(s) have inferred stage costs (forward-filled — no run record); the session ids " +
  "are in the appendix's per-session detail.";

test("a collapsed cache band affirms the cost is exact even when another caveat applies", () => {
  // The real corpus's shape: the band is collapsed while forward-filled sessions do produce a
  // caveat, so the no-caveat fallback cannot be what carries the exactness claim.
  const out = renderReport([sum({ attributionSource: "forward-filled" })], ctx());
  assert.ok(out.includes(EXACT_LINE), "a collapsed band claimed no exactness");
  assert.ok(out.includes(FORWARD_FILLED_LINE), "the forward-filled caveat is missing");
  assert.ok(!out.includes(NO_CAVEATS_LINE), "the fallback fired although a caveat applies");
});

test("the no-caveat fallback still fires, alongside the exactness affirmation", () => {
  // Reachability: the fallback is keyed off the caveat classes, so an unconditional band line
  // does not turn it into dead code. Both lines render for a corpus with nothing to qualify.
  const out = renderReport([sum()], ctx());
  assert.ok(out.includes(EXACT_LINE), "a collapsed band claimed no exactness");
  assert.ok(out.includes(NO_CAVEATS_LINE), "the no-caveat fallback is unreachable");
});

test("an uncollapsed cache band renders its range and claims no exactness", () => {
  const out = renderReport(
    [sum({ cacheBand: { point: 4, low: 3, high: 6, fallbackShare: 0.5, collapsed: false } })],
    ctx(),
  );
  assert.ok(
    out.includes(
      "- Cost $4.00 (inferred: cache-write TTL, range $3.00–$6.00; 50.0% of cache-write tokens lack a TTL split).",
    ),
    "the inferred cache-band range is missing",
  );
  assert.ok(!out.includes(EXACT_LINE), "an inferred band was reported as exact");
  assert.ok(!out.includes(NO_CAVEATS_LINE), "an inferred band was reported as carrying no caveat");
});

// --- the issue draft ---

test("repoShape reports three enums and never a path or a name", () => {
  const shape = repoShape(process.cwd());
  assert.deepEqual(Object.keys(shape).sort(), ["language", "monorepo", "testRunner"]);
  for (const v of Object.values(shape))
    assert.ok(typeof v === "boolean" || /^[a-z]+$/.test(v), `"${v}" is not an enum`);
});

test("this repo, which has no package manifest, is not a monorepo and has no known test runner", () => {
  const shape = repoShape(process.cwd());
  assert.equal(shape.monorepo, false);
  assert.equal(shape.testRunner, "unknown");
});

// A draftable culprit must have been seen inside the recency band, or issueBody's version guard
// refuses it as stale. The installed version is by definition the newest band member, so the draft
// fixtures are pinned to it rather than to a literal that would fall out of band on the next release.
const DRAFT_VERSION = installedVersion();

const draftSummaries = [1, 2, 3].map((n) => sum({
  id: `s${n}`, pluginVersion: DRAFT_VERSION, costUSD: 4, costByStage: { execution: 4 },
  impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 2, impact: 6 }],
  culpritsByKey: { "gate-fail:execution": ["partial-evidence-capture"] },
}));

const draftTables = () => ({
  versionProfile: versionProfileTable(draftSummaries),
  culprits: culpritTable(draftSummaries, VOCAB),
});

test("the issue title and labels follow the fixed form", () => {
  const d = issueBody("partial-evidence-capture", draftSummaries, draftTables(), repoShape(process.cwd()));
  assert.equal(d.title, "[culprit:partial-evidence-capture] Captured evidence covered less than the whole verification gate command.");
  assert.deepEqual(d.labels.sort(), ["culprit:partial-evidence-capture", "from-doctor"]);
});

test("the draft carries the same cohort figure the report renders for that row", () => {
  const tables = draftTables();
  const d = issueBody("partial-evidence-capture", draftSummaries, tables, repoShape(process.cwd()));
  const row = tables.versionProfile.find((r) => r.version === DRAFT_VERSION && r.profile === "thorough");
  assert.ok(d.body.includes(row.medianCostPerCycle.toFixed(2)), "the draft's cohort figure differs from the table's");
  assert.ok(d.body.includes(String(row.sessions)));
});

// A cohort the report qualifies must not be quoted bare here: an issue filed from a two-session
// cohort would otherwise state a figure the report that produced it declines to stand behind.
test("a low-confidence cohort carries the report's own qualifier, not a bare count", () => {
  const summaries = [1, 2].map((n) => sum({
    id: `s${n}`, pluginVersion: DRAFT_VERSION, costUSD: 4, costByStage: { execution: 4 },
    impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 2, impact: 6 }],
    culpritsByKey: { "gate-fail:execution": ["partial-evidence-capture"] },
  }));
  const tables = { versionProfile: versionProfileTable(summaries), culprits: culpritTable(summaries, VOCAB) };
  const row = tables.versionProfile.find((r) => r.version === DRAFT_VERSION && r.profile === "thorough");
  assert.equal(row.lowConfidence, true);
  const d = issueBody("partial-evidence-capture", summaries, tables, repoShape(process.cwd()));
  assert.ok(d.body.includes("2 (low confidence: n<3)"), "the draft quotes a count the report qualifies");
});

// The read half (outerLoop) already queries DEVCYCLE_UPSTREAM. The write half has to reach the
// same repo or the two never meet: a bare `gh issue create` resolves to whatever repo the run
// happened in, so the draft would land in the user's own tracker and Filed would stay zero.
// A filer without push access on the upstream cannot set labels — GitHub drops them on an issue
// opened by a non-collaborator. The printed labels are still declared (the draft's whole point),
// but the page must not imply the filer can apply them.
test("the printed draft states the labels are the maintainer's to apply at triage", () => {
  const lines = issueDraftLines({
    repo: "KonstantinRoehrl/devcycle", title: "[culprit:friction:x] thing",
    labels: ["culprit:friction:x", "from-doctor"], body: "body",
  });
  const text = lines.join("\n");
  assert.match(
    text,
    /^labels: culprit:friction:x, from-doctor \(suggested — the maintainer applies these at triage; an issue opened without push access cannot set them\)$/m,
  );
});

test("the printed draft names the upstream it must be filed against, and owns that slug alone", () => {
  const d = issueBody("partial-evidence-capture", draftSummaries, draftTables(), repoShape(process.cwd()));
  assert.equal(d.repo, DEVCYCLE_UPSTREAM);
  assert.ok(
    issueDraftLines(d).includes(`repo: ${DEVCYCLE_UPSTREAM}`),
    "the printed draft names no repo, so the filing step has nothing to pass to gh --repo",
  );
  const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
  assert.ok(
    !playbook.includes(DEVCYCLE_UPSTREAM),
    "the playbook spells the upstream slug itself — a second owner, free to drift from the one " +
      "outerLoop reads",
  );
});

test("the draft carries no path, no machine identity, and no free text beyond the placeholder", () => {
  const d = issueBody("partial-evidence-capture", draftSummaries, draftTables(), repoShape(process.cwd()));
  assert.ok(!/\/Users\/|\/home\//.test(d.body));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(d.body));
  assert.match(d.body, /<!-- add anything you want to say here -->/);
});

test("a culprit with no vocabulary entry is still offered a draft", () => {
  const summaries = [sum({
    pluginVersion: DRAFT_VERSION,
    impact: [{ key: "review-reject:execution", event: "review-reject", stage: "execution", frequency: 1, impact: 2 }],
  })];
  const tables = { versionProfile: versionProfileTable(summaries), culprits: culpritTable(summaries, VOCAB) };
  const d = issueBody("review-reject:execution", summaries, tables, repoShape(process.cwd()));
  assert.match(d.title, /^\[culprit:/);
});

// The version guard: a culprit last seen outside the recency band names a problem a newer
// release may already have addressed, so drafting an issue for it would file stale noise.
const staleCulpritCorpus = (versions) => versions.map((v, n) => sum({
  id: `st${n}`, pluginVersion: v, costUSD: 4, costByStage: { execution: 4 },
  impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 2, impact: 6 }],
  culpritsByKey: { "gate-fail:execution": ["partial-evidence-capture"] },
}));
const staleCulpritTables = (corpus) => ({
  versionProfile: versionProfileTable(corpus),
  culprits: culpritTable(corpus, VOCAB),
});

test("issueBody refuses a wholly-stale culprit and warns on a partial one", () => {
  // Derive the fixture versions from the LIVE recency band issueBody computes internally, so this
  // survives every version bump. Pinning absolute versions here silently rots: a version in-band at
  // release N falls out of the (fixed-width) band at N+1, turning the partial case wholly-stale.
  // `IN_BAND` is the band's oldest member (below installed whenever ≥2 prior releases exist); `OUT`
  // sorts below every real release, so it is always out of band.
  const band = recencyBand(
    installedVersion(),
    releaseDates(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8")),
  );
  const IN_BAND = band[0];
  const OUT = "0.0.1";

  // a culprit seen only outside the band -> throws StaleCulpritError
  const STALE_CORPUS = staleCulpritCorpus([OUT, OUT]);
  assert.throws(
    () => issueBody("partial-evidence-capture", STALE_CORPUS, staleCulpritTables(STALE_CORPUS), repoShape(process.cwd())),
    (e) => e instanceof StaleCulpritError,
  );
  // a culprit seen once out of band and once in band -> draft carries the STALE banner and the range
  const MIXED_CORPUS = staleCulpritCorpus([OUT, IN_BAND]);
  const body = issueDraftLines(
    issueBody("partial-evidence-capture", MIXED_CORPUS, staleCulpritTables(MIXED_CORPUS), repoShape(process.cwd())),
  ).join("\n");
  assert.match(body, /⚠ STALE/);
  const expectedRange = `versions=[${OUT}..${IN_BAND}]`.replace(/[.[\]]/g, "\\$&");
  assert.match(body, new RegExp(expectedRange));
});

// Everything above exercises the draft as a value. The flag itself prints it, and what a filer
// pastes into gh is that printed form — which nothing read until this test: the comment above
// issueDraftLines claims the printed form is pinned by a test rather than by nothing.
const SCRIPT = new URL("../../scripts/doctor.mjs", import.meta.url).pathname;

// One transcript carrying a devcycle attribution, and the run record that gives its cost a stage
// and names a culprit — the smallest corpus in which a culprit is rankable and so draftable.
function issueBodyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-issue-body-"));
  const proj = join(dir, "projects", "-some-project");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "sess-abcdef123456.jsonl"),
    JSON.stringify(turn({ attributionSkill: "devcycle:cycle" })) + "\n");
  const runs = join(dir, "runs", "some-repo");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "run.jsonl"), [
    { kind: "run", schemaVersion: 1, runId: "0123456789abcdef", pluginVersion: DRAFT_VERSION, profile: "thorough", knobs: {} },
    { kind: "session", sessionHash: sha256("sess-abcdef123456") },
    { kind: "stage", stage: "execution", startedAt: "2026-07-20T09:00:00.000Z", endedAt: "2026-07-20T11:00:00.000Z", outcome: "complete" },
    { kind: "event", event: "gate-fail", stage: "execution", task: "1", culprit: "partial-evidence-capture", ts: "2026-07-20T10:00:00.000Z" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

test("--issue-body prints the whole draft and nothing else, naming the upstream and the fixed-form title", () => {
  const dir = issueBodyFixture();
  try {
    // PATH is emptied so nothing here can reach gh; node is spawned by its absolute path.
    const res = spawnSync(
      process.execPath,
      [SCRIPT, "--dir", join(dir, "projects"), "--issue-body", "partial-evidence-capture"],
      { encoding: "utf8", env: { ...process.env, PATH: "", CLAUDE_CODE_SESSION_ID: "", DEVCYCLE_RUNS_DIR: join(dir, "runs") } },
    );
    assert.equal(res.status, 0, res.stderr);
    const desc = JSON.parse(readFileSync(join(process.cwd(), "references/culprits.json"), "utf8"))
      .find((e) => e.slug === "partial-evidence-capture").desc;
    const lines = res.stdout.split("\n");
    // The repo line leads: it is the one field the filing step acts on rather than pastes.
    assert.equal(lines[0], `repo: ${DEVCYCLE_UPSTREAM}`);
    assert.equal(lines[1], `title: [culprit:partial-evidence-capture] ${desc}`);
    assert.equal(
      lines[2],
      "labels: culprit:partial-evidence-capture, from-doctor (suggested — the maintainer applies " +
        "these at triage; an issue opened without push access cannot set them)",
    );
    assert.equal(lines[3], "");
    assert.equal(lines[4], "Culprit: partial-evidence-capture (friction)");
    // "and nothing else": the draft's own last line is the last line printed.
    assert.equal(lines.at(-2), "<!-- add anything you want to say here -->");
    assert.equal(lines.at(-1), "");
    assert.ok(!/\/Users\/|\/home\//.test(res.stdout), "the printed draft leaked a path");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseArgs reads --issue-body", () => {
  assert.equal(parseArgs(["--issue-body", "partial-evidence-capture"]).issueBody, "partial-evidence-capture");
  // The report path is unaffected when the flag is absent.
  assert.equal(parseArgs(["--all"]).issueBody, null);
});

// The marker is written by playbooks/profiling-sessions.md and parsed by doctor.mjs, with
// nothing else binding the two. This pins the contract on behaviour rather than on regex source:
// the literal is extracted from the playbook and fed to the parser. Drift in either file fails.
test("the Drafted: marker round-trips from the playbook's own literal to the parser", () => {
  const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
  const literal = playbook.split("\n").find((l) => l.trim().startsWith("Drafted: [culprit:"));
  assert.ok(literal, "playbooks/profiling-sessions.md no longer states the Drafted: marker form");
  // Fed exactly as the playbook states it — indentation included. Trimming it here is what hid
  // the parser's column-0 anchor from this test in the first place.
  const filled = literal
    .replace("<slug>", "partial-evidence-capture")
    .replace("<title>", "Evidence capture is partial");
  assert.deepEqual(
    parseDraftedMarkers(filled),
    [{ slug: "partial-evidence-capture", title: "Evidence capture is partial" }],
    "the playbook's marker form no longer parses — the writer and the reader have drifted",
  );
});

test("the playbook names both splice anchors the renderer emits", () => {
  const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
  assert.match(playbook, /<!-- devcycle:highlights -->/);
  assert.match(playbook, /<!-- devcycle:findings -->/);
});

// The consent path is the only route from a doctor finding to a public issue, and it has been
// dropped once already: the playbook ended at "filing is theirs to do", so nothing was ever filed
// and the Outer loop section could only ever read zero. This pins the whole path — two distinct
// gates, a marker written when the draft is made rather than when it is posted, and a filing that
// reaches the repo Outer loop reads.
test("the playbook's consent path keeps both gates and files a runnable command", () => {
  const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
  const firstGate = playbook.indexOf("first gate");
  const secondGate = playbook.indexOf("second gate");
  const filing = playbook.indexOf("gh issue create");
  const marker = playbook.indexOf("Drafted: [culprit:");
  assert.ok(firstGate !== -1, "the playbook no longer names a first confirmation gate");
  assert.ok(
    secondGate > firstGate,
    "the two confirmations are no longer stated as separate, ordered gates",
  );
  assert.ok(
    filing > secondGate,
    "the consent path files nothing after the second gate — a run that posts nothing leaves " +
      "the Outer loop section counting zero forever",
  );
  assert.ok(
    marker !== -1 && marker < firstGate,
    "the Drafted: marker is written after a consent gate, so a draft declined at one leaves no " +
      "record and Drafted can never exceed Filed",
  );
  // Bound to the numbered item that spells the command, never to the whole procedure: the six
  // items carry no blank line between them, so a "\n\n" split checks the entire path at once and
  // a flag named anywhere in it would pass.
  const step = playbook.split(/\n(?=\d+\. |#{2,3} )/).find((p) => p.includes("gh issue create"));
  // The command itself, not the prose around it: a sentence mentioning `gh issue create` is not
  // an invocation, and only an invocation can carry a flag.
  const commands = step.split("\n").map((l) => l.trim());
  const create = commands.find((l) => l.startsWith("gh issue create"));
  assert.ok(create, "the filing step names no gh issue create command to run");
  assert.match(
    create,
    /--repo/,
    "gh issue create runs without --repo, so the draft is filed into whatever repo the run " +
      "happened in and Outer loop never sees it",
  );
  // Without both, gh run non-interactively answers "must provide --title and --body" and files
  // nothing — after both consent gates have already been given.
  assert.match(create, /--title/, "gh issue create carries no --title, so it cannot run non-interactively");
  assert.match(create, /--body/, "gh issue create carries no body, so it cannot run non-interactively");
  // Labels are the maintainer's triage step, never the filer's: creating one on the upstream
  // needs push access, and GitHub drops labels supplied by a user without it. A filing step that
  // attempts either dead-ends after both gates, with the Drafted: marker already on disk.
  assert.doesNotMatch(
    create,
    /--label/,
    "the filing step supplies labels a filer without push access cannot set — GitHub drops them, " +
      "so the flag buys nothing and Outer loop must not be counting by them",
  );
  assert.ok(
    !commands.some((l) => l.startsWith("gh label create")),
    "the filing step creates a label on the upstream, which needs push access: a filer who is " +
      "not a collaborator gets HTTP 403 and the run halts with nothing filed",
  );
});

// --- the "Previously promoted — did it hold" section renders the verification engine ---

// The section between its own heading and the next one — so a verdict word matched here cannot
// have leaked in from a different section.
const promotedSection = (out) =>
  out.slice(out.indexOf("## Previously promoted — did it hold"), out.indexOf("## Outer loop"));

test("the previously-promoted section renders every verdict word from the engine scoreboard", () => {
  const section = promotedSection(renderReport([sum()], ctx()));
  for (const verdict of ["held", "recurred", "unmeasurable", "broken"])
    assert.match(section, new RegExp(`\\b${verdict}\\b`), `verdict "${verdict}" is not rendered`);
  assert.match(section, /friction:recurred-one/);
});

test("a recurred r2 promotion reaches the Actionability menu as a /devcycle:cycle entry point", () => {
  const out = renderReport([sum()], ctx());
  const line = out.split("\n").find((l) => l.includes("/devcycle:cycle") && l.includes("friction:recurred-one"));
  assert.ok(line, "no /devcycle:cycle entry point names the recurred culprit");
});

test("a corpus with nothing measured yet renders the section without throwing", () => {
  const section = promotedSection(renderReport([sum()], ctx({
    verification: { scoreboard: [], candidates: { escalation: [], retirement: [] }, resolvedIn: [] },
  })));
  assert.match(section, /## Previously promoted — did it hold/);
});

// The engine annotates WHY a check produced its verdict. Dropping that annotation left a reader
// of a bare "unmeasurable" with no way to learn that --run-checks exists, which made the opt-in
// invisible in the one place it needed to be visible.
test("a skipped r3 check renders its reason, not a bare unmeasurable", () => {
  const section = promotedSection(renderReport([sum()], ctx({
    verification: {
      scoreboard: [{
        culpritId: "friction:skipped-one", rung: "r3", verdict: "unmeasurable",
        runsObserved: 0, recurrences: 0, detail: "tests/unit/x.test.mjs (not run: pass --run-checks)",
      }],
      candidates: { escalation: [], retirement: [] }, resolvedIn: [],
    },
  })));
  assert.match(section, /not run: pass --run-checks/);
});

test("an errored r3 check renders the errored verdict and its reason", () => {
  const section = promotedSection(renderReport([sum()], ctx({
    verification: {
      scoreboard: [{
        culpritId: "friction:errored-one", rung: "r3", verdict: "errored",
        runsObserved: 0, recurrences: 0, detail: "npm test (errored: ETIMEDOUT)",
      }],
      candidates: { escalation: [], retirement: [] }, resolvedIn: [],
    },
  })));
  assert.match(section, /\berrored\b/);
  assert.match(section, /ETIMEDOUT/);
});

test("a row with no detail renders unchanged, with no trailing separator", () => {
  const section = promotedSection(renderReport([sum()], ctx({
    verification: {
      scoreboard: [{
        culpritId: "friction:plain-one", rung: "r2", verdict: "held",
        runsObserved: 3, recurrences: 0, detail: null,
      }],
      candidates: { escalation: [], retirement: [] }, resolvedIn: [],
    },
  })));
  assert.match(section, /- friction:plain-one \(r2\): held over 3 runs\n/);
});

// --- revert candidates: cost-driven, same-profile, stage-scoped, written as a sidecar ---

test("revertCandidates emits a same-profile stage-scoped regression with the sidecar fields", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-revert-"));
  try {
    const summaries = [
      sum({ id: "o1", pluginVersion: "0.11.0", profile: "thorough", costByStage: { execution: 5 } }),
      sum({ id: "o2", pluginVersion: "0.11.0", profile: "thorough", costByStage: { execution: 5 } }),
      sum({ id: "n1", pluginVersion: "0.12.0", profile: "thorough", costByStage: { execution: 20 } }),
      sum({ id: "n2", pluginVersion: "0.12.0", profile: "thorough", costByStage: { execution: 20 } }),
    ];
    const promotions = [
      { culpritId: "friction:regressor", rung: "r2", pluginVersion: "0.12.0", commit: "abc1234", lifecycle: null },
    ];
    const result = revertCandidates(summaries, promotions, { root });
    const c = result.candidates[0];
    assert.equal(c.culpritId, "friction:regressor");
    assert.equal(c.rung, "r2");
    assert.equal(c.profile, "thorough");
    assert.equal(c.stage, "execution");
    assert.ok(c.deltaPct < 0, "a regression is a negative deltaPct");
    // The sidecar is written to the pinned path under the given root, in the same shape.
    const written = JSON.parse(readFileSync(join(root, ".devcycle", "doctor", "revert-candidates.json"), "utf8"));
    assert.equal(written.candidates[0].culpritId, "friction:regressor");
    assert.ok("generatedAt" in written && "installedVersion" in written);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revertCandidates never fires on a profile-mix shift — the regression is compared within one profile", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-revert-mix-"));
  try {
    // The dearer newer cohort is a different profile: same-profile scoping means no candidate.
    const summaries = [
      sum({ id: "o1", pluginVersion: "0.11.0", profile: "lean", costByStage: { execution: 5 } }),
      sum({ id: "n1", pluginVersion: "0.12.0", profile: "thorough", costByStage: { execution: 20 } }),
    ];
    const promotions = [
      { culpritId: "friction:regressor", rung: "r2", pluginVersion: "0.12.0", commit: "abc1234", lifecycle: null },
    ];
    assert.deepEqual(revertCandidates(summaries, promotions, { root }).candidates, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
