#!/usr/bin/env node
// Intra-stage progress: the one owner of `.devcycle/stage-log/<run>.jsonl`, so a stage resumed after a
// stop, a crash or a /clear skips the sub-steps it already finished. Keyed by run, so a new cycle never
// reads an old cycle's log and nothing needs a reset. Appends are locked as scripts/task-ledger.mjs
// locks the ledger; reads take the latest line per key. Run as a task-script CLI by the stages.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { withFileLock } from "./file-lock.mjs";
import { isMain } from "./is-main.mjs";
import { eachRecord } from "./jsonl.mjs";
import { field } from "./md-field.mjs";
import { now as stamp } from "./stamp.mjs";
import { UsageError, runTaskScript, taskFlags } from "./task-ledger.mjs";

const RUN_ID = /^[0-9a-f]{16}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMANDS = {
  log: { "--state": "value", "--stage": "value", "--key": "value", "--ref": "value", "--data": "value" },
  read: { "--state": "value", "--stage": "value" },
};

const logPath = (devcycleDir, run) => join(devcycleDir, "stage-log", `${run}.jsonl`);

function checkIdentity({ run, stage }) {
  if (!RUN_ID.test(run ?? "")) throw new UsageError(`a stage log belongs to a 16-hex run id, got "${run}"`);
  if (!NAME.test(stage ?? "")) throw new UsageError(`--stage must be a stage name, got "${stage}"`);
}

// The latest line per key, oldest first, so a caller reads the stage's progress in order.
export function readStage(devcycleDir, { run, stage }) {
  checkIdentity({ run, stage });
  const latest = new Map();
  eachRecord(logPath(devcycleDir, run), (line) => {
    if (line?.stage !== stage) return;
    latest.delete(line.key);
    latest.set(line.key, line);
  });
  return [...latest.values()];
}

// Logging a step again with the same content appends nothing, so a re-run after a crash stays one line;
// new content for a key appends, and its latest line wins.
export function logStep(devcycleDir, { run, stage, key, data, ref, now = stamp() }) {
  checkIdentity({ run, stage });
  if (!NAME.test(key ?? "")) throw new UsageError(`--key must be one token of letters, digits, dots, dashes or underscores, got "${key}"`);
  if (ref !== undefined && isAbsolute(ref)) throw new UsageError(`--ref must be relative to the checkout, so no machine path lands in the log, got "${ref}"`);
  const path = logPath(devcycleDir, run);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(path, () => {
    const previous = readStage(devcycleDir, { run, stage }).find((line) => line.key === key);
    if (previous && JSON.stringify([previous.data, previous.ref]) === JSON.stringify([data, ref])) return { appended: false, line: previous };
    const line = { stage, key, at: now, data, ref };
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    appendFileSync(path, (text === "" || text.endsWith("\n") ? "" : "\n") + JSON.stringify(line) + "\n");
    return { appended: true, line: JSON.parse(JSON.stringify(line)) };
  });
}

function parseData(text) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError("--data must be JSON");
  }
}

function runCommand(command, argv) {
  const known = COMMANDS[command];
  if (!known) throw new UsageError(`the command is log or read, got "${command}"`);
  const flags = taskFlags(argv, known, command === "log" ? ["--state", "--stage", "--key"] : ["--state", "--stage"]);
  const devcycleDir = dirname(flags["--state"]);
  if (!existsSync(flags["--state"])) throw new Error(`no state file at ${flags["--state"]}`);
  const run = field(readFileSync(flags["--state"], "utf8"), "run");
  if (!RUN_ID.test(run ?? "")) throw new Error(`${flags["--state"]} names no run, so there is no stage log to use`);
  const stage = flags["--stage"];
  if (command === "read") return { steps: readStage(devcycleDir, { run, stage }) };
  const { appended, line } = logStep(devcycleDir, { run, stage, key: flags["--key"], ref: flags["--ref"], data: parseData(flags["--data"]) });
  return { appended: appended ? [line.key] : [], line };
}

if (isMain(import.meta.url, process.argv[1])) {
  const [command, ...argv] = process.argv.slice(2);
  runTaskScript("stage-log", () => runCommand(command, argv));
}
