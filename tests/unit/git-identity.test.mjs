import { test } from "node:test";
import assert from "node:assert/strict";
import { gitToplevel, worktreeRoots } from "../../scripts/git-identity.mjs";

const fake = (responses) => (cmd, args) => {
  const key = args.join(" ");
  for (const [match, res] of responses) if (key.includes(match)) return res;
  return { status: 1, stdout: "" };
};

test("worktreeRoots parses --porcelain output into absolute paths", () => {
  const run = fake([["worktree list --porcelain",
    { status: 0, stdout: "worktree /a/repo\nHEAD abc\nbranch refs/heads/dev\n\nworktree /a/repo-wt\nHEAD def\n" }]]);
  assert.deepEqual(worktreeRoots("/a/repo", run), ["/a/repo", "/a/repo-wt"]);
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
