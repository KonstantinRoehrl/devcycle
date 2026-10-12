#!/usr/bin/env node
// Runs a task's verification command, writes its evidence capture, and prints the report lines to
// copy (references/evidence.md § File-backed evidence). With no --cmd it runs the task's resolved gate
// command, so the capture's header, the report's cmd: and the task's gate are one string.
import { join, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import { runShell, writeCapture } from "./evidence-capture.mjs";
import { UsageError, checkTaskId, taskFlags, taskGate, workTreeRoot } from "./task-ledger.mjs";

const FLAGS = { "--task": "value", "--phase": "value", "--cmd": "value", "--ledger": "value" };
const PHASES = ["before", "after", "red"];

export function captureEvidence(argv, cwd = process.cwd()) {
  const flags = taskFlags(argv, FLAGS, ["--task", "--phase"]);
  const { "--task": task, "--phase": phase } = flags;
  checkTaskId(task);
  if (!PHASES.includes(phase)) throw new UsageError(`--phase must be one of ${PHASES.join(", ")}, got "${phase}"`);
  const root = workTreeRoot(cwd);
  const explicit = flags["--cmd"]?.trim();
  if (phase === "red" && !explicit)
    throw new UsageError("--phase red needs --cmd: the red capture runs the task's own failing subset, never the whole gate");
  const ledger = flags["--ledger"] ? resolve(cwd, flags["--ledger"]) : join(root, ".devcycle/ledger.md");
  const cmd = explicit || taskGate(ledger, task)?.cmd;
  if (!cmd)
    throw new UsageError(`no gate command resolves for task ${task} (no plan in the ledger, or no gate for this task in it) — pass --cmd`);
  if (/[\r\n]/.test(cmd)) throw new UsageError("--cmd must be one line: the capture's header holds it on its first line");
  const run = runShell(root, cmd);
  const rel = writeCapture(root, `.devcycle/evidence/${task}-${phase}.txt`, [run]);
  const label = phase[0].toUpperCase() + phase.slice(1);
  return [...(phase === "red" ? [] : [`- Evidence: <class> | cmd: ${cmd}`]), `- ${label}: ${rel} (exit ${run.status})`];
}

if (isMain(import.meta.url, process.argv[1])) {
  try {
    for (const line of captureEvidence(process.argv.slice(2))) console.log(line);
  } catch (err) {
    console.error(`capture-evidence: ${err.message}`);
    process.exit(1);
  }
}
