import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readRunRecords, emitComplianceCandidates, complianceCandidatesOf, formatComplianceCandidate,
  summarizeSession, renderReport, COMPLIANCE_TYPES, MOD_SINCE } from "../../scripts/doctor.mjs";

const RUN = "0f1e2d3c4b5a6978";
const RUN_LINE = { kind: "run", runId: RUN, schemaVersion: 1, pluginVersion: "0.24.0", repoSlug: "repo-00000000", startedAt: "2026-10-07T07:00:00Z" };
const sessionLine = (sessionHash) => ({ kind: "session", runId: RUN, sessionHash });
const depthRow = (agentId) => ({ kind: "agent-depth", runId: RUN, stage: "execution", agentType: "devcycle:implementer",
  ...(agentId ? { agentId } : {}), model: "claude-sonnet-5-5", tokens: 41091, depth: "ok", ts: "2026-10-07T07:00:00Z" });
const traceRow = (agentId) => ({ kind: "agent-trace", runId: RUN, stage: "execution", agentId, agentType: "devcycle:implementer",
  requestedModel: null, resolvedModel: "claude-sonnet-5-5", parentAgentId: null, background: false, fork: false, steps: 3,
  peakDepth: 41091, window: 1000000, windowAssumed: false, peakBand: "ok", toolResultChars: 100, warned: 0, refused: 0,
  reason: "answer", isAborted: false, ts: "2026-10-07T07:00:01Z" });

function runsDir(lines) {
  const dir = makeTempDir("doctor-mod-inactive");
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  writeFileSync(join(dir, "repo-00000000", `${RUN}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}
const modInactive = (lines) => [...readRunRecords(runsDir(lines)).values()]
  .flatMap((rec) => emitComplianceCandidates([], rec)).filter((c) => c.type === "mod-inactive");

test("mod-inactive: a run on a mod-shipping version with agent-depth rows and no agent-trace rows is flagged once", () => {
  assert.equal(MOD_SINCE, "0.24.0");
  assert.ok(COMPLIANCE_TYPES.includes("mod-inactive"));
  const candidates = modInactive([RUN_LINE, sessionLine("hA"), depthRow("a1"), sessionLine("hB"), depthRow("a2")]);
  assert.deepEqual(candidates, [{ type: "mod-inactive", depthRows: 2, sessions_sampled: 1 }]);
  const [cohort] = complianceCandidatesOf([{ id: "s1", pluginVersion: "0.24.0", complianceCandidates: candidates }]);
  const line = formatComplianceCandidate(cohort);
  assert.match(line, /^CANDIDATE: mod-inactive depthRows=2 sessions=1/);
  assert.match(line, /2\.1\.287/);
  assert.match(line, /allowManagedModsOnly/);
  assert.match(line, /never joined/);
});

test("mod-inactive: silent below MOD_SINCE, with no agent-depth rows, or with any agent-trace row in the run", () => {
  assert.deepEqual(modInactive([{ ...RUN_LINE, pluginVersion: "0.23.0" }, sessionLine("hA"), depthRow("a1")]), []);
  assert.deepEqual(modInactive([RUN_LINE, sessionLine("hA")]), []);
  assert.deepEqual(modInactive([RUN_LINE, sessionLine("hA"), depthRow("a1"), sessionLine("hB"), traceRow("a1")]), []);
});

test("readRunRecords: agent-trace rows land in their window and the run's distinct-agentId comparison rides on its first window", () => {
  const records = readRunRecords(runsDir([RUN_LINE, sessionLine("hA"), depthRow("a1"), depthRow("a2"), depthRow(null),
    sessionLine("hB"), traceRow("a1"), traceRow("a1"), traceRow("a3")]));
  assert.equal(records.get("hB").agentTraces.length, 3);
  assert.deepEqual(records.get("hA").traceRuns, [{ runId: RUN, pluginVersion: "0.24.0", depthRows: 3, traceRows: 3,
    depthRowsWithoutId: 1, onlyInDepth: 1, onlyInTrace: 1 }]);
  assert.deepEqual(records.get("hB").traceRuns, []);
});

const SESSION = "sess-mod-inactive-1";
const hash = createHash("sha256").update(SESSION).digest("hex");
const turn = { sessionId: SESSION, isSidechain: false, type: "assistant", timestamp: "2026-10-07T07:05:00.000Z",
  message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 20 } } };
const ctx = { repo: "devcycle", today: "2026-10-07", scope: "every devcycle-tagged session" };
const report = (lines) => renderReport([summarizeSession(SESSION, [turn], readRunRecords(runsDir(lines)))], ctx);

test("COLLECTION GAP: a run whose two kinds disagree on distinct agentIds gets one line, rows without an agentId counted apart", () => {
  const out = report([RUN_LINE, sessionLine(hash), depthRow("a1"), depthRow("a2"), depthRow(null), traceRow("a1"), traceRow("a3")]);
  const gaps = out.split("\n").filter((l) => l.includes("COLLECTION GAP — run"));
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], new RegExp(`run ${RUN}: agent-depth and agent-trace disagree on which subagents ran \\(1 only in agent-depth, 1 only in agent-trace; 1 agent-depth row\\(s\\) without an agentId left out\\)`));
});

test("COLLECTION GAP: none when the distinct agentIds agree, a continued agent's second trace row included", () => {
  const out = report([RUN_LINE, sessionLine(hash), depthRow("a1"), traceRow("a1"), traceRow("a1")]);
  assert.doesNotMatch(out, /COLLECTION GAP — run/);
});
