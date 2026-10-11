// scripts/branch-names.mjs: which branches cycle work never commits to. Each case is a throwaway repo;
// the user's and the system's git config are shut out, so only what a case sets counts.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultBranches, isProtectedBranch } from "../../scripts/branch-names.mjs";
import { makeRepo, sh } from "./helpers.mjs";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

// A repo whose only branch is `name`, plus `extra` branches.
function repoOn(name, extra = []) {
  const repo = makeRepo();
  if (name !== "main") sh("git", ["branch", "-qm", "main", name], { cwd: repo });
  for (const branch of extra) sh("git", ["branch", "-q", branch], { cwd: repo });
  return repo;
}

test("origin/HEAD names the default branch, whatever it is called", () => {
  const repo = repoOn("trunk", ["main"]);
  sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], { cwd: repo });
  assert.deepEqual(defaultBranches(repo), ["trunk"]);
  assert.equal(isProtectedBranch(repo, "trunk"), true);
  assert.equal(isProtectedBranch(repo, "main"), false);
});

test("without origin/HEAD, init.defaultBranch names it when that branch exists", () => {
  const repo = repoOn("trunk");
  sh("git", ["config", "init.defaultBranch", "trunk"], { cwd: repo });
  assert.deepEqual(defaultBranches(repo), ["trunk"]);
  assert.equal(isProtectedBranch(repo, "trunk"), true);
});

test("an unresolved default protects every candidate that exists, and none when none does", () => {
  assert.deepEqual(defaultBranches(repoOn("main", ["master"])), ["main", "master"]);
  assert.deepEqual(defaultBranches(repoOn("main")), ["main"]);
  const unnamed = repoOn("trunk");
  assert.deepEqual(defaultBranches(unnamed), []);
  assert.equal(isProtectedBranch(unnamed, "trunk"), false);
});

test("the integration branches are protected in any repo", () => {
  const repo = repoOn("main");
  for (const name of ["dev", "develop", "development", "integration"]) assert.equal(isProtectedBranch(repo, name), true, name);
  assert.equal(isProtectedBranch(repo, "feat/x"), false);
});
