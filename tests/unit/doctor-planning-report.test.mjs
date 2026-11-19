import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readRunRecords, summarizeSession, renderReport } from "../../scripts/doctor.mjs";

const RUN = "0f1e2d3c4b5a6978";
const SESSION = "sess-planning-breakdown-1";
const TS = "2026-10-07T07:05:00Z";
const cost = (agentId, role, usd) => ({ kind: "agent-cost", runId: RUN, stage: "planning", agentType: "devcycle:implementer", agentId,
  model: "claude-sonnet-5-5", ...(role ? { role } : {}), inputTokens: 10, cacheWriteTokens: 100, cacheReadTokens: 1000, outputTokens: 20,
  usd, turns: 3, explicitModel: true, continuationOf: 0, ts: TS });
const depth = (agentId, tokens) => ({ kind: "agent-depth", runId: RUN, stage: "planning", agentId, agentType: "devcycle:implementer",
  model: "claude-sonnet-5-5", tokens, depth: "ok", ts: TS });
const PLAN_STATS = { kind: "plan-stats", runId: RUN, stage: "planning", specBytes: 10000, planBytes: 40000, fenceShare: 0.2, tasks: 4,
  waves: 2, strategy: "delegated", drafters: 1, subagentUsd: 0.0015, specReview: "pass", ts: TS };

function runsDir(lines) {
  const dir = makeTempDir("doctor-planning-report");
  mkdirSync(join(dir, "repo-00000000"), { recursive: true });
  writeFileSync(join(dir, "repo-00000000", `${RUN}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

const turn = { sessionId: SESSION, isSidechain: false, type: "assistant", timestamp: "2026-10-07T07:05:00.000Z",
  message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 100000 } } };
const ctx = { repo: "devcycle", today: "2026-10-07", scope: "every devcycle-tagged session" };
const BASE = [
  { kind: "run", runId: RUN, schemaVersion: 1, pluginVersion: "0.33.0", repoSlug: "repo-00000000", startedAt: "2026-10-07T07:00:00Z" },
  { kind: "session", runId: RUN, sessionHash: createHash("sha256").update(SESSION).digest("hex") },
  { kind: "stage", runId: RUN, stage: "planning", startedAt: "2026-10-07T07:00:00Z", endedAt: "2026-10-07T07:10:00Z", outcome: "complete" },
];

function planningSection(report) {
  const lines = report.split("\n");
  const start = lines.indexOf("### Planning breakdown (observed)");
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  return lines.slice(start, end).join("\n");
}

test("renderReport: the planning breakdown tables roles, the coordinator remainder and the P1-P12 rubric", () => {
  const dir = runsDir([...BASE, PLAN_STATS, cost("a1", "drafter", 0.001), cost("a2", "checker", 0.0005), depth("a1", 90000), depth("a2", 60000)]);
  const section = planningSection(renderReport([summarizeSession(SESSION, [turn], readRunRecords(dir))], ctx));
  assert.ok(section, "the planning breakdown section is rendered");
  assert.match(section, /Run 0f1e2d3c/);
  assert.match(section, /\| Role \| Cost \(observed\) \|/);
  assert.match(section, /\| drafter \| \$0\.0010 \|/);
  assert.match(section, /\| checker \| \$0\.0005 \|/);
  assert.match(section, /\| coordinator \| \$2\.\d\d \|/);
  assert.match(section, /\| P1 \| planning \$ \/ task \| [\d.]+ \| <= 2\.0 \| pass \|/);
  assert.match(section, /\| P2 \| .* \| — \| <= 1\.0 \| n\/a \|/);
  assert.match(section, /\| P12 \| .* \| pass \|/);
  assert.equal((section.match(/^\| P\d+ \|/gm) ?? []).length, 12);
});

test("renderReport: no planning breakdown for a run without planning data", () => {
  const noPlanning = runsDir([BASE[0], BASE[1], { ...BASE[2], stage: "execution" }]);
  assert.equal(planningSection(renderReport([summarizeSession(SESSION, [turn], readRunRecords(noPlanning))], ctx)), null);
  assert.equal(planningSection(renderReport([summarizeSession(SESSION, [turn])], ctx)), null);
});

const gateFail = (legs) => ({ kind: "event", runId: RUN, stage: "planning", event: "gate-ran", result: "fail", legs, ts: TS });

test("renderReport: roles whose subagents ran with no cost row read unknown, not $0.0000", () => {
  const dir = runsDir([...BASE, { ...PLAN_STATS, subagentUsd: 0 }, depth("a1", 90000)]);
  const section = planningSection(renderReport([summarizeSession(SESSION, [turn], readRunRecords(dir))], ctx));
  assert.match(section, /\| drafter \| unknown \|/);
  assert.match(section, /\| coordinator \| unknown \|/);
  assert.doesNotMatch(section, /\$0\.0000/);
});

test("renderReport: the section ends with one corpus-wide line of failing plan-check legs", () => {
  const dir = runsDir([...BASE, PLAN_STATS, gateFail("Drift,Blast"), gateFail("Drift")]);
  const section = planningSection(renderReport([summarizeSession(SESSION, [turn], readRunRecords(dir))], ctx));
  assert.match(section, /Failing plan-check legs: Drift 2, Blast 1\./);
  assert.match(section, /^Failing plan-check legs, all runs: Drift 2, Blast 1\.$/m);
  assert.equal((section.match(/all runs/g) ?? []).length, 1);
});

test("renderReport: no corpus legs line when no run has a failing leg", () => {
  const dir = runsDir([...BASE, PLAN_STATS, cost("a1", "drafter", 0.001), depth("a1", 90000)]);
  const section = planningSection(renderReport([summarizeSession(SESSION, [turn], readRunRecords(dir))], ctx));
  assert.match(section, /Failing plan-check legs: none\./);
  assert.doesNotMatch(section, /all runs/);
});
