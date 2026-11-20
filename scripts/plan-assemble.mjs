#!/usr/bin/env node
// Assembles a plan from its per-task work files (references/delegated-planning.md § The merge): the
// coordinator's plan-header.md, each tasks/task-<n>.md and dispatch-map.md. A task file is the
// canonical copy while planning; the plan it assembles keeps the shape executing-waves reads.
// assemblePlan() is pure and names every id defect at once; the CLI reads the work directory, writes
// the plan atomically, and `edges` lists the producer->consumer pairs a repair pass checks.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { parseDispatchMap, planEdges, taskBlocks } from "./task-files.mjs";

const USAGE = "usage: plan-assemble.mjs <work-dir> --out <plan-path> | edges <work-dir> [--batch <n>]";
const TASK_FILE_RE = /^task-(\d+)\.md$/;

const fileNumber = (name) => Number(name.match(TASK_FILE_RE)[1]);
const byFileNumber = (a, b) => fileNumber(a.name) - fileNumber(b.name);

// A CLI argument naming a positive integer in digits only, so `0x10`, `1e1` and `01` are refused.
export const isPositiveIntegerArg = (value) => /^[1-9]\d*$/.test(value);

export function assemblePlan({ header, tasks, dispatchMap }) {
  const errors = [];
  const held = new Map(); // task number -> task file names holding that heading
  for (const { name, text } of [...tasks].sort(byFileNumber)) {
    const blocks = taskBlocks(text);
    if (blocks.length === 0) {
      errors.push(`${name} holds no "### Task N:" heading`);
      continue;
    }
    if (blocks.length > 1) {
      errors.push(`${name} holds ${blocks.length} task headings, expected one`);
      continue;
    }
    const [{ num }] = blocks;
    if (num !== fileNumber(name)) errors.push(`${name} holds Task ${num}, expected Task ${fileNumber(name)}`);
    held.set(num, [...(held.get(num) ?? []), name]);
  }
  for (const [num, names] of [...held].sort((a, b) => a[0] - b[0]))
    if (names.length > 1) errors.push(`Task ${num} is in both ${names[0]} and ${names[1]}`);

  const waves = parseDispatchMap(dispatchMap);
  if (waves === null) errors.push('dispatch-map.md has no "## Dispatch Map" heading');
  else {
    const mapped = new Set([...waves.values()].flat());
    for (const num of [...mapped].sort((a, b) => a - b))
      if (!held.has(num)) errors.push(`Task ${num} is in the Dispatch Map but has no task file`);
    for (const num of [...held.keys()].sort((a, b) => a - b))
      if (!mapped.has(num)) errors.push(`Task ${num} has a task file but no Dispatch Map wave`);
  }
  if (errors.length) return { plan: null, errors };

  const texts = [...tasks]
    .map(({ text }) => ({ num: taskBlocks(text)[0].num, text: text.trimEnd() }))
    .sort((a, b) => a.num - b.num)
    .map(({ text }) => text);
  return { plan: `${[header.trimEnd(), ...texts, dispatchMap.trimEnd()].join("\n\n")}\n`, errors };
}

// The edges in order, in runs of at most `perBatch`, each run naming the task numbers it touches.
export function batchEdges(edges, perBatch) {
  if (!Number.isInteger(perBatch) || perBatch < 1) throw new Error("the batch size must be a positive integer");
  const batches = [];
  for (let i = 0; i < edges.length; i += perBatch) {
    const run = edges.slice(i, i + perBatch);
    const tasks = [...new Set(run.flatMap(({ producer, consumer }) => [producer, consumer]))].sort((a, b) => a - b);
    batches.push({ edges: run, tasks });
  }
  return batches;
}

function fail(message, code = 1) {
  console.error(`plan-assemble: ${message}`);
  process.exit(code);
}

function usage(message) {
  if (message) console.error(`plan-assemble: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function readWorkFile(path) {
  if (!existsSync(path)) fail(`missing ${path}`);
  return readFileSync(path, "utf8");
}

export function readTasks(workDir) {
  const dir = join(workDir, "tasks");
  if (!existsSync(dir)) fail(`missing ${dir}`);
  return readdirSync(dir)
    .filter((name) => TASK_FILE_RE.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }))
    .sort(byFileNumber);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, { "--out": "value", "--batch": "value" }, { allowPositionals: true, requireValues: "nonEmpty" });
  } catch (e) {
    usage(e.message);
  }
  const { flags, positionals } = parsed;
  if (flags["--batch"] !== undefined && !isPositiveIntegerArg(flags["--batch"])) usage("--batch takes a positive integer");
  const perBatch = flags["--batch"] === undefined ? undefined : Number(flags["--batch"]);
  if (positionals[0] === "edges") {
    if (positionals.length !== 2 || flags["--out"] !== undefined) usage();
    const tasks = readTasks(positionals[1]);
    const edges = planEdges(tasks.map(({ text }) => text.trimEnd()).join("\n\n"));
    if (perBatch !== undefined && edges.length) {
      const lines = batchEdges(edges, perBatch).flatMap((batch, i) => [
        `batch ${i + 1} · ${batch.edges.length} edge${batch.edges.length === 1 ? "" : "s"} · ${batch.tasks.map((n) => `tasks/task-${n}.md`).join(" ")}`,
        ...batch.edges.map(({ producer, consumer }) => `Task ${producer} → Task ${consumer}`),
      ]);
      console.log(lines.join("\n"));
      return;
    }
    console.log(edges.length
      ? edges.map(({ producer, consumer }) => `Task ${producer} → Task ${consumer} · tasks/task-${producer}.md · tasks/task-${consumer}.md`).join("\n")
      : "plan-assemble: no edges");
    return;
  }
  if (positionals.length !== 1 || !flags["--out"] || perBatch !== undefined) usage(perBatch !== undefined ? "--batch belongs to edges" : undefined);
  const workDir = positionals[0];
  const header = readWorkFile(join(workDir, "plan-header.md"));
  const dispatchMap = readWorkFile(join(workDir, "dispatch-map.md"));
  const tasks = readTasks(workDir);
  const { plan, errors } = assemblePlan({ header, tasks, dispatchMap });
  if (errors.length) {
    for (const error of errors) console.error(`plan-assemble: ${error}`);
    process.exit(1);
  }
  atomicWrite(flags["--out"], plan);
  console.log(`plan-assemble: wrote ${flags["--out"]} — ${tasks.length} task(s), ${parseDispatchMap(dispatchMap).size} wave(s)`);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
