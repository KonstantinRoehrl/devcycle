import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";
import { repoSlug, gitToplevel } from "../../scripts/run-record.mjs";

const HOOK = new URL("../../hooks/workload-sensor.mjs", import.meta.url).pathname;

function stateMd({ stage = "execution", kind = "feature", run = "00000000000000a1", base }) {
  return [
    "# devcycle state", `- stage: ${stage}`, "- root: /x",
    base ? `- branch: topic (cut from main at ${base})` : "- branch: topic", "- request: x",
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

test("writes a workload after a commit made in branch-review (carry-over fix)", () => {
  const { repo, runsDir } = setup();
  // setup() made exactly one commit on top of base, so base is HEAD~1. Rewrite the
  // state file to branch-review — the stage a carry-over fix commits in — keeping that base.
  const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD~1"], { encoding: "utf8" }).stdout.trim();
  writeInto(repo, ".devcycle/state.md", stateMd({ stage: "branch-review", base }));
  const r = callHook(repo, runsDir);
  assert.strictEqual(r.status, 0);
  const wl = workloads(runsDir, repo);
  assert.strictEqual(wl.length, 1);
  assert.strictEqual(wl[0].requestKind, "feature");
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

test("writes no phantom zero-diff record before any commit when the recorded base is abbreviated", () => {
  // The real pipeline records an ABBREVIATED base sha (this repo's state.md carries a 7-char
  // sha). A full-string `sha === st.base` compare can never match it, so the phantom-zero guard
  // must normalize the recorded base to a full sha before comparing.
  const repo = makeRepo();
  const full = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const base = full.slice(0, 7);
  const runsDir = makeRepo();
  writeInto(repo, ".devcycle/state.md", stateMd({ base }));
  const r = callHook(repo, runsDir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("writes a workload after a commit when the recorded base is abbreviated", () => {
  const repo = makeRepo();
  const base = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim().slice(0, 7);
  const runsDir = makeRepo();
  writeInto(repo, ".devcycle/state.md", stateMd({ base }));
  writeInto(repo, "f.txt", "hello\nworld\n");
  commitAll(repo, "task 1");
  const r = callHook(repo, runsDir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(workloads(runsDir, repo).length, 1);
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

test("derives the base from the default branch's merge-base when the branch line carries no annotation", () => {
  const repo = makeRepo(); const runsDir = makeRepo();
  sh("git", ["checkout", "-q", "-b", "topic"], { cwd: repo });
  writeInto(repo, ".devcycle/state.md", stateMd({ base: null }));
  writeInto(repo, "f.txt", "hello\nworld\n");
  commitAll(repo, "task 1");
  const r = callHook(repo, runsDir);
  assert.strictEqual(r.status, 0);
  const wl = workloads(runsDir, repo);
  assert.strictEqual(wl.length, 1);
  assert.ok(wl[0].insertions >= 2);
  assert.ok(wl[0].filesCreated >= 1, "f.txt (and the untracked state file, which git add -A also stages) count as created");
});

test("without an annotation, HEAD on the default branch itself is a no-op — nothing to measure", () => {
  const repo = makeRepo(); const runsDir = makeRepo();
  writeInto(repo, ".devcycle/state.md", stateMd({ base: null }));
  writeInto(repo, "f.txt", "hello\n");
  commitAll(repo, "on main");
  assert.strictEqual(callHook(repo, runsDir).status, 0);
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("without an annotation, a topic branch at its merge-base is a no-op — no phantom zero-diff record", () => {
  const repo = makeRepo(); const runsDir = makeRepo();
  sh("git", ["checkout", "-q", "-b", "topic"], { cwd: repo });
  writeInto(repo, ".devcycle/state.md", stateMd({ base: null }));
  assert.strictEqual(callHook(repo, runsDir).status, 0);
  assert.strictEqual(workloads(runsDir, repo).length, 0);
});

test("derives the base from the integration branch a topic was cut from, not from the default", () => {
  // `references/branch.md` § "Deriving a branch's file set" puts the integration branch ahead of
  // the default in the base order. An integration branch is permanently ahead of the default
  // (squash-merge artifact), so measuring this topic against the default would bill every
  // unreleased integration commit to this cycle instead of the two lines the topic added.
  const repo = makeRepo(); const runsDir = makeRepo();
  sh("git", ["checkout", "-q", "-b", "dev"], { cwd: repo });
  writeInto(repo, "unreleased.txt", "a\nb\nc\n");
  writeInto(repo, ".devcycle/state.md", stateMd({ base: null }));
  commitAll(repo, "unreleased dev work");
  sh("git", ["checkout", "-q", "-b", "topic"], { cwd: repo });
  writeInto(repo, "f.txt", "hello\nworld\n");
  commitAll(repo, "task 1");
  assert.strictEqual(callHook(repo, runsDir).status, 0);
  const wl = workloads(runsDir, repo);
  assert.strictEqual(wl.length, 1);
  // dev..topic is exactly f.txt, added, two lines.
  assert.strictEqual(wl[0].filesChanged, 1);
  assert.strictEqual(wl[0].filesCreated, 1);
  assert.strictEqual(wl[0].insertions, 2);
});

test("derives the base in a clone whose default branch exists only as a remote-tracking ref", () => {
  // A fresh clone with no local branch for the default: `refs/remotes/origin/HEAD` resolves but
  // the bare name it points at does not, so the base must be spelled `origin/<name>`
  // (`references/branch.md` § "Names first: validate, then quote"). Spelling it bare made
  // `git merge-base` fail and the sensor silently record nothing.
  const origin = makeRepo(); const runsDir = makeRepo();
  const repo = join(mkdtempSync(join(tmpdir(), "devcycle-test-clone-")), "clone");
  sh("git", ["clone", "-q", origin, repo]);
  sh("git", ["checkout", "-q", "-b", "topic"], { cwd: repo });
  sh("git", ["branch", "-q", "-D", "main"], { cwd: repo });
  writeInto(repo, ".devcycle/state.md", stateMd({ base: null }));
  writeInto(repo, "f.txt", "hello\nworld\n");
  commitAll(repo, "task 1");
  assert.strictEqual(callHook(repo, runsDir).status, 0);
  const wl = workloads(runsDir, repo);
  assert.strictEqual(wl.length, 1);
  // origin/main..topic is the state file plus f.txt, both added.
  assert.strictEqual(wl[0].filesChanged, 2);
  assert.strictEqual(wl[0].filesCreated, 2);
});

test("falls back to main when origin/HEAD names a branch this clone cannot resolve", () => {
  // The old `if (!def)` form made the main/master fallback dead code after any successful
  // `symbolic-ref`, so an origin/HEAD pointing at a branch this clone does not carry left the
  // sensor with an unusable base and nothing recorded.
  const repo = makeRepo(); const runsDir = makeRepo();
  sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], { cwd: repo });
  sh("git", ["checkout", "-q", "-b", "topic"], { cwd: repo });
  writeInto(repo, ".devcycle/state.md", stateMd({ base: null }));
  writeInto(repo, "f.txt", "hello\nworld\n");
  commitAll(repo, "task 1");
  assert.strictEqual(callHook(repo, runsDir).status, 0);
  const wl = workloads(runsDir, repo);
  assert.strictEqual(wl.length, 1);
  // main..topic is the state file plus f.txt, both added.
  assert.strictEqual(wl[0].filesChanged, 2);
  assert.strictEqual(wl[0].filesCreated, 2);
});
