#!/usr/bin/env node
// The interface lock of the planning-groups design (spec §9.4): once a round of task drafts is
// accepted, each task's `Produces` items are frozen in <work-dir>/interfaces.lock.md, so a later
// drafter that consumes a locked task reproduces its signatures verbatim and cannot drift from the
// plan the earlier round was checked against. A drafter that must change a pinned interface returns
// an interface-delta instead of editing the lock; only the coordinator accepts it, by relocking with
// `write --relock`. `check` re-reads the task files against the lock. A consumer whose producers are
// all unlocked is left to the plan gate's crossTask leg (cross-task-check.mjs).
// extractLock/renderLock/parseLock/mergeLock/checkLock are pure; the CLI reads the work directory
// through plan-assemble.mjs's readTasks and task-files.mjs's taskBlocks and writes atomically.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { interfaceLines, taskBlocks } from "./task-files.mjs";
import { codeSpans } from "./cross-task-check.mjs";
import { isPositiveIntegerArg, readTasks } from "./plan-assemble.mjs";

const USAGE = "usage: interface-lock.mjs write <work-dir> --round <n> [--tasks 1,2] [--relock] | check <work-dir>";
const LOCK_FILE = "interfaces.lock.md";
const ENTRY_HEADING_RE = /^## Task (\d+) \(round (\d+)\)$/;
const NO_PRODUCES = "(no Produces)";

const byNum = (a, b) => a.num - b.num;
const sameItems = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

export function extractLock(blocks, round, nums) {
  return blocks
    .filter(({ num }) => nums === undefined || nums.includes(num))
    .map(({ num, text }) => ({ num, round, produces: interfaceLines(text).produces }))
    .sort(byNum);
}

export function renderLock(entries) {
  const sections = entries.map(({ num, round, produces }) =>
    [`## Task ${num} (round ${round})`, ...(produces.length ? produces.map((item) => `- ${item}`) : [NO_PRODUCES])].join("\n"));
  return `${["# Interface lock", ...sections].join("\n\n")}\n`;
}

export function parseLock(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const heading = line.match(ENTRY_HEADING_RE);
    if (heading) entries.push({ num: Number(heading[1]), round: Number(heading[2]), produces: [] });
    else if (entries.length && line.startsWith("- ")) entries[entries.length - 1].produces.push(line.slice(2));
  }
  return entries;
}

export function mergeLock(existing, fresh, { relock = false } = {}) {
  const held = new Map(existing.map((entry) => [entry.num, entry]));
  const errors = [];
  for (const entry of fresh) {
    const locked = held.get(entry.num);
    if (!locked || relock) held.set(entry.num, entry);
    else if (!sameItems(locked.produces, entry.produces))
      errors.push(`Task ${entry.num} is locked (round ${locked.round}) with different Produces; pass --relock once the coordinator accepts the change`);
  }
  return { entries: [...held.values()].sort(byNum), errors };
}

export function checkLock({ lockText, blocks }) {
  const findings = [];
  const entries = new Map(parseLock(lockText).map((entry) => [entry.num, entry]));
  const taskText = new Map(blocks.map(({ num, text }) => [num, text]));
  for (const { num, round, produces } of entries.values()) {
    if (!taskText.has(num)) findings.push(`Task ${num}: is locked but has no task file`);
    else if (!sameItems(interfaceLines(taskText.get(num)).produces, produces))
      findings.push(`Task ${num}: Produces differ from the interface lock (round ${round}); a drafter that must change a pinned interface returns an interface-delta, and the coordinator relocks`);
  }
  for (const { num, text } of blocks) {
    for (const { from, text: item } of interfaceLines(text).consumes) {
      const locked = from.filter((p) => entries.has(p));
      if (locked.length === 0) continue;
      const carried = locked.flatMap((p) => entries.get(p).produces).join("\n");
      const owners = locked.join("+");
      for (const span of codeSpans(item))
        if (!carried.includes(span))
          findings.push(`Task ${num}: consumes \`${span}\` from Task ${owners}, which the interface lock's Task ${owners} entry does not carry verbatim`);
    }
  }
  return { findings };
}

function fail(message, code = 1) {
  console.error(`interface-lock: ${message}`);
  process.exit(code);
}

function usage(message) {
  if (message) console.error(`interface-lock: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function readBlocks(workDir) {
  if (!existsSync(join(workDir, "tasks"))) fail(`missing ${join(workDir, "tasks")}`);
  return readTasks(workDir).flatMap(({ text }) => taskBlocks(text));
}

function readLock(lockPath) {
  return existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
}

function write(workDir, flags) {
  if (flags["--round"] === undefined || !isPositiveIntegerArg(flags["--round"])) usage("--round takes a positive integer");
  const round = Number(flags["--round"]);
  let nums;
  if (flags["--tasks"] !== undefined) {
    const parts = flags["--tasks"].split(",").map((part) => part.trim());
    if (!parts.every(isPositiveIntegerArg)) usage("--tasks takes task numbers like 1,2");
    nums = parts.map(Number);
  }
  const lockPath = join(workDir, LOCK_FILE);
  const lockText = readLock(lockPath);
  const existing = lockText === null ? [] : parseLock(lockText);
  const blocks = readBlocks(workDir);
  if (nums === undefined) {
    const locked = new Set(existing.map(({ num }) => num));
    nums = blocks.map(({ num }) => num).filter((num) => !locked.has(num));
    if (nums.length === 0) fail("no unlocked task files to lock");
  } else {
    for (const num of nums) if (!blocks.some((block) => block.num === num)) fail(`Task ${num} has no task file`);
  }
  const fresh = extractLock(blocks, round, nums);
  const { entries, errors } = mergeLock(existing, fresh, { relock: flags["--relock"] === true });
  if (errors.length) {
    for (const error of errors) console.error(`interface-lock: ${error}`);
    process.exit(1);
  }
  atomicWrite(lockPath, renderLock(entries));
  console.log(`interface-lock: locked ${fresh.map(({ num }) => `Task ${num} (round ${round})`).join(", ")} in ${lockPath}`);
}

function check(workDir) {
  const lockText = readLock(join(workDir, LOCK_FILE));
  if (lockText === null) fail(`no ${LOCK_FILE} in ${workDir}`);
  const { findings } = checkLock({ lockText, blocks: readBlocks(workDir) });
  if (findings.length) {
    for (const finding of findings) console.error(`interface-lock: ${finding}`);
    process.exit(1);
  }
  console.log(`interface-lock: ${parseLock(lockText).length} locked task(s) match their task files`);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, { "--round": "value", "--tasks": "value", "--relock": "none" }, { allowPositionals: true, requireValues: "nonEmpty" });
  } catch (e) {
    usage(e.message);
  }
  const { flags, positionals } = parsed;
  const [command, workDir] = positionals;
  if (positionals.length !== 2) usage();
  if (command === "write") return write(workDir, flags);
  if (command === "check") {
    if (Object.keys(flags).length) usage("check takes no flags");
    return check(workDir);
  }
  return usage();
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
