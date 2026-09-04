#!/usr/bin/env node
// Pre-flight check for a devcycle plan: a task whose Files touch a budgeted surface
// (playbooks/, commands/, agents/, references/ markdown) must also touch the matching budget
// fixture(s), or record an override -- the transitively-required-fixture gap (#230).
// See playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { taskBlocks, taskFileMap, normalizeFileToken } from "./task-files.mjs";

const [, , planPath] = process.argv;
if (!planPath) {
  console.error("usage: node scripts/budget-fixture-check.mjs <plan-file>");
  process.exit(1);
}
if (!existsSync(planPath)) {
  console.error(`budget-fixture-check: plan file not found: ${planPath}`);
  process.exit(1);
}

// Surface dirs mirror scripts/validate.mjs check 9 (SURFACE = playbooks, commands, agents,
// references); context-budget.json (check 15) keys only playbooks. Keep this list in sync
// with validate.mjs.
const SURFACE_DIRS = ["playbooks/", "commands/", "agents/", "references/"];
const SURFACE_BUDGET = "tests/fixtures/surface-budget.json";
const CONTEXT_BUDGET = "tests/fixtures/context-budget.json";
const isSurface = (f) => SURFACE_DIRS.some((d) => f.startsWith(d)) && f.endsWith(".md");
const isPlaybook = (f) => f.startsWith("playbooks/") && f.endsWith(".md");

const text = readFileSync(planPath, "utf8");
const blocks = taskBlocks(text);
// A plan that yields no tasks is a parse failure, not a plan with no budgeted surfaces --
// matching blast-radius-check.mjs's own guard.
if (blocks.length === 0) {
  console.error(`budget-fixture-check: no "### Task N" blocks found in ${planPath}`);
  process.exit(1);
}
const filesByTask = taskFileMap(text);

// The resolution: a planner acknowledges a surface edit that legitimately needs no fixture
// bump, with a reason, keyed on either the surface path or the fixture name it would satisfy:
//   - Budget-fixture override: <surface-or-fixture> — <reason>
// A missing reason is an error -- the same em-dash grammar and reasonless-is-error rule as
// scripts/blast-radius-check.mjs's OVERRIDE_RE.
const OVERRIDE_START = /^\s*-\s*Budget-fixture override:/;
const OVERRIDE_RE = /^\s*-\s*Budget-fixture override:\s*(\S+)\s*—\s*(.*\S)\s*$/;

const violations = [];
for (const { num, text: blockText } of blocks) {
  const files = filesByTask.get(num) ?? new Set();

  const overridden = new Set();
  for (const line of blockText.split("\n")) {
    if (!OVERRIDE_START.test(line)) continue;
    const m = line.match(OVERRIDE_RE);
    if (!m) {
      console.error(
        `budget-fixture-check: malformed override (needs "<surface-or-fixture> — <reason>"): ${line.trim()}`
      );
      process.exit(1);
    }
    overridden.add(normalizeFileToken(m[1]) ?? m[1]);
  }
  const clears = (surface, fixture) => overridden.has(surface) || overridden.has(fixture);

  for (const f of files) {
    if (isSurface(f) && !files.has(SURFACE_BUDGET) && !clears(f, SURFACE_BUDGET)) {
      violations.push(
        `budget-fixture-check: Task ${num} edits ${f} but its Files omit ${SURFACE_BUDGET} — ` +
          `add it (growth needs a baseline bump) or record a "- Budget-fixture override: ${f} — <reason>"`
      );
    }
    if (isPlaybook(f) && !files.has(CONTEXT_BUDGET) && !clears(f, CONTEXT_BUDGET)) {
      violations.push(
        `budget-fixture-check: Task ${num} edits ${f} but its Files omit ${CONTEXT_BUDGET} — ` +
          `add it (growth needs a baseline bump) or record a "- Budget-fixture override: ${f} — <reason>"`
      );
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) console.error(v);
  process.exit(1);
}
console.log("budget-fixture-check: ok -- every budgeted surface edit carries its matching fixture or an override");
process.exit(0);
