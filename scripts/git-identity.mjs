// Git-repo-identity primitives shared by the run-record writer and the learn engine. Kept in its
// own module so reusing gitToplevel does not widen the dream.mjs <-> doctor.mjs <-> promotions.mjs
// dependency web (see promotions.mjs's header on the cycle that web once formed).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// Canonicalize a linked worktree to the main checkout that owns the shared .git, so every
// worktree of one repo resolves to one toplevel (issue #104). --git-common-dir's parent is the
// main root and is byte-identical to --show-toplevel on a normal checkout.
export function gitToplevel(cwd, run = spawnSync) {
  const common = run(
    "git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", windowsHide: true });
  if (common.status === 0 && common.stdout.trim()) return dirname(common.stdout.trim());
  const top = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  return top.status === 0 ? top.stdout.trim() : cwd;
}

// Every worktree of the repo containing repoRoot whose directory still exists: absolute path,
// checked-out branch (null when detached) and whether git marks it prunable. One `git worktree
// list` — never a per-session git call — keeps corpus gathering slug-scoped (spec §10). The
// exists check decides what is listed, since not every git version prints `prunable`. On any git
// failure the result is [].
export function worktrees(repoRoot, run = spawnSync, exists = existsSync) {
  const out = run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (!out || out.status !== 0 || !out.stdout) return [];
  return out.stdout.split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length).trim();
      const ref = lines.find((l) => l.startsWith("branch refs/heads/"));
      return {
        path,
        branch: ref ? ref.slice("branch refs/heads/".length).trim() : null,
        prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
      };
    })
    .filter((w) => w.path && exists(w.path));
}

// Every live worktree of the repo containing repoRoot, absolute paths. On any git failure the
// result is [repoRoot], i.e. today's single-checkout behavior.
export function worktreeRoots(repoRoot, run = spawnSync, exists = existsSync) {
  const roots = worktrees(repoRoot, run, exists).map((w) => w.path);
  return roots.length ? roots : [repoRoot];
}
