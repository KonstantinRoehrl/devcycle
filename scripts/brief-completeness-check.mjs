#!/usr/bin/env node
// Pre-flight check for a devcycle plan: every "### Task N" block must carry the required
// dispatch fields, the Evidence value must name a valid class, and "## Dispatch Map" must list
// every task. Modeled on wave-disjointness-check.mjs; a brief missing a field makes the
// implementer guess. See references/evidence.md and playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";

const planPath = process.argv[2];
if (!planPath) {
  console.error("usage: node scripts/brief-completeness-check.mjs <plan-file>");
  process.exit(1);
}
if (!existsSync(planPath)) {
  console.error(`brief-completeness-check: plan file not found: ${planPath}`);
  process.exit(1);
}

const text = readFileSync(planPath, "utf8");
const TASK_HEADING_RE = /^### Task (\d+):.*$/gm;
const REQUIRED_FIELDS = ["Files", "Interfaces", "Dependencies", "Evidence", "Quality constraints"];
const VALID_EVIDENCE_CLASSES = ["red-green", "green-green", "convention"];

function taskBlocks(planText) {
  const headings = [...planText.matchAll(TASK_HEADING_RE)];
  const blocks = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : planText.length;
    blocks.push({ num: Number(headings[i][1]), text: planText.slice(start, end) });
  }
  return blocks;
}

function fieldValue(block, field) {
  const re = new RegExp(`\\*\\*${field}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n###|$)`);
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

const errors = [];
const blocks = taskBlocks(text);
if (blocks.length === 0) {
  console.error(`brief-completeness-check: no "### Task N" blocks found in ${planPath}`);
  process.exit(1);
}

for (const { num, text: block } of blocks) {
  for (const field of REQUIRED_FIELDS) {
    const val = fieldValue(block, field);
    if (val === null) errors.push(`Task ${num}: missing **${field}:** field`);
    else if (val === "") errors.push(`Task ${num}: **${field}:** field is empty`);
  }
  const evidence = fieldValue(block, "Evidence");
  if (evidence) {
    const evidenceClass = evidence.split(/\s+/)[0];
    if (!VALID_EVIDENCE_CLASSES.includes(evidenceClass)) {
      errors.push(`Task ${num}: **Evidence:** does not name a valid class (${VALID_EVIDENCE_CLASSES.join(" | ")})`);
    }
  }
}

// Only a task named in a wave's own task list counts as "assigned" -- a mention inside another
// wave's dependency parenthetical, e.g. "- Wave 2: Task 3 (needs Task 1 and Task 2)", is a
// reference to a dependency, not an assignment to that wave. Mirrors wave-disjointness-check's
// parseDispatchMap: only the substring before the first "(" on each "- Wave N:" line is scanned.
const mapIdx = text.indexOf("## Dispatch Map");
if (mapIdx === -1) {
  errors.push('missing "## Dispatch Map" section');
} else {
  const mapSection = text.slice(mapIdx);
  const mapped = new Set();
  for (const m of mapSection.matchAll(/^- Wave (\d+):\s*(.+)$/gm)) {
    const rest = m[2];
    const parenIdx = rest.indexOf("(");
    const taskListText = parenIdx === -1 ? rest : rest.slice(0, parenIdx);
    for (const t of taskListText.matchAll(/Task (\d+)/g)) mapped.add(Number(t[1]));
  }
  for (const { num } of blocks) {
    if (!mapped.has(num)) errors.push(`Task ${num}: not listed in the ## Dispatch Map`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`brief-completeness-check: ${e}`);
  process.exit(1);
}
console.log(`brief-completeness-check: ok -- ${blocks.length} task(s), all required fields present`);
process.exit(0);
