// Git-repo-identity primitives shared by the run-record writer and the learn engine. Kept in its
// own module so reusing gitToplevel does not widen the dream.mjs <-> doctor.mjs <-> promotions.mjs
// dependency web (see promotions.mjs's header on the cycle that web once formed).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

// Canonicalize a linked worktree to the main checkout that owns the shared .git, so every
// worktree of one repo resolves to one toplevel (issue #104). --git-common-dir's parent is the
// main root and is byte-identical to --show-toplevel on a normal checkout.
export function gitToplevel(cwd, run = spawnSync) {
  const common = run(
    "git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" });
  if (common.status === 0 && common.stdout.trim()) return dirname(common.stdout.trim());
  const top = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 ? top.stdout.trim() : cwd;
}

// Every live worktree of the repo containing repoRoot, absolute paths. One `git worktree list`
// — never a per-session git call — keeps corpus gathering slug-scoped (spec §10). On any git
// failure the result is [repoRoot], i.e. today's single-checkout behavior.
export function worktreeRoots(repoRoot, run = spawnSync) {
  const out = run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (!out || out.status !== 0 || !out.stdout) return [repoRoot];
  const roots = out.stdout.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim())
    .filter(Boolean);
  return roots.length ? roots : [repoRoot];
}
