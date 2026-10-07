import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readRunRecords, agentDepthTable, emitComplianceCandidates, formatComplianceCandidate,
  complianceCandidatesOf, impactScores, COMPLIANCE_TYPES } from "../../scripts/doctor.mjs";

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
