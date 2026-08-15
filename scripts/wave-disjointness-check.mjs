#!/usr/bin/env node
// Pre-flight check for a devcycle plan's "## Dispatch Map": two tasks placed in the same
// wave must never both declare the same file in their **Files:** block, since concurrent
// implementers share one checkout and a same-wave overlap is a silent collision waiting to
// happen. This only catches a literal file-path overlap inside a task's own Files list --
// it cannot see two tasks coupled only by editing the same shared resource's prose or
// assertions without naming the same file.
import { readFileSync, existsSync } from "node:fs";

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

const TASK_HEADING_RE = /^### Task (\d+):.*$/gm;
const FILES_BLOCK_RE = /\*\*Files:\*\*\n([\s\S]*?)(?=\n\*\*|\n###|$)/;
const LABELS = new Set(["Create", "Modify", "Test"]);

// Pulls file-path-shaped tokens out of a task's **Files:** block: strips a trailing
// `:123-145`-style line-range suffix, strips surrounding backticks/parens/commas, skips
// the literal Create/Modify/Test labels, and keeps only tokens that still look like a
// path afterward (a slash, or a dot-extension at the end) -- which is what filters out
// the surrounding prose (parenthetical notes, bullet dashes) that also lives in that block.
function extractFiles(block) {
  const files = new Set();
  const tokens = block.split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    let tok = raw.replace(/^[`(),]+/, "").replace(/[`(),]+$/, "");
    tok = tok.replace(/:\d+-\d+$/, "");
    tok = tok.replace(/:$/, "");
    if (!tok || LABELS.has(tok) || tok === "-") continue;
    if (!/\//.test(tok) && !/\.[A-Za-z0-9]+$/.test(tok)) continue;
    files.add(tok);
  }
  return files;
}

// Maps task number -> Set of files that task's **Files:** block declares.
function parseTaskFiles(planText) {
  const headings = [...planText.matchAll(TASK_HEADING_RE)];
  const map = new Map();
  for (let i = 0; i < headings.length; i++) {
    const taskNum = Number(headings[i][1]);
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : planText.length;
    const block = planText.slice(start, end);
    const filesMatch = block.match(FILES_BLOCK_RE);
    if (!filesMatch) continue;
    map.set(taskNum, extractFiles(filesMatch[1]));
  }
  return map;
}

// Maps wave number -> array of task numbers, parsed from "- Wave N: Task X, Task Y (...)"
// lines. Only the text before the first "(" is scanned for "Task N" mentions, so a
// parenthetical note like "(needs Tasks 1+2 committed)" never gets misread as membership.
// Returns null when no "## Dispatch Map" heading exists at all.
function parseDispatchMap(planText) {
  const idx = planText.indexOf("## Dispatch Map");
  if (idx === -1) return null;
  const section = planText.slice(idx);
  const waves = new Map();
  for (const m of section.matchAll(/^- Wave (\d+):\s*(.+)$/gm)) {
    const waveNum = Number(m[1]);
    const rest = m[2];
    const parenIdx = rest.indexOf("(");
    const taskListText = parenIdx === -1 ? rest : rest.slice(0, parenIdx);
    const taskNums = [...taskListText.matchAll(/Task (\d+)/g)].map((t) => Number(t[1]));
    waves.set(waveNum, taskNums);
  }
  return waves;
}

const filesByTask = parseTaskFiles(text);
const waves = parseDispatchMap(text);

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
