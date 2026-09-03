#!/usr/bin/env node
// #167: in a wave with concurrent, file-disjoint siblings sharing one checkout, a whole-suite red
// can be caused by a sibling's uncommitted edit, not the task under review. Given the task's declared
// Files, this reports every dirty/untracked path in the working tree that is NOT one of them — the
// "foreign-change set". executing-waves.md step 6 consults it on a green-gate failure to decide
// whether a red is the task's own or a sibling's. Language/repo-agnostic; `git status --porcelain`
// already respects .gitignore. Reuses scripts/task-files.mjs's normalizeFileToken so a code-span- or
// punctuation-wrapped task token matches the same way it does for blast-radius-check.
import { spawnSync } from "node:child_process";
import { normalizeFileToken } from "./task-files.mjs";

// Normalize a real filesystem path to its comparison key. Reuses task-files.mjs's
// normalizeFileToken (QC3) for the plan-prose stripping both sides need — code spans,
// wrapping punctuation, `:N-M` line refs — so a code-span-wrapped task arg matches its
// dirty path. But normalizeFileToken returns null for a token that collides with the plan
// grammar (the `Create`/`Modify`/`Test` LABELS, the `-` placeholder sentinel) or fails its
// path-shape gate — correct when parsing a task's **Files:** prose, WRONG for a real path:
// a genuinely-foreign dirty file literally named `Test` or `-` would be silently dropped and
// the tree falsely reported clean (QC2: never silently drop a dirty path). On null we fall
// back to the same stripping without those drops, so a real path is always classified. Both
// the git-status side and the task-argument side run through this, so they compare equal.
function normalizePath(raw) {
  const viaToken = normalizeFileToken(raw, { trusted: true });
  if (viaToken) return viaToken;
  let tok = String(raw).replace(/^[`(),]+/, "").replace(/[`(),.]+$/, "");
  tok = tok.replace(/:\d+-\d+$/, "").replace(/:$/, "");
  return tok;
}

const taskArgs = process.argv.slice(2);
if (taskArgs.length === 0) {
  console.error("usage: node scripts/foreign-change-check.mjs <task-file>...");
  process.exit(1);
}

const taskFiles = new Set();
for (const raw of taskArgs) {
  const tok = normalizePath(raw);
  if (tok) taskFiles.add(tok);
}

const st = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (st.status !== 0) {
  console.error(`foreign-change-check: git status failed: ${st.stderr?.trim() ?? "unknown error"}`);
  process.exit(1);
}

// Each porcelain line is `XY <path>` (rename lines carry `orig -> new`; take the destination).
const foreign = [];
for (const line of st.stdout.split("\n")) {
  if (!line.trim()) continue;
  let path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  if (arrow !== -1) path = path.slice(arrow + 4);
  path = path.replace(/^"(.*)"$/, "$1"); // porcelain quotes paths with special chars
  const tok = normalizePath(path);
  if (tok && !taskFiles.has(tok)) foreign.push(tok);
}

if (foreign.length === 0) {
  console.log("foreign-change-check: clean — no foreign paths");
  process.exit(0);
}
console.error("foreign-change-check: foreign uncommitted paths outside the task's Files set:");
for (const p of foreign) console.error(`foreign-change-check: ${p}`);
process.exit(1);
