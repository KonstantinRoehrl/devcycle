import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readRunRecords, agentDepthTable, emitComplianceCandidates, formatComplianceCandidate,
  complianceCandidatesOf, impactScores, COMPLIANCE_TYPES, summarizeSession, renderReport } from "../../scripts/doctor.mjs";

const RUN = "0f1e2d3c4b5a6978";
const row = (stage, tokens, depth) => ({ kind: "agent-depth", runId: RUN, stage, agentType: "Explore", model: "claude-sonnet-5-5", tokens, depth, ts: "2026-10-07T07:00:00Z" });

function runsDir(lines) {
  const dir = makeTempDir("doctor-agent-depth");
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  writeFileSync(join(dir, "repo-00000000", `${RUN}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

test("readRunRecords: agent-depth rows land in the session's window", () => {
  const dir = runsDir([
    { kind: "run", runId: RUN, schemaVersion: 1, pluginVersion: "0.23.0", repoSlug: "repo-00000000", startedAt: "2026-10-07T07:00:00Z" },
    { kind: "session", runId: RUN, sessionHash: "h1" },
    row("planning", 41091, "ok"),
    row("planning", 210000, "breach"),
  ]);
  const rec = readRunRecords(dir).get("h1");
  assert.deepEqual(rec.agentDepths.map((r) => r.tokens), [41091, 210000]);
});

test("agentDepthTable: count, p50, max, warns and breaches per stage", () => {
  const summaries = [
    { agentDepths: [row("planning", 100000, "ok"), row("planning", 160000, "warn")] },
    { agentDepths: [row("planning", 210000, "breach"), row("execution", 50000, "ok")] },
  ];
  assert.deepEqual(agentDepthTable(summaries), [
    { stage: "planning", count: 3, p50: 160000, max: 210000, warns: 1, breaches: 1 },
    { stage: "execution", count: 1, p50: 50000, max: 50000, warns: 0, breaches: 0 },
  ]);
});

test("sensor-inactive: a planning stage that produced a plan but no agent-depth rows is flagged", () => {
  assert.ok(COMPLIANCE_TYPES.includes("sensor-inactive"));
  const base = { pluginVersion: "0.23.0", stages: [{ stage: "planning" }], workload: { plannedTaskCount: 9 }, commits: [], dispatches: [] };
  const [c] = emitComplianceCandidates([], { ...base, agentDepths: [] }).filter((x) => x.type === "sensor-inactive");
  assert.deepEqual(c, { type: "sensor-inactive", stage: "planning", plannedTasks: 9, sessions_sampled: 1 });
  assert.deepEqual(emitComplianceCandidates([], { ...base, agentDepths: [row("planning", 1, "ok")] }).filter((x) => x.type === "sensor-inactive"), []);
  assert.deepEqual(emitComplianceCandidates([], { ...base, pluginVersion: "0.22.1", agentDepths: [] }).filter((x) => x.type === "sensor-inactive"), []);
  const [cohort] = complianceCandidatesOf([{ id: "s1", pluginVersion: "0.23.0", complianceCandidates: [c] }]);
  assert.match(formatComplianceCandidate(cohort), /^CANDIDATE: sensor-inactive stage=planning plannedTasks=9 sessions=1/);
});

test("impactScores: a gate-ran event is a neutral marker, never an impact row", () => {
  const record = { events: [{ kind: "event", event: "gate-ran", stage: "planning", result: "pass", culprit: null, ts: "2026-10-07T07:00:00Z" }], stages: [] };
  assert.deepEqual(impactScores(record, {}).map((s) => s.event), []);
});

// The section as renderReport prints it: from its heading up to the next heading.
function agentDepthSection(report) {
  const lines = report.split("\n");
  const start = lines.indexOf("### Agent depth by stage (observed)");
  assert.ok(start >= 0, "the agent-depth section is rendered");
  const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  return lines.slice(start, end).join("\n");
}

test("renderReport: the agent-depth section tables run-record rows per stage, and says so when there are none", () => {
  const SESSION = "sess-agent-depth-1";
  const dir = runsDir([
    { kind: "run", runId: RUN, schemaVersion: 1, pluginVersion: "0.23.0", repoSlug: "repo-00000000", startedAt: "2026-10-07T07:00:00Z" },
    { kind: "session", runId: RUN, sessionHash: createHash("sha256").update(SESSION).digest("hex") },
    row("planning", 41091, "ok"),
    row("planning", 210000, "breach"),
  ]);
  const turn = { sessionId: SESSION, isSidechain: false, type: "assistant", timestamp: "2026-10-07T07:05:00.000Z",
    message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } };
  const ctx = { repo: "devcycle", today: "2026-10-07", scope: "every devcycle-tagged session" };

  const withRows = agentDepthSection(renderReport([summarizeSession(SESSION, [turn], readRunRecords(dir))], ctx));
  assert.match(withRows, /\| Stage \| Dispatches \| p50 depth \| Max depth \| Warn \(>150k\) \| Breach \(>200k\) \|/);
  assert.match(withRows, /\| planning \| 2 \| 125545\.5 \| 210000 \| 0 \| 1 \|/);
  assert.match(withRows, /agent-depth rows the dispatch-sensor hook writes/);

  const empty = agentDepthSection(renderReport([summarizeSession(SESSION, [turn])], ctx));
  assert.match(empty, /no agent-depth records \(the dispatch-sensor hook writes one per finished subagent\)/);
  assert.doesNotMatch(empty, /\| planning \|/);
});
