import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import { hashSession, recordPath } from "../../scripts/run-record.mjs";
import { logStep } from "../../scripts/stage-log.mjs";
import { planStats, planningEstimate, coordinatorDepth, planningActual, planningLine } from "../../scripts/plan-stats.mjs";

const SCRIPT = new URL("../../scripts/plan-stats.mjs", import.meta.url).pathname;
const RUN_RECORD = new URL("../../scripts/run-record.mjs", import.meta.url).pathname;

const MAP = "## Dispatch Map\n\n- Wave 1: Task 1, Task 2 (file-disjoint)\n- Wave 2: Task 3 (needs Task 1)\n";
const cost = (over) => ({ kind: "agent-cost", stage: "planning", role: "drafter", agentId: "a1", usd: 0.5, ...over });

const SESSION = "sess-plan-stats-1";
// 123456 context tokens of a 1M window; each turn prices at $1.066912 on claude-sonnet-5-5.
const turn = (over) => ({ sessionId: SESSION, isSidechain: false, type: "assistant", timestamp: "2026-11-20T10:05:00.000Z",
  message: { model: "claude-sonnet-5-5", usage: { input_tokens: 3456, cache_creation_input_tokens: 20000, cache_read_input_tokens: 100000, output_tokens: 100000 } },
  ...over });
// The session's transcript and one subagent's, plus a second session's transcript in the same project.
function projectsDir(cwd) {
  const projects = makeTempDir("plan-stats-projects");
  const slug = cwd.replaceAll("/", "-");
  writeInto(projects, `${slug}/${SESSION}.jsonl`, JSON.stringify(turn()) + "\n");
  writeInto(projects, `${slug}/${SESSION}/subagents/agent-a1.jsonl`, JSON.stringify(turn({ isSidechain: true, agentId: "a1" })) + "\n");
  writeInto(projects, `${slug}/sess-other.jsonl`, JSON.stringify(turn({ sessionId: "sess-other" })) + "\n");
  return projects;
}

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

test("subagentUsd sums planning agent-cost rows, is 0 for an inline plan that dispatched nothing, and null when any is null", () => {
  const s = (rows, strategy = "delegated") => planStats({ planText: "", specText: "", rows, strategy }).subagentUsd;
  assert.equal(s([], "inline"), 0);
  assert.equal(s([cost({ usd: 0.25 }), cost({ usd: 0.5, role: "checker" }), cost({ usd: 9, stage: "execution" })]), 0.75);
  assert.equal(s([cost({ usd: 0.25 }), cost({ usd: null })]), null);
});

test("subagentUsd is null, not 0, when planning subagents ran and no agent-cost row priced them", () => {
  const s = (rows, strategy) => planStats({ planText: "", specText: "", rows, strategy }).subagentUsd;
  const depth = { kind: "agent-depth", stage: "planning", agentId: "a1" };
  assert.equal(s([], "delegated"), null);
  assert.equal(s([depth], "delegated"), null);
  assert.equal(s([depth], "inline"), null);
  assert.equal(s([{ ...depth, stage: "execution" }], "inline"), 0);
  assert.equal(s([depth, cost({ usd: 0.25 })], "inline"), 0.25);
});

test("fenceShare follows CommonMark pairing: a longer outer fence holds inner triple-backtick blocks", () => {
  // "intro\n" 6 B + fenced 7+6+2+4+5 = 24 B + "outro\n" 6 B = 36 B; 24 / 36 = 0.667.
  const planText = "intro\n````md\n```js\nx\n```\n````\noutro\n";
  const s = planStats({ planText, specText: "", rows: [], strategy: "inline" });
  assert.equal(s.planBytes, 36);
  assert.equal(s.fenceShare, 0.667);
});

test("fenceShare counts a ~~~ block, and neither fence character closes the other", () => {
  // "intro\n" 6 + "~~~\n" 4 + "code\n" 5 + "~~~\n" 4 + "outro\n" 6 = 25 B; fenced 13 B; 13 / 25 = 0.52.
  const tilde = "intro\n~~~\ncode\n~~~\noutro\n";
  assert.equal(planStats({ planText: tilde, specText: "", rows: [], strategy: "inline" }).fenceShare, 0.52);
  // The ``` line inside the ~~~ block does not close it: "intro\n" 6 B + fenced 4+4+2+4 = 14 B = 20 B; 14 / 20 = 0.7.
  const mixed = "intro\n~~~\n```\nx\n~~~\n";
  assert.equal(planStats({ planText: mixed, specText: "", rows: [], strategy: "inline" }).fenceShare, 0.7);
});

test("specReview is the result of the LAST spec-review event, else null", () => {
  const ev = (result) => ({ kind: "event", event: "spec-review", result });
  const s = (rows) => planStats({ planText: "", specText: "", rows, strategy: "inline" }).specReview;
  assert.equal(s([]), null);
  assert.equal(s([ev("fail"), { kind: "event", event: "gate-ran", result: "fail" }, ev("pass")]), "pass");
  assert.equal(s([ev("pass"), ev("fail")]), "fail");
});

test("grouped planning runs subagents, so its unpriced dollars are unmeasurable, and checkpointed planning runs none", () => {
  const s = (strategy) => planStats({ planText: "", specText: "", rows: [], strategy }).subagentUsd;
  assert.equal(s("grouped"), null);
  assert.equal(s("checkpointed"), 0);
});

test("CLI refuses a strategy outside inline, delegated, grouped and checkpointed", () => {
  const dir = makeTempDir("plan-stats-bad-strategy");
  const r = cli(["--state", "s.md", "--plan", "p.md", "--spec", "c.md", "--strategy", "parallel"], { cwd: dir, runsDir: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /strategy must be one of inline, delegated, grouped, checkpointed, got "parallel"/);
});

// The session id and the transcript root are always fixtures, so a CLI run never reads the real session
// or walks ~/.claude/projects.
function cli(args, { cwd, runsDir, projects = makeTempDir("plan-stats-no-projects") }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd,
    env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_DOCTOR_PROJECTS: projects } });
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
  assert.equal(append("--kind", "session", "--sessionId", SESSION).status, 0);
  assert.equal(append("--kind", "stage", "--stage", "planning", "--startedAt", "2026-11-20T10:00:00Z",
    "--endedAt", "2026-11-20T10:10:00Z", "--outcome", "complete").status, 0);
  writeInto(repo, ".devcycle/state.md", `# devcycle state\n- stage: planning\n- run: ${runId}\n`);
  writeInto(repo, "plan.md", "### Task 1: a\n\n```sh\nnode x\n```\n\n" + MAP);
  writeInto(repo, "spec.md", "# Spec\n");
  return { repo, runsDir, runId };
}
const rows = (repo, runId) => readFileSync(recordPath(repo, runId), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("CLI appends one plan-stats row for the state file's run and prints its fields as JSON, then the planning line", () => {
  const { repo, runsDir, runId } = seededRepo();
  process.env.DEVCYCLE_RUNS_DIR = runsDir;
  logStep(join(repo, ".devcycle"), { run: runId, stage: "planning", key: "drafting-plan", data: { strategy: "grouped", groups: 2, drafters: 2, est: 4.2 } });
  const r = cli(["--state", ".devcycle/state.md", "--plan", "plan.md", "--spec", "spec.md", "--strategy", "delegated"],
    { cwd: repo, runsDir, projects: projectsDir(repo) });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  const row = rows(repo, runId).at(-1);
  assert.equal(row.kind, "plan-stats");
  assert.equal(row.stage, "planning");
  const { specBytes, planBytes, tasks, waves, strategy, drafters, subagentUsd, specReview } = row;
  assert.deepEqual({ specBytes, planBytes, tasks, waves, strategy, drafters, subagentUsd, specReview }, {
    specBytes: 7, planBytes: Buffer.byteLength(readFileSync(`${repo}/plan.md`, "utf8")), tasks: 3, waves: 2,
    strategy: "delegated", drafters: 1, subagentUsd: 0.25, specReview: "pass" });
  assert.ok(row.fenceShare > 0 && row.fenceShare < 1);
  assert.ok(row.nonTestFenceShare >= 0 && row.nonTestFenceShare <= row.fenceShare);
  assert.deepEqual([row.estUsd, row.coordinatorDepthPct], [4.2, 12.3]);
  assert.deepEqual(JSON.parse(lines[0]), { specBytes: row.specBytes, planBytes: row.planBytes, fenceShare: row.fenceShare,
    nonTestFenceShare: row.nonTestFenceShare, tasks: 3, waves: 2, drafters: 1, subagentUsd: 0.25, specReview: "pass", strategy: "delegated",
    estUsd: 4.2, coordinatorDepthPct: 12.3 });
  // actual is the planning stage's two priced turns, the session's own and its subagent's; sess-other is another session.
  assert.equal(lines[1], "planning: strategy=delegated drafters=1 est=$4.20 actual=$2.13");
});

test("CLI with no drafting-plan row and no transcript records null figures and prints ? for both dollars", () => {
  const { repo, runsDir, runId } = seededRepo();
  process.env.DEVCYCLE_RUNS_DIR = runsDir;
  const r = cli(["--state", ".devcycle/state.md", "--plan", "plan.md", "--spec", "spec.md", "--strategy", "inline"], { cwd: repo, runsDir });
  assert.equal(r.status, 0, r.stderr);
  const row = rows(repo, runId).at(-1);
  assert.deepEqual([row.kind, row.estUsd, row.coordinatorDepthPct], ["plan-stats", null, null]);
  assert.equal(r.stdout.trim().split("\n")[1], "planning: strategy=inline drafters=1 est=? actual=?");
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

test("nonTestFenceShare sits beside fenceShare and exempts a red-green task's failing test", () => {
  const planText = '### Task 1: t\n\n**Evidence:** red-green\n\n```js\ntest("x", () => {\n  assert.equal(1, 1);\n});\n```\n';
  const s = planStats({ planText, specText: "spec\n", rows: [], strategy: "inline" });
  assert.ok(s.fenceShare > 0);
  assert.equal(s.nonTestFenceShare, 0);
  assert.deepEqual(Object.keys(s).slice(2, 4), ["fenceShare", "nonTestFenceShare"]);
});

test("planningEstimate is the drafting-plan row's numeric est, and null for any other est or no row", () => {
  const plan = (est) => ({ stage: "planning", key: "drafting-plan", data: { strategy: "inline", est } });
  assert.equal(planningEstimate([{ key: "research-map", data: { est: 9 } }, plan(4.2)]), 4.2);
  assert.equal(planningEstimate([plan(0)]), 0);
  assert.equal(planningEstimate([plan(null)]), null);
  assert.equal(planningEstimate([plan("4.2")]), null);
  assert.equal(planningEstimate([{ key: "drafting-plan" }]), null);
  assert.equal(planningEstimate([{ key: "research-map", data: { est: 9 } }]), null);
});

test("planningEstimate covers the whole stage: est plus the spend logged at the cut, est alone without it, null without est", () => {
  const plan = (data) => ({ stage: "planning", key: "drafting-plan", data: { strategy: "inline", ...data } });
  assert.equal(planningEstimate([plan({ est: 4.2, spent: 1.1 })]), 5.3);
  assert.equal(planningEstimate([plan({ est: 4.2, spent: 0 })]), 4.2);
  assert.equal(planningEstimate([plan({ est: 4.2 })]), 4.2, "an older run logged no spent");
  assert.equal(planningEstimate([plan({ spent: 1.1 })]), null, "no est, nothing to add to");
  assert.equal(planningEstimate([plan({ est: 4.2, spent: "1.1" })]), 4.2, "a non-number spent is ignored");
  assert.equal(planningEstimate([plan({ est: 4.2, spent: null })]), 4.2, "an unreadable spend is ignored");
});

test("spent prints the planning dollars so far to cents, null when unreadable, and exits 2 without --state", () => {
  const { repo, runsDir, runId } = seededRepo();
  process.env.DEVCYCLE_RUNS_DIR = runsDir;
  const spent = cli(["spent", "--state", ".devcycle/state.md"], { cwd: repo, runsDir, projects: projectsDir(repo) });
  assert.equal(spent.status, 0, spent.stderr);
  assert.equal(spent.stdout, "2.13\n");
  const unreadable = cli(["spent", "--state", ".devcycle/state.md"], { cwd: repo, runsDir });
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.equal(unreadable.stdout, "null\n");
  for (const args of [["spent"], ["spent", "--bogus", "x"]]) {
    const r = cli(args, { cwd: repo, runsDir });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stderr, /^plan-stats: /);
    assert.match(r.stderr, /usage: plan-stats\.mjs spent --state <state\.md>/);
  }
  assert.equal(rows(repo, runId).filter((o) => o.kind === "plan-stats").length, 0, "spent appends nothing");
});

test("planningLine prints each dollar figure to two decimals, and ? for an unknown one", () => {
  assert.equal(planningLine({ strategy: "grouped", drafters: 2, estUsd: 4.2, actualUsd: 3.456 }),
    "planning: strategy=grouped drafters=2 est=$4.20 actual=$3.46");
  assert.equal(planningLine({ strategy: "inline", drafters: 0, estUsd: 0, actualUsd: null }),
    "planning: strategy=inline drafters=0 est=$0.00 actual=?");
  assert.equal(planningLine({ strategy: "checkpointed", drafters: 0, estUsd: null, actualUsd: 12 }),
    "planning: strategy=checkpointed drafters=0 est=? actual=$12.00");
});

test("coordinatorDepth is the main transcript's last depth as a percent of its window to one decimal, else null", () => {
  const cwd = "/work/repo";
  const projects = projectsDir(cwd);
  assert.equal(coordinatorDepth({ CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_DOCTOR_PROJECTS: projects }, cwd), 12.3);
  assert.equal(coordinatorDepth({ CLAUDE_DOCTOR_PROJECTS: projects }, cwd), null, "no session id");
  assert.equal(coordinatorDepth({ CLAUDE_CODE_SESSION_ID: "sess-missing", CLAUDE_DOCTOR_PROJECTS: projects }, cwd), null, "no transcript");
});

test("planningActual sums the planning dollars of this run's sessions only, subagents included, else null", () => {
  const cwd = "/work/repo";
  const projects = projectsDir(cwd);
  const runsDir = makeTempDir("plan-stats-actual-runs");
  const RUN = "0f1e2d3c4b5a6978";
  const lines = [
    { kind: "run", runId: RUN, schemaVersion: 1, pluginVersion: "0.33.0", repoSlug: "repo-00000000", startedAt: "2026-11-20T10:00:00Z" },
    { kind: "session", runId: RUN, sessionHash: hashSession(SESSION) },
    { kind: "stage", runId: RUN, stage: "planning", startedAt: "2026-11-20T10:00:00Z", endedAt: "2026-11-20T10:10:00Z", outcome: "complete" },
  ];
  writeInto(runsDir, `repo-00000000/${RUN}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const env = { CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_DOCTOR_PROJECTS: projects, DEVCYCLE_RUNS_DIR: runsDir };
  assert.equal(Math.round(planningActual(env, cwd, [hashSession(SESSION)]) * 1e6) / 1e6, 2.133824);
  assert.equal(planningActual(env, cwd, []), null, "no session of this run");
  assert.equal(planningActual({ ...env, CLAUDE_CODE_SESSION_ID: "sess-missing" }, cwd, [hashSession(SESSION)]), null, "no transcript");
  // With no planning stage line, the turns are unattributed, so nothing is known about planning.
  writeInto(runsDir, `repo-00000000/${RUN}.jsonl`, lines.slice(0, 2).map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(planningActual(env, cwd, [hashSession(SESSION)]), null, "no planning stage line");
});
