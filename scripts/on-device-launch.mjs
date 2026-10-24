#!/usr/bin/env node
// The on-device stage's launch, ready poll and teardown (references/checklist.md § Launch contract).
// Every process it starts is recorded under .devcycle/, so a later session can stop what an
// earlier one left running.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags, requireCount } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { now } from "./stamp.mjs";

const RECORD = ".devcycle/on-device-launch.json";
const STOP_GRACE_MS = 5000;
// ps prints whole seconds, and a clock step (NTP) can shift a start time by a second or so.
const FINGERPRINT_TOLERANCE_MS = 2000;
const URL_ATTEMPT_MS = 2000;
const DEFAULT_TIMEOUT_S = 60;

const recordPath = (dir) => join(dir, RECORD);

export function readRecord(dir) {
  const path = recordPath(dir);
  if (!existsSync(path)) return { processes: [] };
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(record?.processes))
    throw new Error(`${RECORD} has no processes list — check nothing it started is still running, then delete it`);
  return record;
}

// The process's start time as ps prints it (in UTC, so a changed TZ cannot change it), or null when
// no such process exists. Recorded at start and compared at stop, because a recorded pid can outlive
// a reboot and then belong to a stranger.
export function processFingerprint(pid) {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

// An unparseable start time can only match itself exactly.
function sameStart(current, recorded) {
  const [a, b] = [current, recorded].map((text) => Date.parse(`${text} UTC`));
  return Number.isNaN(a) || Number.isNaN(b) ? current === recorded : Math.abs(a - b) <= FINGERPRINT_TOLERANCE_MS;
}

export function startProcess({ cmd, dir }) {
  const record = readRecord(dir);
  mkdirSync(join(dir, ".devcycle"), { recursive: true });
  const number = record.processes.length + 1;
  const log = `.devcycle/on-device-launch-${number}.log`;
  const exit = `.devcycle/on-device-launch-${number}.exit`;
  rmSync(join(dir, exit), { force: true });
  const fd = openSync(join(dir, log), "w");
  let child;
  try {
    // detached makes the outer shell a process-group leader, so stopAll's group signal also reaches
    // whatever the launch command forks (a dev server under npm, say). It runs the command in an
    // inner shell and writes its exit status to the exit file: waitReady needs that to tell a crash
    // from a launcher that exited 0 after handing the app to something else.
    child = spawn("sh", ["-c", 'sh -c "$0"; echo $? > "$1"', cmd, join(dir, exit)], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  // A spawn that fails emits "error" on a later tick; the missing pid below is what reports it.
  child.once("error", () => {});
  if (!child.pid) throw new Error(`could not start sh -c ${JSON.stringify(cmd)}`);
  child.unref();
  record.processes.push({ pid: child.pid, cmd, log, exit, startedAt: now(), fingerprint: processFingerprint(child.pid) });
  atomicWrite(recordPath(dir), JSON.stringify(record, null, 2) + "\n");
  return { pid: child.pid, log };
}

const logText = (dir, { log }) => {
  const path = join(dir, log);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const lastLogLines = (dir, processes, count = 5) =>
  processes.flatMap((p) => logText(dir, p).split("\n").filter((l) => l.trim())).slice(-count).join(" | ") ||
  "no log output";

async function urlAnswers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(URL_ATTEMPT_MS) });
    await res.body?.cancel();
    return `${url} answered ${res.status}`;
  } catch {
    return null;
  }
}

function logMatches(dir, processes, pattern) {
  const hit = processes.find((p) => pattern.test(logText(dir, p)));
  return hit ? `${hit.log} matched /${pattern.source}/` : null;
}

const sendSignal = (pid, signal) => process.kill(pid, signal);

// A target that answers with anything but ESRCH is still there: EPERM is what macOS returns for a
// moment while a group dies.
function probe(target, kill) {
  try {
    kill(target, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

const groupAlive = (pid, kill = sendSignal) => probe(-pid, kill);

// The launch's exit status, or null when it left none: the leader was killed before it could write
// one, or the record predates exit files.
function exitStatus(dir, { exit }) {
  const path = exit && join(dir, exit);
  return path && existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : null;
}

// A launch that ended with a failure, or with no status at all. One that exited 0 may have handed
// the app to another process, so only waiting tells whether it came up.
const crashed = (dir, p) => !groupAlive(p.pid) && exitStatus(dir, p) !== 0;

export async function waitReady({ dir, url, logMatch, timeoutMs = DEFAULT_TIMEOUT_S * 1000, intervalMs = 500 }) {
  if (!url === !logMatch) throw new Error("pass exactly one of url and logMatch");
  const pattern = logMatch ? new RegExp(logMatch) : null;
  const started = Date.now();
  for (;;) {
    const { processes } = readRecord(dir);
    // A crashed launch fails fast, and an answer then comes from something the launch did not start.
    if (processes.length > 0 && processes.every((p) => crashed(dir, p)))
      return { ready: false, waitedMs: Date.now() - started, detail: `the launched process exited — ${lastLogLines(dir, processes)}` };
    const detail = url ? await urlAnswers(url) : logMatches(dir, processes, pattern);
    const waitedMs = Date.now() - started;
    if (detail) return { ready: true, waitedMs, detail };
    if (waitedMs >= timeoutMs) return { ready: false, waitedMs, detail: lastLogLines(dir, processes) };
    await sleep(intervalMs);
  }
}

// false when the group is gone; any other failure (EPERM: the pid now leads someone else's group)
// must stop the teardown rather than read as stopped.
function signalGroup(pid, signal, kill) {
  try {
    kill(-pid, signal);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw new Error(`cannot signal process group ${pid} (${err.code}) — check what runs as ${pid}, stop it yourself, then delete ${RECORD}`);
  }
}

// kill, fingerprint, leaderAlive and onSkipped are injectable so a test can stage a dying group and a
// reused pid. onSkipped(pid, reason) hears of each recorded pid that is alive but is not confirmed to
// be the process the launch started, and none of those is signalled: reason is "mismatch" when its
// start time differs from the recorded one, "unconfirmed" when it cannot be compared.
export async function stopAll(dir, { kill = sendSignal, fingerprint = processFingerprint, leaderAlive = (pid) => probe(pid, kill), onSkipped = () => {} } = {}) {
  const { processes } = readRecord(dir);
  const ours = processes.filter(({ pid, fingerprint: recorded }) => {
    // A pid is not reused while a process group with that id exists, so the remnants of a group
    // whose leader exited (a server the launch command backgrounded) are still the launch's.
    if (!leaderAlive(pid)) return groupAlive(pid, kill);
    const current = fingerprint(pid);
    if (current && recorded && sameStart(current, recorded)) return true;
    onSkipped(pid, current && recorded ? "mismatch" : "unconfirmed");
    return false;
  });
  const signalled = ours.map(({ pid }) => pid).filter((pid) => signalGroup(pid, "SIGTERM", kill));
  const alive = (pid) => groupAlive(pid, kill);
  const deadline = Date.now() + STOP_GRACE_MS;
  while (signalled.some(alive) && Date.now() < deadline) await sleep(100);
  // Best effort: a group that still answers EPERM is already exiting.
  for (const pid of signalled.filter(alive)) {
    try { kill(-pid, "SIGKILL"); } catch { /* exiting */ }
  }
  for (const { exit } of processes) if (exit) rmSync(join(dir, exit), { force: true });
  rmSync(recordPath(dir), { force: true });
  return { stopped: signalled.length, alreadyGone: processes.length - signalled.length };
}

const USAGE =
  "usage: on-device-launch.mjs start --cmd '<command>' [--dir <repo root>] | " +
  "ready (--url <url> | --log-match <regex>) [--timeout <seconds>] [--dir <repo root>] | stop [--dir <repo root>]";
const FLAGS = {
  start: { "--cmd": "value", "--dir": "value" },
  ready: { "--url": "value", "--log-match": "value", "--timeout": "value", "--dir": "value" },
  stop: { "--dir": "value" },
};

async function main(argv) {
  const [sub, ...rest] = argv;
  if (!Object.hasOwn(FLAGS, sub)) throw new Error(`unknown subcommand ${JSON.stringify(sub ?? "")}`);
  const { flags } = parseFlags(rest, FLAGS[sub], { requireValues: "nonEmpty" });
  const dir = resolve(flags["--dir"] ?? process.cwd());
  if (sub === "start") {
    if (!flags["--cmd"]) throw new Error("start needs --cmd '<the checklist's Launch: command>'");
    const { pid, log } = startProcess({ cmd: flags["--cmd"], dir });
    return { out: `started ${pid} (log: ${log})` };
  }
  if (sub === "ready") {
    const url = flags["--url"];
    const logMatch = flags["--log-match"];
    if (!url === !logMatch) throw new Error("ready needs exactly one of --url and --log-match (the checklist's Ready: check)");
    const seconds = requireCount(flags, "--timeout", { noun: "a whole number of seconds" }) ?? DEFAULT_TIMEOUT_S;
    const r = await waitReady({ dir, url, logMatch, timeoutMs: seconds * 1000 });
    const waited = Math.round(r.waitedMs / 1000);
    if (r.ready) return { out: `ready (${r.detail}, ${waited}s)` };
    return { code: 1, err: `on-device-launch: not ready after ${waited}s — ${r.detail}; start the app yourself or fix Launch:` };
  }
  const skipped = [];
  const { stopped } = await stopAll(dir, { onSkipped: (pid, reason) => skipped.push({ pid, reason }) });
  const lines = [stopped === 0 ? "nothing to stop" : `stopped ${stopped} process(es)`];
  for (const { pid, reason } of skipped)
    lines.push(`left ${pid} alone: ${reason === "mismatch" ? "it is not" : "cannot confirm it is"} the process the launch started`);
  return { out: lines.join("\n") };
}

if (isMain(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    ({ code = 0, out, err }) => {
      if (out) console.log(out);
      if (err) console.error(err);
      process.exitCode = code;
    },
    (e) => {
      console.error(`on-device-launch: ${e.message}`);
      console.error(`on-device-launch: ${USAGE}`);
      process.exitCode = 1;
    }
  );
}
