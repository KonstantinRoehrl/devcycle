// Owns whether a branch's work reached its base: one signal per export — the cut annotation a
// state file or ledger records, the merged-PR lookup, and the squash-aware content comparison.
// Each caller composes the signals it needs; this module draws no verdict of its own.
import { execFileSync, spawnSync } from "node:child_process";

// Short, because an offline or unauthenticated gh must not hold a session resume up.
export const GH_TIMEOUT_MS = 5000;

// `(cut from <base> at <sha>)`, with backticks optional: a state file's `branch:` line writes it bare,
// a ledger's `Branch:` header wraps the names in backticks.
export const CUT_RE = /\(cut from `?([^`\s,)]+)`? at `?([0-9a-f]{7,40})`?\)/;

export function parseCut(text) {
  const m = CUT_RE.exec(text);
  return m ? { base: m[1], sha: m[2] } : null;
}

// null when gh cannot answer (missing, unauthenticated, offline), so the caller falls back to history.
export function mergedPrAt(root, head, { timeout = GH_TIMEOUT_MS, env = process.env } = {}) {
  const r = spawnSync("gh", ["pr", "list", "--state", "merged", "--head", head, "--json", "number,headRefOid", "--limit", "1"],
    { cwd: root, encoding: "utf8", timeout, env });
  if (r.error || r.status !== 0) return null;
  try {
    const prs = JSON.parse(r.stdout);
    return { merged: prs.length > 0, headOid: prs[0]?.headRefOid ?? null };
  } catch {
    return null;
  }
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Offline: a squash merge leaves no ancestry link, so a ref has landed when every path it changed
// under `pathspec` since the merge-base has its blob — or its deletion — somewhere in base's history
// for that path since the merge-base. A later change on base does not un-land it. null when the ref
// changed nothing under `pathspec`: there is no content to have landed.
export function contentLanded({ root, mergeBase, base, ref, pathspec = "." }) {
  const blobAt = (rev, path) => {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { cwd: root, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const changed = git(root, ["diff", "--no-renames", "--name-only", "-z", mergeBase, ref, "--", pathspec])
    .split("\0").filter(Boolean);
  if (changed.length === 0) return null;
  return changed.every((path) => {
    const want = blobAt(ref, path);
    return git(root, ["rev-list", `${mergeBase}..${base}`, "--", path])
      .split("\n").filter(Boolean)
      .some((commit) => blobAt(commit, path) === want);
  });
}
