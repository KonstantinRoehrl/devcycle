#!/usr/bin/env node
// Pre-flight check for a devcycle plan: for each non-test file a task modifies, find repo code
// files that reference it (by module basename) but appear in no task's Files block. A referencing
// TEST file is a hard failure (it almost certainly needs updating); a non-test referencer is a
// warning. Language-agnostic; conservative. See playbooks/planning-waves.md.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";
import { taskBlocks, taskFileMap, TEST_FILE_SUFFIXES } from "./task-files.mjs";

const [, , planPath, repoRootArg] = process.argv;
if (!planPath) {
  console.error("usage: node scripts/blast-radius-check.mjs <plan-file> [repo-root]");
  process.exit(1);
}
if (!existsSync(planPath)) {
  console.error(`blast-radius-check: plan file not found: ${planPath}`);
  process.exit(1);
}
const repoRoot = repoRootArg || process.cwd();

const TEST_SUFFIXES = [...TEST_FILE_SUFFIXES, ".test.jsx", ".test.tsx", ".spec.ts", ".spec.js"];
const CODE_EXT = new Set([".mjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".devcycle"]);

const isTestFile = (p) => TEST_SUFFIXES.some((s) => p.endsWith(s));

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const text = readFileSync(planPath, "utf8");
const blocks = taskBlocks(text);
// A plan that yields no tasks is a parse failure, not a plan with no blast radius: without this
// the walk below has nothing to match and prints ok against an empty list.
if (blocks.length === 0) {
  console.error(`blast-radius-check: no "### Task N" blocks found in ${planPath}`);
  process.exit(1);
}
const declared = new Set([...taskFileMap(text).values()].flatMap((files) => [...files]));
// The walk below reasons over `declared`, not over the blocks: a plan whose tasks name no files
// at all matches nothing and would print ok against an empty list just as a heading-less one would.
if (declared.size === 0) {
  console.error(`blast-radius-check: no "**Files:**" blocks found in ${planPath}`);
  process.exit(1);
}
const changed = [...declared].filter((f) => !isTestFile(f));

const codeFiles = walk(repoRoot)
  .map((p) => relative(repoRoot, p).split(sep).join("/"))
  .filter((p) => CODE_EXT.has(extname(p)));

const hardFails = [];
const warnings = [];
for (const chg of changed) {
  const base = basename(chg, extname(chg));
  const tokenRe = new RegExp(`[/.'"\`]${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const cand of codeFiles) {
    if (cand === chg || declared.has(cand)) continue;
    let content;
    try {
      content = readFileSync(join(repoRoot, cand), "utf8");
    } catch {
      continue;
    }
    if (!tokenRe.test(content)) continue;
    (isTestFile(cand) ? hardFails : warnings).push({ cand, chg });
  }
}

for (const w of warnings) {
  console.error(`blast-radius-check: warning -- ${w.cand} references ${w.chg} but is in no task's Files block`);
}
if (hardFails.length > 0) {
  for (const h of hardFails) {
    console.error(`blast-radius-check: ${h.cand} (test) references ${h.chg} but is in no task's Files block -- add it or record an override`);
  }
  process.exit(1);
}
console.log(`blast-radius-check: ok -- no unlisted test-file consumers (${warnings.length} non-test warning(s))`);
process.exit(0);
