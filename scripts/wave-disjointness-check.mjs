#!/usr/bin/env node
// Pre-flight check for a devcycle plan's "## Dispatch Map": two tasks placed in the same
// wave must never both declare the same file in their **Files:** block, since concurrent
// implementers share one checkout and a same-wave overlap is a silent collision waiting to
// happen. This only catches a literal file-path overlap inside a task's own Files list --
// it cannot see two tasks coupled only by editing the same shared resource's prose or
// assertions without naming the same file.
import { readFileSync, existsSync } from "node:fs";
import { taskBlocks, taskFileMap, parseDispatchMap } from "./task-files.mjs";

const planPath = process.argv[2];
if (!planPath) {
  console.error("usage: node scripts/wave-disjointness-check.mjs <plan-file>");
  process.exit(1);
}
if (!existsSync(planPath)) {
  console.error(`wave-disjointness-check: plan file not found: ${planPath}`);
  process.exit(1);
}

const text = readFileSync(planPath, "utf8");

const filesByTask = taskFileMap(text);
const waves = parseDispatchMap(text);

// A plan that yields no tasks is a parse failure, not a clean plan: without these the loop below
// finds no violations and prints ok against an empty list. The two conditions are separate so the
// message names the one that actually fired -- a heading-less document and a document whose tasks
// declare no files send the plan author to different places.
if (taskBlocks(text).length === 0) {
  console.error(`wave-disjointness-check: no "### Task N" blocks found in ${planPath}`);
  process.exit(1);
}
if (filesByTask.size === 0) {
  console.error(`wave-disjointness-check: no "**Files:**" blocks found in ${planPath}`);
  process.exit(1);
}

if (waves === null) {
  console.log(
    `wave-disjointness-check: no "## Dispatch Map" section found in ${planPath} -- cannot verify wave disjointness`
  );
  process.exit(0);
}

const violations = [];
for (const [waveNum, taskNums] of waves) {
  const owners = new Map(); // file -> [taskNums that declare it]
  for (const taskNum of taskNums) {
    const files = filesByTask.get(taskNum);
    if (!files) continue;
    for (const file of files) {
      if (!owners.has(file)) owners.set(file, []);
      owners.get(file).push(taskNum);
    }
  }
  for (const [file, tasks] of owners) {
    if (tasks.length > 1) violations.push({ wave: waveNum, file, tasks });
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    const taskNames = v.tasks.map((t) => `Task ${t}`).join(" and ");
    console.error(`wave-disjointness-check: Wave ${v.wave} -- ${taskNames} both list ${v.file}`);
  }
  process.exit(1);
}

console.log("wave-disjointness-check: ok -- no same-wave file overlaps found");
process.exit(0);
