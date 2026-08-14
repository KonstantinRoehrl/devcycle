// The report layer of scripts/doctor.mjs: the table seams, the markdown renderer, and the
// issue draft. Split from doctor.test.mjs, which is already 1882 lines and covers the metric
// computation underneath. No real session transcript is ever read and no test touches gh.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizeSession, journalEvents, cycleGroups, impactScores,
  versionProfileTable, stageByVersionTable, stageWindowTable, culpritTable, winTable, WIN_EVENTS,
  parseDraftedMarkers, releaseDates, outerLoop, compiledKnowledge, DEVCYCLE_UPSTREAM,
  renderReport, repoShape, issueBody, parseArgs,
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

test("outerLoop counts drafted markers across persisted reports", () => {
  const dir = reportsFixture({
    "2026-08-01-report.md": "Drafted: [culprit:partial-evidence-capture] one\n",
    "2026-08-08-report.md": "Drafted: [culprit:reviewer-role-confusion] two\nDrafted: [culprit:partial-evidence-capture] three\n",
  });
  try {
    assert.equal(outerLoop(dir, () => GH_RESPONSE).drafted, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outerLoop queries devcycle's upstream, never the ambient repo", () => {
  const dir = reportsFixture({});
  const seen = [];
  try {
    outerLoop(dir, (args) => { seen.push(args); return GH_RESPONSE; });
    const argv = seen[0];
    const i = argv.indexOf("--repo");
    assert.ok(i !== -1, "gh was invoked without --repo, so it resolves to the host repo");
    assert.equal(argv[i + 1], DEVCYCLE_UPSTREAM);
    assert.ok(argv.includes("--label") && argv.includes("from-doctor"));
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

const issue = (number, slug, createdAt) => ({
  number,
  title: `[culprit:${slug ?? "none"}] an issue`,
  labels: slug ? [{ name: "from-doctor" }, { name: `culprit:${slug}` }] : [{ name: "from-doctor" }],
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
  issue(6, null, "2026-08-01T00:00:00Z"), // no culprit label at all
]);

test("outerLoop counts every filed issue, resolves the ones the vocabulary marks fixed, and medians their turnaround", () => {
  const dir = reportsFixture({});
  try {
    const r = outerLoop(dir, () => TURNAROUND_ISSUES, TURNAROUND_VOCAB);
    assert.equal(r.filed, 6);
    // The three dated ones plus the one fixed in an undated release; the other two are not fixed.
    assert.equal(r.resolved, 4);
    // Median of 2, 10 and 30 days — not their mean, which would be 14.
    assert.equal(r.medianTurnaroundDays, 10);
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

test("compiled knowledge renders no rows and says why, rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-promotions-"));
  try {
    writeFileSync(join(dir, "2026-08-05-a-promotion.md"),
      "# A promotion\n- promotion-type: doc-edit\n- cluster-signature: sig\n- files-touched: x.md\n- landed: 2026-08-05\n- commit: abc1234\n");
    const ck = compiledKnowledge(dir);
    assert.deepEqual(ck.rows, []);
    assert.match(ck.note, /rung/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compiled knowledge on a missing promotions directory renders the same no-data state", () => {
  const ck = compiledKnowledge(join(tmpdir(), "doctor-promotions-absent-xyz"));
  assert.deepEqual(ck.rows, []);
  assert.match(ck.note, /rung/);
});

// --- the markdown report ---

const ctx = (over = {}) => ({
  repo: "devcycle", today: "2026-08-13", scope: "every devcycle-tagged session",
  previousSummaries: null, vocab: VOCAB, promotions: [],
  outerLoop: { drafted: 0, draftedSince: "0.13.0", filed: "unavailable", resolved: "unavailable", medianTurnaroundDays: "unavailable" },
  compiledKnowledge: { rows: [], note: "No data yet — this table fills in from the release that records `rung:` on promotion records." },
  ...over,
});

test("both playbook anchors render, in their specified positions", () => {
  const out = renderReport([sum()], ctx());
  const at = (needle) => out.indexOf(needle);
  assert.ok(at("<!-- devcycle:highlights -->") !== -1, "the highlights anchor is missing");
  assert.ok(at("<!-- devcycle:findings -->") !== -1, "the findings anchor is missing");
  // Highlights sits between the caveat block and Cost by version.
  assert.ok(at("## Read this first") < at("<!-- devcycle:highlights -->"));
  assert.ok(at("<!-- devcycle:highlights -->") < at("## Cost by version"));
  // Findings sits between Compiled knowledge and the Appendix.
  assert.ok(at("## Compiled knowledge") < at("<!-- devcycle:findings -->"));
  assert.ok(at("<!-- devcycle:findings -->") < at("## Appendix"));
});

test("the section order is fixed", () => {
  const out = renderReport([sum()], ctx());
  const order = [
    "# Doctor Report", "## Read this first", "## Highlights", "## Cost by version",
    "## Cost by stage", "### Cost by stage (this window)", "## Your culprits", "### Compliance",
    "## Your wins", "## Cost anomalies", "## Previously promoted — did it hold", "## Outer loop",
    "## Compiled knowledge", "## Findings", "## Appendix",
  ];
  const positions = order.map((h) => out.indexOf(h));
  assert.ok(positions.every((p) => p !== -1), `a section is missing: ${order.filter((h, i) => positions[i] === -1)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "sections are out of order");
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
    complianceCandidates: [{ type: "inherited-model", inherited: 2, total: 5 }],
  }),
  coverageSession({
    id: "22222222", costUSD: 15, costByStage: { execution: 5, planning: 10 },
    impact: [{ key: "first-round-accept:execution", event: "first-round-accept", stage: "execution", frequency: 3, impact: 9 }],
    culpritsByKey: { "first-round-accept:execution": ["first-round-clean-accept"] },
  }),
  coverageSession({ id: "22222223", costUSD: 15, costByStage: { execution: 5, planning: 10 } }),
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
    // Cost by version
    "| 0.12.0 | thorough | 4 | 4 | $15.00 | +36.4% | execution | 40000 |",
    // Cost by stage, across versions and within this window
    "| execution | $10.00 | $5.00 | down |",
    "| execution | $147.00 | 81.7% | 40000 | n/a (no window) |",
    // Your culprits
    "| partial-evidence-capture | friction | $6.00 | 2 | first seen |",
    // Compliance
    "- CANDIDATE: inherited-model inherited=2/5",
    // Your wins: a win event, and a version-over-version improvement
    "| first-round-clean-accept | $9.00 | 3 |",
    "| execution 0.11.0→0.12.0 | $5.00 | 4 | down |",
    // Cost anomalies, one line per candidate type the report can raise
    "- CANDIDATE: cost-outlier skill=execution delta=900.0% dollars=$100.00 sessions=7",
    "- CANDIDATE: depth-outlier dollars=$15.00 sessions=1 low confidence: n=1",
    "- CANDIDATE: version-regression skill=planning 0.11.0->0.12.0 delta=+$9.00 (900.0%) dollars=$10.00 sessions=3",
    "- CANDIDATE: unpriced-model model=some-unpriced-model count=3 sessions=1 low confidence: n=1",
    // Appendix
    "claude-opus-5 $48.00",
    "main $36.00, subagent $12.00",
    "0-50k 2, 50-100k 1, 100-150k 0, 150-200k 0, 200-300k 0, 300k+ 0",
    "main median 12000 min 12000 (n=1), subagent median 4000 min 4000 (n=1)",
    "Read 900, Bash 400",
    "5 dispatched, 2 without an explicit model",
    "| panel | 7 | $178.00 | $15.00 |",
    "| 0.12.0 | 4 | $145.00 | $15.00 | 40000 |",
    "Direction of travel: up (36.4% median cost, oldest to newest known version)",
    "session 22222221 — turns 20 (main 15, subagent 5), depth median 40000 max 60000, cost $15.00, " +
      "models [claude-opus-5], tools [Read:2], quality: unavailable (no run record) " +
      "[stage costs inferred — forward-filled, no run record]",
    "prices as of",            // appendix footer
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

test("compiled knowledge and the shipped column render empty rather than throwing", () => {
  const out = renderReport([sum()], ctx());
  assert.match(out, /## Compiled knowledge/);
  assert.match(out, /fills in from the release that records/);
  // The Shipped column exists and its cell is the em dash, never a blank that reads as
  // "nothing shipped".
  assert.match(out, /\| Shipped \|/);
});

// The shipped report's own direction-of-travel line. Its only assertion used to sit on
// formatReport, which main() no longer prints — so the line a reader actually sees could have
// been dropped without failing anything.
test("the rendered report states the corpus direction of travel, under the cohort table it summarises", () => {
  const out = renderReport([
    sum({ id: "aaaaaaa1", pluginVersion: "0.11.0", costUSD: 10, costByStage: { execution: 10 } }),
    sum({ id: "aaaaaaa2", costUSD: 5, costByStage: { execution: 5 } }),
  ], ctx());
  const line = "Direction of travel: down (-50.0% median cost, oldest to newest known version)";
  assert.ok(out.includes(line), "the shipped report states no direction of travel");
  assert.ok(out.indexOf("### Total cost by version") < out.indexOf(line), "the direction precedes the table it summarises");
  assert.ok(out.indexOf(line) < out.indexOf("### Per-session detail"));
});

test("one known version is insufficient data, never a flat trend", () => {
  const out = renderReport([sum()], ctx());
  assert.ok(out.includes("Direction of travel: insufficient data (need at least two known versions)"));
});

test("an in-flight session cannot set the direction of travel", () => {
  // A part-recorded session carries part of its cost, so letting it open a newest cohort would
  // report an improvement the corpus never made.
  const out = renderReport([
    sum({ id: "aaaaaaa1", pluginVersion: "0.11.0", costUSD: 10, costByStage: { execution: 10 } }),
    sum({ id: "aaaaaaa2", costUSD: 5, costByStage: { execution: 5 } }),
    sum({ id: "aaaaaaa3", pluginVersion: "0.13.0", costUSD: 90, costByStage: { execution: 90 }, inFlight: true }),
  ], ctx());
  assert.ok(out.includes("Direction of travel: down (-50.0% median cost, oldest to newest known version)"));
});

test("an unavailable outer loop renders unavailable, not zeros", () => {
  const out = renderReport([sum()], ctx());
  assert.match(out, /Filed: unavailable/);
  assert.ok(!/Filed: 0/.test(out));
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

const draftSummaries = [1, 2, 3].map((n) => sum({
  id: `s${n}`, costUSD: 4, costByStage: { execution: 4 },
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
  const row = tables.versionProfile.find((r) => r.version === "0.12.0" && r.profile === "thorough");
  assert.ok(d.body.includes(row.medianCostPerCycle.toFixed(2)), "the draft's cohort figure differs from the table's");
  assert.ok(d.body.includes(String(row.sessions)));
});

// A cohort the report qualifies must not be quoted bare here: an issue filed from a two-session
// cohort would otherwise state a figure the report that produced it declines to stand behind.
test("a low-confidence cohort carries the report's own qualifier, not a bare count", () => {
  const summaries = [1, 2].map((n) => sum({
    id: `s${n}`, costUSD: 4, costByStage: { execution: 4 },
    impact: [{ key: "gate-fail:execution", event: "gate-fail", stage: "execution", frequency: 2, impact: 6 }],
    culpritsByKey: { "gate-fail:execution": ["partial-evidence-capture"] },
  }));
  const tables = { versionProfile: versionProfileTable(summaries), culprits: culpritTable(summaries, VOCAB) };
  const row = tables.versionProfile.find((r) => r.version === "0.12.0" && r.profile === "thorough");
  assert.equal(row.lowConfidence, true);
  const d = issueBody("partial-evidence-capture", summaries, tables, repoShape(process.cwd()));
  assert.ok(d.body.includes("2 (low confidence: n<3)"), "the draft quotes a count the report qualifies");
});

test("the draft carries no path, no machine identity, and no free text beyond the placeholder", () => {
  const d = issueBody("partial-evidence-capture", draftSummaries, draftTables(), repoShape(process.cwd()));
  assert.ok(!/\/Users\/|\/home\//.test(d.body));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(d.body));
  assert.match(d.body, /<!-- add anything you want to say here -->/);
});

test("a culprit with no vocabulary entry is still offered a draft", () => {
  const summaries = [sum({
    impact: [{ key: "review-reject:execution", event: "review-reject", stage: "execution", frequency: 1, impact: 2 }],
  })];
  const tables = { versionProfile: versionProfileTable(summaries), culprits: culpritTable(summaries, VOCAB) };
  const d = issueBody("review-reject:execution", summaries, tables, repoShape(process.cwd()));
  assert.match(d.title, /^\[culprit:/);
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
// dropped once already: the playbook ended at "filing is theirs to do", so nothing ever carried
// the labels the Outer loop section counts by and that section could only ever read zero. This
// pins the whole path — two distinct gates, then a real filing that is countable.
test("the playbook's consent path keeps both gates and files with both labels", () => {
  const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
  const firstGate = playbook.indexOf("first gate");
  const secondGate = playbook.indexOf("second gate");
  const filing = playbook.indexOf("gh issue create");
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
  const step = playbook.split("\n\n").find((p) => p.includes("gh issue create"));
  assert.match(step, /from-doctor/, "the filing step drops the from-doctor label Outer loop counts by");
  assert.match(step, /culprit:/, "the filing step drops the culprit:<slug> label");
});
