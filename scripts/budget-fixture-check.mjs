#!/usr/bin/env node
// Pre-flight check for a devcycle plan: a task whose Files touch a budgeted surface
// (playbooks/, commands/, agents/, references/ markdown) must also touch the matching budget
// fixture(s), or record an override -- the transitively-required-fixture gap (#230).
// The join is exported as `budgetFixtureGaps` because brief-completeness-check.mjs runs it as a
// leg: a brief that mandates doc growth without listing the baseline that growth trips should
// fail on the first scripted gate a planner runs, not later inside validate.mjs.
// See playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { taskBlocks, taskFileMap, normalizeFileToken } from "./task-files.mjs";

// Surface dirs mirror scripts/validate.mjs check 9 (SURFACE = playbooks, commands, agents,
// references). Keep this list in sync with validate.mjs.
const SURFACE_DIRS = ["playbooks/", "commands/", "agents/", "references/"];
const SURFACE_BUDGET = "tests/fixtures/surface-budget.json";
const CONTEXT_BUDGET = "tests/fixtures/context-budget.json";
const isSurface = (f) => SURFACE_DIRS.some((d) => f.startsWith(d)) && f.endsWith(".md");
const isPlaybook = (f) => f.startsWith("playbooks/") && f.endsWith(".md");
// context-budget.json keys only playbooks, but validate.mjs check 15 charges each playbook for
// the bytes of every reference it cites -- so editing a reference grows a budget no playbook in
// the Files block appears to touch. That is the shape the recurring failure took.
const isReference = (f) => f.startsWith("references/") && f.endsWith(".md");

// The join, in one place: which committed size baselines a tracked path sits under.
function requiredFixtures(file) {
  const fixtures = [];
  if (isSurface(file)) fixtures.push(SURFACE_BUDGET);
  if (isPlaybook(file) || isReference(file)) fixtures.push(CONTEXT_BUDGET);
  return fixtures;
}

// The resolution: a planner acknowledges a surface edit that legitimately needs no fixture
// bump, with a reason, keyed on either the surface path or the fixture name it would satisfy:
//   - Budget-fixture override: <surface-or-fixture> — <reason>
// A missing reason is an error -- the same em-dash grammar and reasonless-is-error rule as
// scripts/blast-radius-check.mjs's OVERRIDE_RE.
const OVERRIDE_START = /^\s*-\s*Budget-fixture override:/;
const OVERRIDE_RE = /^\s*-\s*Budget-fixture override:\s*(\S+)\s*—\s*(.*\S)\s*$/;

// Every (task, file, fixture) triple a plan's Files blocks leave unlisted and unoverridden.
// Throws on a malformed override line so both callers report it the same way; a plan with no
// task blocks is each caller's own parse-failure guard, not this function's.
export function budgetFixtureGaps(planText) {
  const filesByTask = taskFileMap(planText);
  const gaps = [];
  for (const { num, text: blockText } of taskBlocks(planText)) {
    const files = filesByTask.get(num) ?? new Set();

    const overridden = new Set();
    for (const line of blockText.split("\n")) {
      if (!OVERRIDE_START.test(line)) continue;
      const m = line.match(OVERRIDE_RE);
      if (!m) throw new Error(`malformed override (needs "<surface-or-fixture> — <reason>"): ${line.trim()}`);
      overridden.add(normalizeFileToken(m[1]) ?? m[1]);
    }

    for (const file of files) {
      for (const fixture of requiredFixtures(file)) {
        if (files.has(fixture) || overridden.has(file) || overridden.has(fixture)) continue;
        gaps.push({ task: num, file, fixture });
      }
    }
  }
  return gaps;
}

function main() {
  const [, , planPath] = process.argv;
  if (!planPath) {
    console.error("usage: node scripts/budget-fixture-check.mjs <plan-file>");
    process.exit(1);
  }
  if (!existsSync(planPath)) {
    console.error(`budget-fixture-check: plan file not found: ${planPath}`);
    process.exit(1);
  }

  const text = readFileSync(planPath, "utf8");
  // A plan that yields no tasks is a parse failure, not a plan with no budgeted surfaces --
  // matching blast-radius-check.mjs's own guard.
  if (taskBlocks(text).length === 0) {
    console.error(`budget-fixture-check: no "### Task N" blocks found in ${planPath}`);
    process.exit(1);
  }

  let gaps;
  try {
    gaps = budgetFixtureGaps(text);
  } catch (e) {
    console.error(`budget-fixture-check: ${e.message}`);
    process.exit(1);
  }

  if (gaps.length > 0) {
    for (const { task, file, fixture } of gaps) {
      console.error(
        `budget-fixture-check: Task ${task} edits ${file} but its Files omit ${fixture} — ` +
          `add it (growth needs a baseline bump) or record a "- Budget-fixture override: ${file} — <reason>"`
      );
    }
    process.exit(1);
  }
  console.log("budget-fixture-check: ok -- every budgeted surface edit carries its matching fixture or an override");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
