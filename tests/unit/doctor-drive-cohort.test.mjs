import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readRunRecords, summarizeSession, renderReport, recencyBand } from "../../scripts/doctor.mjs";
import { releaseDates, installedVersion } from "../../scripts/verification.mjs";

const DRIVEN = "1111111111111111";
const MANUAL = "2222222222222222";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const runLine = (runId) => ({ kind: "run", runId, schemaVersion: 1, pluginVersion: "0.24.0", repoSlug: "repo-00000000", startedAt: "2026-10-08T07:00:00Z" });
const sessionLine = (runId, session) => ({ kind: "session", runId, sessionHash: sha256(session) });
const driveRow = (session, over = {}) => ({
  kind: "drive", runId: DRIVEN, sessionHash: sha256(session), startedAt: "2026-10-08T08:00:00Z", endedAt: "2026-10-08T08:20:00Z",
  model: "claude-opus-5-5", ledgerLinesBefore: 4, ledgerLinesAfter: 12, committedBefore: 0, committedAfter: 2,
  exitReason: "handoff", stallCount: 0, ...over,
});

function runsDir(files) {
  const dir = makeTempDir("doctor-drive-cohort");
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  for (const [runId, lines] of Object.entries(files))
    writeFileSync(join(dir, "repo-00000000", `${runId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

// One driven run of three sessions — a wave, a stalled session, a stop — and one hand-walked run.
const corpus = () => runsDir({
  [DRIVEN]: [
    runLine(DRIVEN),
    sessionLine(DRIVEN, "sess-d1"), driveRow("sess-d1"),
    sessionLine(DRIVEN, "sess-d2"), driveRow("sess-d2", { exitReason: "stalled", stallCount: 1, ledgerLinesBefore: 12, ledgerLinesAfter: 12 }),
    sessionLine(DRIVEN, "sess-d3"), driveRow("sess-d3", { exitReason: "stopped", stopReason: "needs-user", stallCount: 0 }),
  ],
  [MANUAL]: [runLine(MANUAL), sessionLine(MANUAL, "sess-m1")],
});

test("readRunRecords: a run with any drive row is cohort auto in every window; its rows ride on the first window only", () => {
  const records = readRunRecords(corpus());
  const [d1, d2, d3, m1] = ["sess-d1", "sess-d2", "sess-d3", "sess-m1"].map((s) => records.get(sha256(s)));
  assert.deepEqual([d1.drive, d2.drive, d3.drive, m1.drive], ["auto", "auto", "auto", "manual"]);
  assert.deepEqual(d1.driveRuns.map((r) => [r.runId, r.rows.map((row) => row.exitReason)]),
    [[DRIVEN, ["handoff", "stalled", "stopped"]]]);
  assert.deepEqual([d2.driveRuns, d3.driveRuns, m1.driveRuns.flatMap((r) => r.rows)], [[], [], []]);
});

test("summarizeSession carries the run's drive cohort and drive rows; a session with no record has neither", () => {
  const records = readRunRecords(corpus());
  const turn = (sessionId) => ({ sessionId, isSidechain: false, type: "assistant", timestamp: "2026-10-08T08:05:00.000Z",
    message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } });
  const driven = summarizeSession("sess-d1", [turn("sess-d1")], records);
  assert.equal(driven.drive, "auto");
  assert.equal(driven.driveRuns[0].rows.length, 3);
  assert.equal(summarizeSession("sess-m1", [turn("sess-m1")], records).drive, "manual");
  assert.equal(summarizeSession("sess-none", [turn("sess-none")], records).drive, null);
});

// The smallest corpus that yields one At-a-glance step per cohort: two versions in the recency band,
// two same-shaped runs on each, in each cohort — the driven one 50% dearer across the step, the
// manual one 20%.
function glanceCorpus() {
  const band = recencyBand(installedVersion(), releaseDates(readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8")));
  const [vOld, vNew] = [band.at(-2), band.at(-1)];
  const workload = { requestKind: "feature", insertions: 100, deletions: 100, plannedTaskCount: 3 };
  const run = (id, version, cost, drive) => ({
    id, runId: id.padEnd(16, "0"), pluginVersion: version, profile: "standard", costUSD: cost, costByStage: { execution: cost },
    mainTurns: 10, subagentTurns: 4, medianDepth: 40000, workload, quality: null, inFlight: false, impact: null, culpritsByKey: {},
    drive, driveRuns: drive === "auto" ? [{ runId: id.padEnd(16, "0"), rows: [driveRow("s", { runId: id.padEnd(16, "0") })] }] : [],
  });
  return {
    vOld, vNew,
    summaries: [
      run("m1", vOld, 10, "manual"), run("m2", vOld, 10, "manual"), run("m3", vNew, 12, "manual"), run("m4", vNew, 12, "manual"),
      run("a1", vOld, 10, "auto"), run("a2", vOld, 10, "auto"), run("a3", vNew, 15, "auto"), run("a4", vNew, 15, "auto"),
    ],
  };
}
const glanceOf = (report) => report.slice(report.indexOf("## At a glance"), report.indexOf("## Highlights"));
const CTX = { repo: "devcycle", today: "2026-10-08", scope: "every devcycle-tagged session" };

test("renderReport: At a glance shows the driven and manual cohorts as separate rows, never one pooled step", () => {
  const { vOld, vNew, summaries } = glanceCorpus();
  const glance = glanceOf(renderReport(summaries, CTX));
  assert.match(glance, /^\| Drive \| Step \| matchKey \|/m);
  assert.match(glance, new RegExp(`^\\| manual \\| ${vOld}→${vNew} \\| .*\\| \\+20\\.0% \\|`, "m"));
  assert.match(glance, new RegExp(`^\\| drive: auto \\| ${vOld}→${vNew} \\| .*\\| \\+50\\.0% \\|`, "m"));
  assert.doesNotMatch(glance, /\+35\.0%/, "a pooled step would read +35%");
});

test("renderReport: At a glance surfaces driven-session exits, stops by reason and stalls", () => {
  const records = readRunRecords(corpus());
  const summaries = ["sess-d1", "sess-d2", "sess-d3", "sess-m1"].map((s) => {
    const rec = records.get(sha256(s));
    return { id: s, runId: rec.runId, drive: rec.drive, driveRuns: rec.driveRuns, costUSD: 1, costByStage: { execution: 1 },
      pluginVersion: "0.24.0", profile: "standard", medianDepth: 40000, quality: null, inFlight: false, impact: null, culpritsByKey: {} };
  });
  const glance = glanceOf(renderReport(summaries, CTX));
  assert.match(glance, /^Drive cohorts \(observed\): manual 1 run\(s\) · drive: auto 1 run\(s\), 3 driven session\(s\)/m);
  assert.match(glance, /^Driven-session exits \(observed\): handoff 1 · stalled 1 · stopped 1\.$/m);
  assert.match(glance, /^Stops by reason \(observed\): needs-user 1\.$/m);
  assert.match(glance, /^Stalls \(observed\): 1 driven session\(s\) ended stalled; longest stall run 1\.$/m);
});

test("renderReport: a corpus with no driven run prints no drive lines", () => {
  const glance = glanceOf(renderReport(glanceCorpus().summaries.filter((s) => s.drive === "manual"), CTX));
  assert.doesNotMatch(glance, /Drive cohorts|drive: auto/);
});
