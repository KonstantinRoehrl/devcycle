import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeRepo, commitAll, writeInto } from "./helpers.mjs";
import { repoSlug, gitToplevel } from "../../scripts/run-record.mjs";

const HOOK = new URL("../../hooks/workload-sensor.mjs", import.meta.url).pathname;

function stateMd({ stage = "execution", kind = "feature", run = "00000000000000a1", base }) {
  return [
    "# devcycle state", `- stage: ${stage}`, "- root: /x",
    `- branch: topic (cut from main at ${base})`, "- request: x",
    `- kind: ${kind}`, "- plan-counts: planned=3 waves=2", `- run: ${run}`,
    "- updated: 2026-08-28T00:00:00Z", "",
  ].join("\n");
}

function callHook(repoRoot, runsDir, extra = {}) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "git commit -m x" }, cwd: repoRoot, ...extra }),
    encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir },
  });
}

function workloads(runsDir, repoRoot) {
  const dir = join(runsDir, repoSlug(gitToplevel(repoRoot)));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((o) => o.kind === "workload");
}

function setup(kind = "feature") {
  const repo = makeRepo();
  const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const runsDir = makeRepo();
  writeInto(repo, ".devcycle/state.md", stateMd({ base, kind }));
  writeInto(repo, "f.txt", "hello\nworld\n");
  commitAll(repo, "task 1");
  return { repo, runsDir };
}

test("writes a workload after a commit in an active execution cycle", () => {
  const { repo, runsDir } = setup();
  const r = callHook(repo, runsDir);
  assert.strictEqual(r.status, 0);
  const wl = workloads(runsDir, repo);
  assert.strictEqual(wl.length, 1);
  assert.strictEqual(wl[0].requestKind, "feature");
  assert.strictEqual(wl[0].plannedTaskCount, 3);
  assert.ok(wl[0].insertions >= 2);
});

test("writes nothing for an audit cycle (GC3)", () => {
  const { repo, runsDir } = setup("audit");
  callHook(repo, runsDir);
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("no-ops when there is no active state file", () => {
  const repo = makeRepo(); const runsDir = makeRepo();
  const r = callHook(repo, runsDir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("no-ops for a subagent-origin call (agent_type present)", () => {
  const { repo, runsDir } = setup();
  callHook(repo, runsDir, { agent_type: "devcycle:implementer", agent_id: "x1" });
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("writes no phantom zero-diff record before any commit (HEAD == base)", () => {
  const repo = makeRepo();
  const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const runsDir = makeRepo();
  writeInto(repo, ".devcycle/state.md", stateMd({ base }));
  callHook(repo, runsDir);
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("does not re-write when HEAD and stage are unchanged since the cursor", () => {
  const { repo, runsDir } = setup();
  callHook(repo, runsDir);
  callHook(repo, runsDir);
  assert.strictEqual(workloads(runsDir, repo).length, 1);
});

test("malformed stdin is a silent no-op, exit 0, and writes nothing even in an active cycle", () => {
  const { repo, runsDir } = setup();
  // No JSON cwd survives a parse failure, so the hook would otherwise fall back to the *process's*
  // cwd (QC1/QC2 round-1 fix target) — pin the child's OS-level cwd to the sandboxed active-cycle
  // repo so this proves isolation without depending on, or risking a write into, this real checkout.
  const r = spawnSync("node", [HOOK], { input: "not json", encoding: "utf8", cwd: repo,
    env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "");
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});
