#!/usr/bin/env node
// Pre-flight check for a devcycle plan: every "### Task N" block must carry the required
// dispatch fields, the Evidence value must name a valid class, and "## Dispatch Map" must list
// every task. Modeled on wave-disjointness-check.mjs; a brief missing a field makes the
// implementer guess. See references/evidence.md and playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { taskBlocks, parseDispatchMap, filesFieldValue } from "./task-files.mjs";

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
const REQUIRED_FIELDS = ["Files", "Interfaces", "Dependencies", "Evidence", "Quality constraints"];
const VALID_EVIDENCE_CLASSES = ["red-green", "green-green", "convention"];

function fieldValue(block, field) {
  const re = new RegExp(`\\*\\*${field}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n###|$)`);
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// **Files:** is read by task-files.mjs, which owns that grammar for every plan gate. Deciding it
// here too is how this gate came to accept declarations wave-disjointness then called missing.
function readField(block, field) {
  return field === "Files" ? filesFieldValue(block) : fieldValue(block, field);
}

const errors = [];
const blocks = taskBlocks(text);
if (blocks.length === 0) {
  console.error(`brief-completeness-check: no "### Task N" blocks found in ${planPath}`);
  process.exit(1);
}

for (const { num, text: block } of blocks) {
  for (const field of REQUIRED_FIELDS) {
    const val = readField(block, field);
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

const waves = parseDispatchMap(text);
if (waves === null) {
  errors.push('missing "## Dispatch Map" section');
} else {
  const mapped = new Set([...waves.values()].flat());
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
