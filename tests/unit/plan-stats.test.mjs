import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { recordPath } from "../../scripts/run-record.mjs";
import { planStats } from "../../scripts/plan-stats.mjs";

const SCRIPT = new URL("../../scripts/plan-stats.mjs", import.meta.url).pathname;
const RUN_RECORD = new URL("../../scripts/run-record.mjs", import.meta.url).pathname;

const MAP = "## Dispatch Map\n\n- Wave 1: Task 1, Task 2 (file-disjoint)\n- Wave 2: Task 3 (needs Task 1)\n";
const cost = (over) => ({ kind: "agent-cost", stage: "planning", role: "drafter", agentId: "a1", usd: 0.5, ...over });

test("fenceShare is the bytes inside ``` fences, fence lines included, over the plan bytes", () => {
  const planText = "intro\n```js\nconst a = 1;\n```\noutro\n";
  const s = planStats({ planText, specText: "spec", rows: [], strategy: "inline" });
  assert.equal(s.planBytes, Buffer.byteLength(planText));
  assert.equal(s.specBytes, 4);
  assert.equal(s.fenceShare, Math.round(Buffer.byteLength("```js\nconst a = 1;\n```\n") / Buffer.byteLength(planText) * 1000) / 1000);
  assert.equal(s.strategy, "inline");
});

test("fenceShare counts bytes, not characters, and is 0 for an empty plan", () => {
  assert.equal(planStats({ planText: "", specText: "", rows: [], strategy: "inline" }).fenceShare, 0);
  const s = planStats({ planText: "é\n```\né\n```\n", specText: "", rows: [], strategy: "inline" });
  assert.equal(s.planBytes, 14);
  assert.equal(s.fenceShare, 0.786);
});

test("tasks and waves come from the LAST Dispatch Map, ignoring an earlier quoted heading", () => {
  const planText = "Quote: `## Dispatch Map`\n\n- Wave 9: Task 40\n\n### Task 1: a\n### Task 2: b\n### Task 3: c\n\n" + MAP;
  const s = planStats({ planText, specText: "", rows: [], strategy: "delegated" });
  assert.equal(s.tasks, 3);
  assert.equal(s.waves, 2);
});

test("a task referenced in a wave's parenthetical is not counted twice", () => {
  const s = planStats({ planText: MAP, specText: "", rows: [], strategy: "inline" });
  assert.equal(s.tasks, 3);
});

test("with no Dispatch Map, tasks falls back to the Task headings and waves is 0", () => {
  const s = planStats({ planText: "### Task 1: a\n\n### Task 2: b\n", specText: "", rows: [], strategy: "inline" });
  assert.equal(s.tasks, 2);
  assert.equal(s.waves, 0);
});

test("drafters is the distinct agentIds of planning drafter rows only", () => {
  const rows = [cost({ agentId: "a1" }), cost({ agentId: "a1" }), cost({ agentId: "a2" }),
    cost({ agentId: "a3", role: "checker" }), cost({ agentId: "a4", stage: "execution" }),
    { kind: "agent-depth", stage: "planning", agentId: "a5" }];
  assert.equal(planStats({ planText: "", specText: "", rows, strategy: "delegated" }).drafters, 2);
});

test("subagentUsd sums planning agent-cost rows, is 0 with none, and null when any is null", () => {
  const s = (rows) => planStats({ planText: "", specText: "", rows, strategy: "delegated" }).subagentUsd;
  assert.equal(s([]), 0);
  assert.equal(s([cost({ usd: 0.25 }), cost({ usd: 0.5, role: "checker" }), cost({ usd: 9, stage: "execution" })]), 0.75);
  assert.equal(s([cost({ usd: 0.25 }), cost({ usd: null })]), null);
});

test("specReview is the result of the LAST spec-review event, else null", () => {
  const ev = (result) => ({ kind: "event", event: "spec-review", result });
  const s = (rows) => planStats({ planText: "", specText: "", rows, strategy: "inline" }).specReview;
  assert.equal(s([]), null);
  assert.equal(s([ev("fail"), { kind: "event", event: "gate-ran", result: "fail" }, ev("pass")]), "pass");
  assert.equal(s([ev("pass"), ev("fail")]), "fail");
});

function cli(args, { cwd, runsDir }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd,
    env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir } });
}
function seededRepo() {
  const repo = realpathSync(makeRepo());
  const runsDir = makeTempDir("plan-stats-runs");
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: runsDir };
  const runId = spawnSync(process.execPath, [RUN_RECORD, "new", "--plugin-version", "0.32.2", "--plugin-sha", "ded29c6",
    "--profile", "lean"], { encoding: "utf8", cwd: repo, env }).stdout.trim();
  const append = (...args) => spawnSync(process.execPath, [RUN_RECORD, "append", "--run", runId, ...args], { encoding: "utf8", cwd: repo, env });
  assert.equal(append("--kind", "agent-cost", "--stage", "planning", "--agentType", "devcycle:plan-drafter",
    "--agentId", "a27cbd72da7b3b62f", "--model", "claude-sonnet-5-5", "--role", "drafter", "--inputTokens", "1",
    "--cacheWriteTokens", "1", "--cacheReadTokens", "1", "--outputTokens", "1", "--usd", "0.25", "--turns", "2",
    "--explicitModel", "true", "--continuationOf", "0").status, 0);
  assert.equal(append("--kind", "event", "--event", "spec-review", "--stage", "brainstorm", "--result", "pass").status, 0);
  writeInto(repo, ".devcycle/state.md", `# devcycle state\n- stage: planning\n- run: ${runId}\n`);
  writeInto(repo, "plan.md", "### Task 1: a\n\n```sh\nnode x\n```\n\n" + MAP);
  writeInto(repo, "spec.md", "# Spec\n");
  return { repo, runsDir, runId };
}
const rows = (repo, runId) => readFileSync(recordPath(repo, runId), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("CLI appends one plan-stats row for the state file's run and prints its fields as JSON", () => {
  const { repo, runsDir, runId } = seededRepo();
  process.env.DEVCYCLE_RUNS_DIR = runsDir;
  const r = cli(["--state", ".devcycle/state.md", "--plan", "plan.md", "--spec", "spec.md", "--strategy", "delegated"], { cwd: repo, runsDir });
  assert.equal(r.status, 0, r.stderr);
  const row = rows(repo, runId).at(-1);
  assert.equal(row.kind, "plan-stats");
  assert.equal(row.stage, "planning");
  const { specBytes, planBytes, tasks, waves, strategy, drafters, subagentUsd, specReview } = row;
  assert.deepEqual({ specBytes, planBytes, tasks, waves, strategy, drafters, subagentUsd, specReview }, {
    specBytes: 7, planBytes: Buffer.byteLength(readFileSync(`${repo}/plan.md`, "utf8")), tasks: 3, waves: 2,
    strategy: "delegated", drafters: 1, subagentUsd: 0.25, specReview: "pass" });
  assert.ok(row.fenceShare > 0 && row.fenceShare < 1);
  assert.deepEqual(JSON.parse(r.stdout), { specBytes: row.specBytes, planBytes: row.planBytes, fenceShare: row.fenceShare,
    tasks: 3, waves: 2, drafters: 1, subagentUsd: 0.25, specReview: "pass", strategy: "delegated" });
});

test("CLI exits 1 with one line for a bad strategy, an unreadable plan, or a state file with no run", () => {
  const { repo, runsDir, runId } = seededRepo();
  process.env.DEVCYCLE_RUNS_DIR = runsDir;
  const base = ["--state", ".devcycle/state.md", "--plan", "plan.md", "--spec", "spec.md", "--strategy", "inline"];
  const swap = (flag, value) => base.map((a, i) => (base[i - 1] === flag ? value : a));
  writeInto(repo, ".devcycle/no-run.md", "# devcycle state\n- stage: planning\n");
  for (const [args, message] of [
    [swap("--strategy", "both"), /strategy/],
    [swap("--plan", "missing.md"), /plan/],
    [swap("--state", ".devcycle/no-run.md"), /run/],
  ]) {
    const r = cli(args, { cwd: repo, runsDir });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr.trim(), /^plan-stats: /);
    assert.match(r.stderr, message);
    assert.equal(r.stderr.trim().split("\n").length, 1);
  }
  assert.equal(rows(repo, runId).filter((o) => o.kind === "plan-stats").length, 0, "no row on failure");
});
