// The branches cycle work is never committed to directly. references/branch.md § Committing owns the
// integration-branch list and how the default branch resolves; this is their one runtime spelling,
// which prose cannot hand a script or a hook.
import { spawnSync } from "node:child_process";

export const INTEGRATION_BRANCHES = ["dev", "develop", "development", "integration"];

// § Resolving the default branch, with git's own `init.defaultBranch` in place of its `gh` step: a
// resume never waits on the network. origin/HEAD names one branch; without it, every local branch
// that may be the default is returned, so an unresolved default protects each candidate instead of
// guessing one. Empty when no candidate exists.
export function defaultBranches(cwd) {
  const git = (...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const remoteHead = git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  if (remoteHead.status === 0 && remoteHead.stdout.trim()) return [remoteHead.stdout.trim().replace(/^origin\//, "")];
  const configured = git("config", "--get", "init.defaultBranch").stdout.trim();
  return [...new Set([configured, "main", "master"])]
    .filter((name) => name && git("show-ref", "--verify", "--quiet", `refs/heads/${name}`).status === 0);
}

export const isProtectedBranch = (cwd, name) => INTEGRATION_BRANCHES.includes(name) || defaultBranches(cwd).includes(name);
