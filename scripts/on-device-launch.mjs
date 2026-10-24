#!/usr/bin/env node
// The on-device stage's launch, ready poll and teardown (references/checklist.md § Launch contract).
// Every process it starts is recorded under .devcycle/, so a later session can stop what an
// earlier one left running.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags, requireCount } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { now } from "./stamp.mjs";

const RECORD = ".devcycle/on-device-launch.json";
const STOP_GRACE_MS = 5000;
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

export function startProcess({ cmd, dir }) {
  const record = readRecord(dir);
  mkdirSync(join(dir, ".devcycle"), { recursive: true });
  const log = `.devcycle/on-device-launch-${record.processes.length + 1}.log`;
  const fd = openSync(join(dir, log), "w");
  let child;
  try {
    // detached makes the shell a process-group leader, so stopAll's group signal also reaches
    // whatever the launch command forks (a dev server under npm, say).
    child = spawn("sh", ["-c", cmd], { cwd: dir, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  // A spawn that fails emits "error" on a later tick; the missing pid below is what reports it.
  child.once("error", () => {});
  if (!child.pid) throw new Error(`could not start sh -c ${JSON.stringify(cmd)}`);
  child.unref();
  record.processes.push({ pid: child.pid, cmd, log, startedAt: now() });
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

export async function waitReady({ dir, url, logMatch, timeoutMs = DEFAULT_TIMEOUT_S * 1000, intervalMs = 500 }) {
  if (!url === !logMatch) throw new Error("pass exactly one of url and logMatch");
  const pattern = logMatch ? new RegExp(logMatch) : null;
  const started = Date.now();
  for (;;) {
    const { processes } = readRecord(dir);
    const detail = url ? await urlAnswers(url) : logMatches(dir, processes, pattern);
    const waitedMs = Date.now() - started;
    if (detail) return { ready: true, waitedMs, detail };
    if (waitedMs >= timeoutMs) return { ready: false, waitedMs, detail: lastLogLines(dir, processes) };
    await sleep(intervalMs);
  }
}

// false when the group is gone; any other failure (EPERM: the pid now leads someone else's group)
// must stop the teardown rather than read as stopped.
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    throw new Error(`cannot signal process group ${pid} (${err.code}) — check what runs as ${pid}, stop it yourself, then delete ${RECORD}`);
  }
}

export async function stopAll(dir) {
  const { processes } = readRecord(dir);
  const signalled = processes.map(({ pid }) => pid).filter((pid) => signalGroup(pid, "SIGTERM"));
  const alive = (pid) => signalGroup(pid, 0);
  const deadline = Date.now() + STOP_GRACE_MS;
  while (signalled.some(alive) && Date.now() < deadline) await sleep(100);
  for (const pid of signalled.filter(alive)) signalGroup(pid, "SIGKILL");
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
  const { stopped } = await stopAll(dir);
  return { out: stopped === 0 ? "nothing to stop" : `stopped ${stopped} process(es)` };
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
