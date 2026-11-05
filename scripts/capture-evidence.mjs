#!/usr/bin/env node
// Runs a task's verification command, writes its evidence capture, and prints the report lines to
// copy (references/evidence.md § File-backed evidence). With no --cmd it runs the task's resolved gate
// command, so the capture's header, the report's cmd: and the task's gate are one string. --await waits
// in the foreground for a capture of that task and phase running elsewhere, then prints its lines
// (references/evidence.md § File-backed evidence).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { currentDispatchStartMs } from "./dispatch-health.mjs";
import { isMain } from "./is-main.mjs";
import { runShell, writeCapture } from "./evidence-capture.mjs";
import { HelpRequest, UsageError, checkTaskId, taskFlags, taskGate, usageLine, workTreeRoot } from "./task-ledger.mjs";

const FLAGS = { "--task": "value", "--phase": "value", "--cmd": "value", "--ledger": "value", "--await": "none" };
const PHASES = ["before", "after", "red"];
// Under the Bash tool's 10-minute ceiling, so one --await is always one bounded foreground call.
export const AWAIT_TIMEOUT_MS = Number(process.env.DEVCYCLE_AWAIT_TIMEOUT_MS) || 9 * 60_000;
// A capture backgrounded a moment ago may not have written its marker yet.
const AWAIT_START_GRACE_MS = Number(process.env.DEVCYCLE_AWAIT_START_GRACE_MS) || 5_000;
const AWAIT_POLL_MS = 200;

const capturePaths = (root, task, phase) => {
  const rel = `.devcycle/evidence/${task}-${phase}.txt`;
  return { rel, abs: join(root, rel), marker: join(root, `.devcycle/evidence/${task}-${phase}.running`) };
};
const reportLines = (phase, evidenceClass, cmd, rel, status) => {
  const label = phase[0].toUpperCase() + phase.slice(1);
  return [...(phase === "red" ? [] : [`- Evidence: ${evidenceClass} | cmd: ${cmd}`]), `- ${label}: ${rel} (exit ${status})`];
};
const readMarker = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A capture counts only when it is this one's: written after the marker appeared or, with no marker
// seen, since this task's current dispatch started — never a file an earlier attempt left on the path.
function awaitCapture({ root, task, phase, evidenceClass }) {
  const { rel, abs, marker } = capturePaths(root, task, phase);
  const started = Date.now();
  let since = null;
  for (;;) {
    const m = readMarker(marker);
    if (m) {
      since = Date.parse(m.startedAt);
      if (!Number.isInteger(m.pid) || !alive(m.pid))
        throw new Error(`the ${phase} capture for task ${task} died (pid ${m.pid} is gone, its marker left behind) — re-run the capture in the foreground`);
    } else {
      const floor = since ?? currentDispatchStartMs(root, task);
      if (existsSync(abs) && (floor === null || statSync(abs).mtimeMs >= floor)) break;
      if (Date.now() - started >= AWAIT_START_GRACE_MS) {
        if (since !== null) throw new Error(`the ${phase} capture for task ${task} ended without writing ${rel} — re-run the capture in the foreground`);
        if (existsSync(abs)) throw new Error(`${rel} predates this dispatch — it is an earlier attempt's; run the capture again`);
        throw new UsageError(`no ${phase} capture is running or written for task ${task} — run the capture first`);
      }
    }
    if (Date.now() - started >= AWAIT_TIMEOUT_MS)
      throw new Error(`the ${phase} capture for task ${task} is still running after ${Math.round(AWAIT_TIMEOUT_MS / 1000)}s — run --await again`);
    pause(AWAIT_POLL_MS);
  }
  const text = readFileSync(abs, "utf8");
  const cmd = text.match(/^# devcycle-cmd: (.*)$/m)?.[1];
  const status = [...text.matchAll(/^# exit (\d+)$/gm)].at(-1)?.[1];
  if (cmd === undefined || status === undefined) throw new Error(`${rel} is not a finished capture (no devcycle-cmd header or exit line)`);
  return reportLines(phase, evidenceClass, cmd, rel, Number(status));
}

export function captureEvidence(argv, cwd = process.cwd()) {
  const flags = taskFlags(argv, FLAGS, ["--task", "--phase"]);
  const { "--task": task, "--phase": phase } = flags;
  checkTaskId(task);
  if (!PHASES.includes(phase)) throw new UsageError(`--phase must be one of ${PHASES.join(", ")}, got "${phase}"`);
  const root = workTreeRoot(cwd);
  const ledger = flags["--ledger"] ? resolve(cwd, flags["--ledger"]) : join(root, ".devcycle/ledger.md");
  if (flags["--await"]) {
    if (flags["--cmd"] !== undefined) throw new UsageError("--await waits on a running capture and takes no --cmd");
    return awaitCapture({ root, task, phase, evidenceClass: taskGate(ledger, task)?.evidenceClass ?? "<class>" });
  }
  const explicit = flags["--cmd"]?.trim();
  if (phase === "red" && !explicit)
    throw new UsageError("--phase red needs --cmd: the red capture runs the task's own failing subset, never the whole gate");
  const gate = taskGate(ledger, task);
  const cmd = explicit || gate?.cmd;
  if (!cmd)
    throw new UsageError(`no gate command resolves for task ${task} (no plan in the ledger, or no gate for this task in it) — pass --cmd`);
  if (/[\r\n]/.test(cmd)) throw new UsageError("--cmd must be one line: the capture's header holds it on its first line");
  const { rel, marker } = capturePaths(root, task, phase);
  mkdirSync(dirname(marker), { recursive: true });
  atomicWrite(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), cmd }) + "\n");
  let run;
  try {
    run = runShell(root, cmd);
    writeCapture(root, rel, [run]);
  } finally {
    rmSync(marker, { force: true });
  }
  // The class comes from the plan; a task no plan resolves keeps a placeholder the evidence check rejects.
  return reportLines(phase, gate?.evidenceClass ?? "<class>", cmd, rel, run.status);
}

function captureMain(argv) {
  try {
    for (const line of captureEvidence(argv)) console.log(line);
  } catch (err) {
    if (err instanceof HelpRequest) return console.log(usageLine("capture-evidence", err.usage));
    console.error(`capture-evidence: ${err.message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url, process.argv[1])) captureMain(process.argv.slice(2));
