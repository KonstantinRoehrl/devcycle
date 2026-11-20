#!/usr/bin/env node
// Derives where a planning stage stands from disk alone -- the stage-log rows of the state file's run
// and the work files under .devcycle/plan-work/<run id>/, never a transcript -- so a session cleared
// mid-planning can resume. planPosition() is pure; the CLI reads the disk and prints the position.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { readStage } from "./stage-log.mjs";
import { field } from "./md-field.mjs";
import { UsageError } from "./task-ledger.mjs";
import { readTasks } from "./plan-assemble.mjs";
import { taskBlocks } from "./task-files.mjs";
import { parseCut } from "./plan-strategy.mjs";

const USAGE = "usage: plan-resume.mjs --state <path>";
const GROUP_KEY = /^plan-group-(\d+)$/;
const DRAFT_KEY = /^plan-draft-(\d+)$/;
const SECTION_PREFIX = "plan-section-";

const ascending = (a, b) => a - b;
const numbersOf = (rows, pattern) => [...new Set(rows.map(({ key }) => key.match(pattern)).filter(Boolean).map((m) => Number(m[1])))].sort(ascending);

export function planPosition({ rows, taskFiles, cut, pack, refExists = () => true }) {
  const groupsDone = numbersOf(rows, GROUP_KEY);
  const filed = new Set(taskFiles);
  const drafted = numbersOf(rows, DRAFT_KEY).filter((num) => filed.has(num));
  const done = new Set(drafted);
  const missing = cut === null ? [] : cut.map(({ num }) => num).filter((num) => !done.has(num)).sort(ascending);
  let nextGroup = null;
  if (missing.length > 0) {
    nextGroup = 1;
    while (groupsDone.includes(nextGroup)) nextGroup++;
  }
  const sections = rows
    .filter(({ key, ref }) => key.startsWith(SECTION_PREFIX) && (ref === undefined || refExists(ref)))
    .map(({ key }) => key.slice(SECTION_PREFIX.length))
    .sort();
  const strategy = rows.find(({ key }) => key === "drafting-plan")?.data?.strategy ?? null;
  return { strategy, groupsDone, nextGroup, drafted, missing, sections, pack };
}

function fail(message, code = 1) {
  console.error(`plan-resume: ${message}`);
  process.exit(code);
}

function usage(message) {
  if (message) console.error(`plan-resume: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function main(argv) {
  let statePath;
  try {
    const { flags } = parseFlags(argv, { "--state": "value" }, { requireValues: "nonEmpty" });
    statePath = requireValue(flags, "--state");
  } catch (e) {
    usage(e.message);
  }
  if (statePath === undefined) usage("--state is required");
  if (!existsSync(statePath)) fail(`no state file at ${statePath}`);
  const devcycleDir = dirname(resolve(statePath));
  const root = dirname(devcycleDir);
  const run = field(readFileSync(statePath, "utf8"), "run");
  let rows;
  try {
    rows = readStage(devcycleDir, { run, stage: "planning" });
  } catch (e) {
    if (e instanceof UsageError) fail(`${statePath} names no run, so there is no planning position to resume`);
    throw e;
  }
  const workDir = join(devcycleDir, "plan-work", run);

  const named = rows.find(({ key }) => key === "drafting-plan")?.data?.cut;
  const cutPath = named === undefined ? join(workDir, "task-cut.json") : resolve(root, named);
  let cut = null;
  if (existsSync(cutPath)) {
    const parsed = parseCut(readFileSync(cutPath, "utf8"));
    if (parsed.errors.length) {
      for (const error of parsed.errors) console.error(`plan-resume: ${cutPath}: ${error}`);
      process.exit(1);
    }
    cut = parsed.cut;
  } else if (named !== undefined) fail(`no task cut at ${cutPath}`);

  const taskFiles = existsSync(join(workDir, "tasks")) ? readTasks(workDir).flatMap(({ text }) => taskBlocks(text).map(({ num }) => num)) : [];
  const position = planPosition({
    rows,
    taskFiles,
    cut,
    pack: existsSync(join(workDir, "pack.md")),
    refExists: (ref) => existsSync(resolve(root, ref)),
  });
  console.log(JSON.stringify(position, null, 2));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
