#!/usr/bin/env node
// Pre-flight check for a devcycle plan: for each non-test file a task modifies, find repo code
// files that reference it (by module basename) but appear in no task's Files block. A referencing
// TEST file is a hard failure (it almost certainly needs updating); a non-test referencer is a
// warning. Language-agnostic; conservative. See playbooks/planning-waves.md.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";
import { extractFiles } from "./task-files.mjs";

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

const TASK_HEADING_RE = /^### Task (\d+):.*$/gm;
const FILES_BLOCK_RE = /\*\*Files:\*\*\n([\s\S]*?)(?=\n\*\*|\n###|$)/;
const TEST_SUFFIXES = [".test.mjs", ".test.js", ".test.ts", ".test.jsx", ".test.tsx", "_test.py", ".spec.ts", ".spec.js"];
const CODE_EXT = new Set([".mjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".devcycle"]);

const isTestFile = (p) => TEST_SUFFIXES.some((s) => p.endsWith(s));

function declaredFiles(planText) {
  const set = new Set();
  const headings = [...planText.matchAll(TASK_HEADING_RE)];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : planText.length;
    const m = planText.slice(start, end).match(FILES_BLOCK_RE);
    if (m) for (const f of extractFiles(m[1])) set.add(f);
  }
  return set;
}

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
const declared = declaredFiles(text);
const changed = [...declared].filter((f) => !isTestFile(f));

const codeFiles = walk(repoRoot)
  .map((p) => relative(repoRoot, p).split(sep).join("/"))
  .filter((p) => CODE_EXT.has(extname(p)));

const hardFails = [];
const warnings = [];
for (const chg of changed) {
  const base = basename(chg, extname(chg));
  const tokenRe = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
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
