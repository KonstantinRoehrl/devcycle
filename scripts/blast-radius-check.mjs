#!/usr/bin/env node
// Pre-flight check for a devcycle plan: for each non-test file a task modifies, find repo code
// files that reference it (by module basename) but appear in no task's Files block. A referencing
// TEST file is a hard failure (it almost certainly needs updating); a non-test referencer is a
// warning. Language-agnostic; conservative. See playbooks/planning-waves.md.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";
import { taskBlocks, taskFileMap, TEST_FILE_SUFFIXES, normalizeFileToken } from "./task-files.mjs";

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
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".devcycle", ".worktrees"]);

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
const filesByTask = taskFileMap(text);
const declared = new Set([...filesByTask.values()].flatMap((files) => [...files]));
// The walk below reasons over `declared`, not over the blocks: a plan whose tasks name no files
// at all matches nothing and would print ok against an empty list just as a heading-less one would.
if (declared.size === 0) {
  // The same split, from the same map, as wave-disjointness-check's -- and deliberately the same
  // sentence. Both gates read one taskFileMap, so a plan whose blocks say "none" that made one
  // gate report the blocks missing and the other report them empty sent the author to two repairs
  // for one plan.
  const message =
    filesByTask.size === 0
      ? `no "**Files:**" blocks found in ${planPath}`
      : `no task in ${planPath} declares a file -- its "**Files:**" blocks are present but empty`;
  console.error(`blast-radius-check: ${message}`);
  process.exit(1);
}
const changed = [...declared].filter((f) => !isTestFile(f));

const codeFiles = walk(repoRoot)
  .map((p) => relative(repoRoot, p).split(sep).join("/"))
  .filter((p) => CODE_EXT.has(extname(p)));

// The resolution planning-waves.md documents: a planner acknowledges a referencing test that does
// not need updating, with a reason, and the gate clears rather than being walked around in prose.
//   - Blast-radius override: <changed-file> [→ <test-file>] — <reason>
// File-only clears every test-referencer of that file; "→ test" clears just that pair. A missing
// reason is an error — an unexplained override is exactly the silent walk-around this gate prevents.
const OVERRIDE_START = /^\s*-\s*Blast-radius override:/;
const OVERRIDE_RE = /^\s*-\s*Blast-radius override:\s*(\S+?)(?:\s*→\s*(\S+))?\s*—\s*(.*\S)\s*$/;
const overrides = [];
for (const { text } of blocks) {
  for (const line of text.split("\n")) {
    if (!OVERRIDE_START.test(line)) continue;
    const m = line.match(OVERRIDE_RE);
    // Normalize both captures through the same normalizeFileToken the declaration side ran
    // every "**Files:**" token through, so an override written with backticks or trailing
    // punctuation -- exactly how planners write paths elsewhere -- still matches `chg` below.
    const file = m ? normalizeFileToken(m[1]) : null;
    const test = m && m[2] !== undefined ? normalizeFileToken(m[2]) : null;
    // A present "→ <test>" whose token does not normalize to a path is malformed just as a bad
    // changed-file token is; otherwise it would silently widen the override from the single pair
    // to every test-referencer of the changed file.
    if (!m || file === null || (m[2] !== undefined && test === null)) {
      console.error(`blast-radius-check: malformed override (needs "<changed-file> [→ <test>] — <reason>"): ${line.trim()}`);
      process.exit(1);
    }
    overrides.push({ file, test, reason: m[3] });
  }
}

const hardFails = [];
const warnings = [];
const acknowledged = [];
for (const chg of changed) {
  const base = basename(chg); // keep the extension: `config.md`, not `config`
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
    if (isTestFile(cand)) {
      const ov = overrides.find((o) => o.file === chg && (o.test === null || o.test === cand));
      if (ov) acknowledged.push({ cand, chg, reason: ov.reason });
      else hardFails.push({ cand, chg });
    } else {
      warnings.push({ cand, chg });
    }
  }
}

for (const w of warnings) {
  console.error(`blast-radius-check: warning -- ${w.cand} references ${w.chg} but is in no task's Files block`);
}
for (const a of acknowledged) {
  console.error(`blast-radius-check: override -- ${a.cand} references ${a.chg}, cleared: ${a.reason}`);
}
if (hardFails.length > 0) {
  for (const h of hardFails) {
    console.error(`blast-radius-check: ${h.cand} (test) references ${h.chg} but is in no task's Files block -- add it or record an override`);
  }
  process.exit(1);
}
console.log(`blast-radius-check: ok -- no unlisted test-file consumers (${warnings.length} non-test warning(s))`);
process.exit(0);
