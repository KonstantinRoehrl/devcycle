#!/usr/bin/env node
// Pre-flight check for a devcycle plan: for each non-test file a task modifies, find repo code
// files that reference it (by module basename) but appear in no task's Files block. Any such
// referencer -- test or non-test -- is a hard failure (it almost certainly needs updating), cleared
// only by adding it to a Files block or recording an override. Language-agnostic; conservative.
// See playbooks/planning-waves.md.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative, sep } from "node:path";
import { taskBlocks, taskFileMap, TEST_FILE_SUFFIXES, normalizeFileToken } from "./task-files.mjs";
import { isMain } from "./is-main.mjs";

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

// The resolution planning-waves.md documents: a planner acknowledges a referencer (test or
// non-test) that does not need updating, with a reason, and the gate clears rather than being
// walked around in prose.
//   - Blast-radius override: <changed-file> [→ <referencer>] — <reason>
// File-only clears every referencer of that file; "→ <referencer>" clears just that pair. A
// missing reason is an error — an unexplained override is exactly the silent walk-around this
// gate prevents.
const OVERRIDE_START = /^\s*-\s*Blast-radius override:/;
const OVERRIDE_RE = /^\s*-\s*Blast-radius override:\s*(\S+?)(?:\s*→\s*(\S+))?\s*—\s*(.*\S)\s*$/;

const failed = (finding) => ({ findings: [finding], ok: "", notes: [] });

export function blastRadiusLeg(planText, { planPath, repoRoot }) {
  const blocks = taskBlocks(planText);
  // A plan that yields no tasks is a parse failure, not a plan with no blast radius: without this
  // the walk below has nothing to match and reports ok against an empty list.
  if (blocks.length === 0) return failed(`no "### Task N" blocks found in ${planPath}`);
  const filesByTask = taskFileMap(planText);
  const declared = new Set([...filesByTask.values()].flatMap((files) => [...files]));
  // The walk below reasons over `declared`, not over the blocks: a plan whose tasks name no files
  // at all matches nothing and would report ok against an empty list just as a heading-less one would.
  if (declared.size === 0) {
    // The same split, from the same map, as wave-disjointness-check's -- and deliberately the same
    // sentence. Both gates read one taskFileMap, so a plan whose blocks say "none" that made one
    // gate report the blocks missing and the other report them empty sent the author to two repairs
    // for one plan.
    return failed(
      filesByTask.size === 0
        ? `no "**Files:**" blocks found in ${planPath}`
        : `no task in ${planPath} declares a file -- its "**Files:**" blocks are present but empty`
    );
  }
  const changed = [...declared].filter((f) => !isTestFile(f));

  const codeFiles = walk(repoRoot)
    .map((p) => relative(repoRoot, p).split(sep).join("/"))
    .filter((p) => CODE_EXT.has(extname(p)));

  const overrides = [];
  for (const { text: blockText } of blocks) {
    for (const line of blockText.split("\n")) {
      if (!OVERRIDE_START.test(line)) continue;
      const m = line.match(OVERRIDE_RE);
      // Normalize both captures through the same normalizeFileToken the declaration side ran
      // every "**Files:**" token through, so an override written with backticks or trailing
      // punctuation -- exactly how planners write paths elsewhere -- still matches `chg` below.
      const file = m ? normalizeFileToken(m[1]) : null;
      const test = m && m[2] !== undefined ? normalizeFileToken(m[2]) : null;
      // A present "→ <referencer>" whose token does not normalize to a path is malformed just as a
      // bad changed-file token is; otherwise it would silently widen the override from the single
      // pair to every referencer of the changed file.
      if (!m || file === null || (m[2] !== undefined && test === null)) {
        return failed(`malformed override (needs "<changed-file> [→ <referencer>] — <reason>"): ${line.trim()}`);
      }
      overrides.push({ file, test, reason: m[3] });
    }
  }

  const findings = [];
  const notes = [];
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
      const ov = overrides.find((o) => o.file === chg && (o.test === null || o.test === cand));
      if (ov) {
        notes.push(`override -- ${cand} references ${chg}, cleared: ${ov.reason}`);
      } else {
        const kind = isTestFile(cand) ? "test" : "non-test";
        findings.push(`${cand} (${kind}) references ${chg} but is in no task's Files block -- add it or record an override`);
      }
    }
  }

  return {
    findings,
    ok: "ok -- every referencer of a changed file is in a Files block or overridden",
    notes,
  };
}

function main() {
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

  const { findings, ok, notes } = blastRadiusLeg(readFileSync(planPath, "utf8"), { planPath, repoRoot });
  for (const n of notes) console.error(`blast-radius-check: ${n}`);
  if (findings.length > 0) {
    for (const f of findings) console.error(`blast-radius-check: ${f}`);
    process.exit(1);
  }
  console.log(`blast-radius-check: ${ok}`);
  process.exit(0);
}

if (isMain(import.meta.url, process.argv[1])) main();
