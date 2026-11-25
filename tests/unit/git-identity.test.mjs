import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitToplevel, worktreeRoots, worktrees } from "../../scripts/git-identity.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, sh } from "./helpers.mjs";

const fake = (responses) => (cmd, args) => {
  const key = args.join(" ");
  for (const [match, res] of responses) if (key.includes(match)) return res;
  return { status: 1, stdout: "" };
};

test("worktreeRoots parses --porcelain output into absolute paths", () => {
  const run = fake([["worktree list --porcelain",
    { status: 0, stdout: "worktree /a/repo\nHEAD abc\nbranch refs/heads/dev\n\nworktree /a/repo-wt\nHEAD def\n" }]]);
  assert.deepEqual(worktreeRoots("/a/repo", run, () => true), ["/a/repo", "/a/repo-wt"]);
});

test("worktreeRoots degrades to [repoRoot] on git failure", () => {
  const run = fake([]); // every call returns status 1
  assert.deepEqual(worktreeRoots("/a/repo", run), ["/a/repo"]);
});

test("gitToplevel canonicalizes a worktree via --git-common-dir", () => {
  const run = fake([["--git-common-dir", { status: 0, stdout: "/a/repo/.git\n" }]]);
  assert.equal(gitToplevel("/a/repo-wt", run), "/a/repo");
});

test("gitToplevel falls back to cwd when git is unavailable", () => {
  assert.equal(gitToplevel("/gone", fake([])), "/gone");
});

const PORCELAIN = [
  "worktree /a/repo", "HEAD abc", "branch refs/heads/dev", "",
  "worktree /a/wt-1", "HEAD def", "detached", "",
  "worktree /a/wt-2", "HEAD 123", "branch refs/heads/feat/b", "prunable gitdir file points to non-existent location", "",
].join("\n");

test("worktrees parses branch, detached and prunable blocks", () => {
  const run = fake([["worktree list --porcelain", { status: 0, stdout: PORCELAIN }]]);
  assert.deepEqual(worktrees("/a/repo", run, () => true), [
    { path: "/a/repo", branch: "dev", prunable: false },
    { path: "/a/wt-1", branch: null, prunable: false },
    { path: "/a/wt-2", branch: "feat/b", prunable: true },
  ]);
});

test("worktrees leaves out a worktree whose directory does not exist", () => {
  const run = fake([["worktree list --porcelain", { status: 0, stdout: PORCELAIN }]]);
  assert.deepEqual(worktrees("/a/repo", run, (p) => p !== "/a/wt-1").map((w) => w.path), ["/a/repo", "/a/wt-2"]);
  assert.deepEqual(worktreeRoots("/a/repo", run, (p) => p === "/a/repo"), ["/a/repo"]);
});

test("worktrees is empty on git failure", () => {
  assert.deepEqual(worktrees("/a/repo", fake([]), () => true), []);
});

test("worktrees skips a real worktree whose directory was removed", () => {
  const repo = realpathSync(makeRepo());
  const parent = makeTempDir("git-identity-wt-");
  try {
    const live = join(parent, "live");
    const gone = join(parent, "gone");
    sh("git", ["worktree", "add", "-q", "-b", "feat/live", live], { cwd: repo });
    sh("git", ["worktree", "add", "-q", "-b", "feat/gone", gone], { cwd: repo });
    rmSync(gone, { recursive: true, force: true });
    const listed = worktrees(repo);
    assert.deepEqual(listed.map((w) => w.branch), ["main", "feat/live"]);
    assert.equal(realpathSync(listed[1].path), realpathSync(live));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
