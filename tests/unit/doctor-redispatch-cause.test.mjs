import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import {
  REDISPATCH_CAUSE_SINCE, deriveEvents, impactScores, readRunRecords, redispatchCause, redispatchCauses, redispatchNote, renderReport,
  summarizeSession,
} from "../../scripts/doctor.mjs";

const IMPL = "devcycle:implementer";
const REVIEWER = "devcycle:task-reviewer";
const row = (taskId, agentType, retryIndex, minute) => ({
  kind: "dispatch", runId: "1111111111111111", taskId, agentType, agentId: `a${taskId}${retryIndex}`, model: "claude-sonnet-5-5",
  modelSource: "explicit", startedAt: `2026-11-25T08:${String(minute).padStart(2, "0")}:00Z`,
  endedAt: `2026-11-25T08:${String(minute + 1).padStart(2, "0")}:00Z`, outcome: "complete", reviewRound: 0, retryIndex,
});
// Task 1's retry 1 follows an attempt that reached intake; task 2's retry 2 follows a killed retry 1;
// task 3's reviewer retry 1 follows an implementer row only, which is not its own previous attempt.
const DISPATCHES = [row("1", IMPL, 0, 0), row("1", IMPL, 1, 5), row("2", IMPL, 0, 10), row("2", IMPL, 2, 20), row("3", IMPL, 0, 30), row("3", REVIEWER, 1, 40)];
const recordAt = (pluginVersion) => ({ pluginVersion, stages: [], events: [], dispatches: DISPATCHES });
const causesOf = (record) => deriveEvents(record).filter((e) => e.event === "re-dispatch").map((e) => [e.task, e.cause]);

test("a re-dispatch is a fix-pass when its previous attempt reached intake, a redo when it did not", () => {
  assert.equal(REDISPATCH_CAUSE_SINCE, "0.34.1");
  assert.deepEqual(causesOf(recordAt("0.34.1")), [["1", "fix-pass"], ["2", "redo"], ["3", "redo"]]);
  assert.equal(redispatchCause(recordAt("0.35.0"), DISPATCHES[1]), "fix-pass");
  assert.deepEqual(redispatchCauses(recordAt("0.34.1")), { "fix-pass": 1, redo: 2, unknown: 0 });
});

test("a fix pass whose previous attempt sits in an earlier session window of the run is a fix-pass, not a redo", () => {
  const sha256 = (s) => createHash("sha256").update(s).digest("hex");
  const dir = makeTempDir("doctor-redispatch-cross-session");
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  const lines = [
    { kind: "run", runId: "1111111111111111", schemaVersion: 1, pluginVersion: "0.34.1", repoSlug: "repo-00000000", startedAt: "2026-11-25T07:00:00Z" },
    { kind: "session", runId: "1111111111111111", sessionHash: sha256("sess-A") },
    row("1", IMPL, 0, 0),
    { kind: "session", runId: "1111111111111111", sessionHash: sha256("sess-B") },
    row("1", IMPL, 1, 5),
  ];
  writeFileSync(join(dir, "repo-00000000", "1111111111111111.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const records = readRunRecords(dir);
  const second = records.get(sha256("sess-B"));
  assert.deepEqual(second.dispatches.map((d) => d.retryIndex), [1], "the second session's window holds only its own attempt");
  assert.deepEqual(causesOf(second), [["1", "fix-pass"]]);
  assert.deepEqual(redispatchCauses(second), { "fix-pass": 1, redo: 0, unknown: 0 });
});

test("a run from before the cause release, or of unknown version, has only unknown causes", () => {
  for (const version of ["0.34.0", "unknown", undefined])
    assert.deepEqual(causesOf(recordAt(version)), [["1", "unknown"], ["2", "unknown"], ["3", "unknown"]], String(version));
});

test("a stop-request event is neutral: it is never scored", () => {
  const record = { pluginVersion: "0.34.1", stages: [], dispatches: [], events: [{ event: "stop-request", stage: "execution", ts: "2026-11-25T08:00:00Z" }] };
  assert.deepEqual(impactScores(record, {}), []);
});

test("the report prints the corpus's re-dispatch split by cause and names the vintage break", () => {
  const sha256 = (s) => createHash("sha256").update(s).digest("hex");
  const dir = makeTempDir("doctor-redispatch-cause");
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  const lines = [
    { kind: "run", runId: "1111111111111111", schemaVersion: 1, pluginVersion: "0.34.1", repoSlug: "repo-00000000", startedAt: "2026-11-25T07:00:00Z" },
    { kind: "session", runId: "1111111111111111", sessionHash: sha256("sess-1") },
    ...DISPATCHES,
  ];
  writeFileSync(join(dir, "repo-00000000", "1111111111111111.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const turn = { sessionId: "sess-1", isSidechain: false, type: "assistant", timestamp: "2026-11-25T08:05:00.000Z",
    message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } };
  const summary = summarizeSession("sess-1", [turn], readRunRecords(dir));
  assert.deepEqual(summary.redispatchCauses, { "fix-pass": 1, redo: 2, unknown: 0 });
  const report = renderReport([summary], { repo: "devcycle", today: "2026-11-25", scope: "every devcycle-tagged session" });
  assert.ok(report.includes(redispatchNote({ "fix-pass": 1, redo: 2, unknown: 0 })), "the split is missing from the report");
  assert.match(redispatchNote({ "fix-pass": 1, redo: 2, unknown: 0 }), /^_re-dispatch by cause: fix-pass 1, redo 2, unknown 0\. .*0\.34\.1.*more retries are now recorded, shared between both causes \(vintage break\)/);
});
