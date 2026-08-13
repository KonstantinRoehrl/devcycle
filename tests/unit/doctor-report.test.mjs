// The report layer of scripts/doctor.mjs: the table seams, the markdown renderer, and the
// issue draft. Split from doctor.test.mjs, which is already 1882 lines and covers the metric
// computation underneath. No real session transcript is ever read and no test touches gh.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  summarizeSession, journalEvents, cycleGroups, impactScores,
  versionProfileTable, stageByVersionTable, stageWindowTable, culpritTable, winTable, WIN_EVENTS,
} from "../../scripts/doctor.mjs";

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

test("a version-improvement candidate is a win, not a neutral candidate", () => {
  const wins = winTable([sum()], VOCAB, [
    { type: "version-improvement", skill: "execution", version_from: "0.11.0", version_to: "0.12.0", delta_pct: -40, delta_dollars: -12, sessions_sampled: 4 },
    { type: "version-regression", skill: "planning", version_from: "0.11.0", version_to: "0.12.0", delta_pct: 40, delta_dollars: 12, sessions_sampled: 4 },
  ]);
  assert.equal(wins.length, 1);
  assert.match(wins[0].win, /execution/);
  assert.equal(wins[0].impact, 12);
});
