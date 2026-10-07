#!/usr/bin/env node
// Pre-flight check for a devcycle plan's "## Dispatch Map": two tasks placed in the same
// wave must never both declare the same file in their **Files:** block, since concurrent
// implementers share one checkout and a same-wave overlap is a silent collision waiting to
// happen. This only catches a literal file-path overlap inside a task's own Files list --
// it cannot see two tasks coupled only by editing the same shared resource's prose or
// assertions without naming the same file.
import { readFileSync, existsSync } from "node:fs";
import { taskBlocks, taskFileMap, parseDispatchMap } from "./task-files.mjs";
import { isMain } from "./is-main.mjs";

const failed = (finding) => ({ findings: [finding], ok: "", notes: [] });

export function waveDisjointnessLeg(planText, { planPath }) {
  const filesByTask = taskFileMap(planText);
  const waves = parseDispatchMap(planText);

  // A plan that yields no tasks is a parse failure, not a clean plan: without these the loop below
  // finds no violations and reports ok against an empty list. The two conditions are separate so
  // the message names the one that actually fired -- a heading-less document and a document whose
  // tasks declare no files send the plan author to different places.
  if (taskBlocks(planText).length === 0) return failed(`no "### Task N" blocks found in ${planPath}`);
  // Counted in files, not in tasks carrying the field: a task declaring "**Files:** none" puts an
  // empty set in the map, so a task count called that plan clean while blast-radius-check -- which
  // counts the same normalized tokens this line now counts -- hard-failed on it.
  const declaredFileCount = [...filesByTask.values()].reduce((n, files) => n + files.size, 0);
  if (declaredFileCount === 0) {
    // A plan whose blocks say "**Files:** none" is a different repair from one with no blocks at
    // all, and telling that author the blocks are missing sends them looking for a field they wrote.
    return failed(
      filesByTask.size === 0
        ? `no "**Files:**" blocks found in ${planPath}`
        : `no task in ${planPath} declares a file -- its "**Files:**" blocks are present but empty`
    );
  }

  if (waves === null) {
    return {
      findings: [],
      ok: `no "## Dispatch Map" section found in ${planPath} -- cannot verify wave disjointness`,
      notes: [],
    };
  }

  const findings = [];
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
      if (tasks.length > 1) {
        const taskNames = tasks.map((t) => `Task ${t}`).join(" and ");
        findings.push(`Wave ${waveNum} -- ${taskNames} both list ${file}`);
      }
    }
  }

  return { findings, ok: "ok -- no same-wave file overlaps found", notes: [] };
}

function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error("usage: node scripts/wave-disjointness-check.mjs <plan-file>");
    process.exit(1);
  }
  if (!existsSync(planPath)) {
    console.error(`wave-disjointness-check: plan file not found: ${planPath}`);
    process.exit(1);
  }

  const { findings, ok } = waveDisjointnessLeg(readFileSync(planPath, "utf8"), { planPath });
  if (findings.length > 0) {
    for (const f of findings) console.error(`wave-disjointness-check: ${f}`);
    process.exit(1);
  }
  console.log(`wave-disjointness-check: ${ok}`);
  process.exit(0);
}

if (isMain(import.meta.url, process.argv[1])) main();
