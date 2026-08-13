// The report layer of scripts/doctor.mjs: the table seams, the markdown renderer, and the
// issue draft. Split from doctor.test.mjs, which is already 1882 lines and covers the metric
// computation underneath. No real session transcript is ever read and no test touches gh.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { summarizeSession, journalEvents, cycleGroups, impactScores } from "../../scripts/doctor.mjs";

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
