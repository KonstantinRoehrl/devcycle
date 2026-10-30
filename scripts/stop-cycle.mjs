#!/usr/bin/env node
// What /devcycle:stop runs (commands/stop.md). Each subcommand prints one JSON object and is safe to
// repeat. It signals only what the driver lock and the on-device launch record name, through their
// owners, and it never deletes a draft, commits or resets the tree.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { activeRun } from "../hooks/lib/run-scope.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { markStopped } from "./dispatch-health.mjs";
import { readDriveLockHolder } from "./drive-lock.mjs";
import { SIGNAL_GRACE_MS, stopDriver } from "./drive-execution.mjs";
import { holderRunning } from "./drive-result.mjs";
import { describe, findStateFiles } from "./find-state-files.mjs";
import { markHandoff, withStateRow, withoutStateRow } from "./handoff-mark.mjs";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { stopAll } from "./on-device-launch.mjs";
import { openProcesses, readProcesses } from "./process-registry.mjs";
import { checkState } from "./resume-check.mjs";
import { gitToplevel, hashSession, recordPath } from "./run-record.mjs";
import { readStage } from "./stage-log.mjs";
import { CLOSED_STAGE } from "./stage-entry.mjs";
import { now as stamp } from "./stamp.mjs";
import { isLiveRequest, readStopRecord, readStopRequest, stopPaths } from "./stop-files.mjs";
import { parseLedgerLine, workTreeRoot } from "./task-ledger.mjs";

const RECORD_REL = ".devcycle/stop.json";
const POLL_MS = 500;
const QUIET_MS = 10_000;
const QUIET_CAP_MS = 60_000;
// The driver's own grace before it kills its session, then time to write its end record and handoff mark.
const DRIVER_EXIT_MS = SIGNAL_GRACE_MS + 5_000;

const placeOf = (state) => {
  const statePath = resolve(state);
  const devcycleDir = dirname(statePath);
  return { statePath, devcycleDir, root: dirname(devcycleDir) };
};
const callerHash = (env) => (env.CLAUDE_CODE_SESSION_ID ? hashSession(env.CLAUDE_CODE_SESSION_ID) : null);
const isForeign = (statePath) => checkState(statePath).kind === "foreign";
const uniqueBy = (entries) => [...new Map(entries.map((e) => [`${e.kind}:${e.id}`, e])).values()];
// A report field never costs the stop itself.
const orElse = (read, fallback) => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

export function listCandidates({ state = null, cwd = process.cwd() } = {}) {
  const paths = state ? [resolve(state)] : findStateFiles(orElse(() => workTreeRoot(cwd), cwd));
  return {
    candidates: paths
      .map((path) => ({ ...describe(path), path }))
      .filter(({ stage }) => stage !== CLOSED_STAGE)
      .map(({ path, request, stage, branch }) => ({ state: path, request, stage, branch, foreign: isForeign(path) })),
  };
}

function joinedSessions(root, run) {
  if (!run) return [];
  const text = orElse(() => readFileSync(recordPath(gitToplevel(root), run), "utf8"), "");
  const rows = text.split("\n").map((line) => orElse(() => JSON.parse(line), null));
  return [...new Set(rows.filter((row) => row?.kind === "session" && row.sessionHash).map((row) => row.sessionHash))];
}

async function stopTheDriver(statePath, root, { kill, sleep, now }) {
  const said = [];
  const say = (line) => said.push(line);
  let exit;
  try {
    exit = stopDriver(statePath, { kill, out: say, say });
  } catch (err) {
    return { exit: 1, detail: `could not stop the driver (${err.code ?? "unexpected error"})` };
  }
  if (exit === 3) return { exit, detail: "no driver was running" };
  if (exit !== 0) return { exit, detail: said.join(" ").replace(/^drive-execution: /, "") };
  const { pid } = JSON.parse(said[0]);
  const deadline = now() + DRIVER_EXIT_MS;
  while (holderRunning(root, readDriveLockHolder(root)) && now() < deadline) await sleep(POLL_MS);
  return holderRunning(root, readDriveLockHolder(root))
    ? { exit, detail: `signalled the driver (pid ${pid}), which had not exited after ${DRIVER_EXIT_MS / 1000} s` }
    : { exit, detail: `stopped the driver (pid ${pid})` };
}

async function stopTheApp(root) {
  const skipped = [];
  try {
    const { stopped, alreadyGone } = await stopAll(root, { onSkipped: (pid, reason) => skipped.push({ pid, reason }) });
    return { stopped, alreadyGone, skipped };
  } catch (err) {
    return { stopped: 0, alreadyGone: 0, skipped, error: launchFailure(err) };
  }
}

// A filesystem error's message names the full path and a parse error's quotes the record, and this text
// reaches the report and the stop record. The launch script's own errors carry neither.
const launchFailure = (err) => {
  if (err.code) return `could not read the launch record (${err.code})`;
  return err instanceof SyntaxError ? "could not read the launch record (it is not valid JSON)" : err.message;
};

// A repeat finds nothing left to stop, which must not erase what the first run stopped.
const mergedActions = (earlier, driver, onDevice) => {
  if (!earlier) return { driver, onDevice };
  const before = earlier.onDevice;
  return {
    driver: driver.exit === 3 ? earlier.driver : driver,
    onDevice: {
      stopped: before.stopped + onDevice.stopped,
      alreadyGone: onDevice.alreadyGone,
      skipped: [...before.skipped, ...onDevice.skipped],
      ...((onDevice.error ?? before.error) ? { error: onDevice.error ?? before.error } : {}),
    },
  };
};

export async function requestStop({ state, env = process.env, kill, sleep = defaultSleep, now = Date.now }) {
  const { statePath, devcycleDir, root } = placeOf(state);
  if (isForeign(statePath))
    return {
      requested: false,
      reason: "this state file belongs to another checkout, so nothing was stopped",
      driver: null, onDevice: null, owned: [], otherSessions: [],
    };
  const paths = stopPaths(devcycleDir);
  const run = activeRun(readFileSync(statePath, "utf8"))?.run ?? null;
  const caller = callerHash(env);
  const earlier = readStopRequest(devcycleDir);
  const live = isLiveRequest(earlier, now());
  if (!live) rmSync(paths.ack, { force: true });
  const request = {
    requestedAt: live ? earlier.requestedAt : stamp(),
    requestedBy: live ? earlier.requestedBy : caller,
    run,
    sessions: [...new Set([...(live ? earlier.sessions : []), ...joinedSessions(root, run)])],
  };
  // Written before anything is signalled, so the guard already holds whatever the signals miss.
  atomicWrite(paths.request, `${JSON.stringify({ ...request, actions: live ? earlier.actions : undefined })}\n`);
  const driver = await stopTheDriver(statePath, root, { kill, sleep, now });
  const onDevice = await stopTheApp(root);
  const actions = mergedActions(live ? earlier.actions : null, driver, onDevice);
  atomicWrite(paths.request, `${JSON.stringify({ ...request, actions })}\n`);
  const open = run ? openProcesses(devcycleDir, { run, now: now() }) : [];
  return {
    requested: true,
    ...actions,
    owned: open.filter((p) => caller && p.session === caller).map(({ id, kind }) => ({ id, kind })),
    otherSessions: open.filter((p) => !caller || p.session !== caller).map(({ id, kind, session }) => ({ id, kind, session })),
  };
}

// The guard appends a line per denial, so a file that stops growing means the cycle's work has gone quiet.
export async function waitForQuiet(devcycleDir, requestedAt, { sleep = defaultSleep, now = Date.now } = {}) {
  const { ack } = stopPaths(devcycleDir);
  const size = () => orElse(() => statSync(ack).size, 0);
  const capAt = Date.parse(requestedAt) + QUIET_CAP_MS;
  let seen = size();
  let lastGrowth = now();
  while (now() < capAt && now() - lastGrowth < QUIET_MS) {
    await sleep(POLL_MS);
    const current = size();
    if (current !== seen) {
      seen = current;
      lastGrowth = now();
    }
  }
}

function uncommittedPaths(root) {
  const fields = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "-z"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    paths.push(fields[i].slice(3));
    // A rename or copy carries its old path as the next field.
    if (/[RC]/.test(fields[i].slice(0, 2))) i++;
  }
  return paths;
}

function latestLedgerEvents(devcycleDir) {
  const latest = {};
  for (const line of readFileSync(join(devcycleDir, "ledger.md"), "utf8").split("\n")) {
    const entry = parseLedgerLine(line);
    if (entry) latest[entry.task] = entry.event;
  }
  return latest;
}

function positionOf(devcycleDir, run, stage, ledger) {
  const lines = run ? orElse(() => Object.values(readStage(devcycleDir, { run, stage })), []) : [];
  lines.sort((a, b) => a.at.localeCompare(b.at));
  const done = lines.map(({ key }) => key);
  const last = lines.at(-1)?.key ?? null;
  const tasks = Object.keys(ledger).length;
  const summary = tasks ? `${tasks} tasks in the ledger`
    : done.length ? `${done.length} steps logged, the last ${last}`
    : "no steps logged";
  return { done, last, summary };
}

const STOP_HOW = {
  taskstop: "stopped with TaskStop",
  finished: "ended after the stop request",
  absent: "ended after the stop request",
};
const howStopped = ({ kind, endedBy }) =>
  kind === "monitor" && endedBy === "taskstop"
    ? "stopped with TaskStop, unconfirmed for a Monitor, which may keep running until its timeout"
    : STOP_HOW[endedBy];

function leftReason({ kind, session }, caller) {
  if (caller && session === caller) return "still running after this stop; stop it here with /tasks";
  if (kind === "subagent") return "started by another session: its next tool call is denied, so it ends then, and one inside a long tool call runs until that call returns";
  return "started by another session: only that session can stop it, with /tasks";
}

export async function finalizeStop({ state, env = process.env, sleep = defaultSleep, now = Date.now, mark = markStopped }) {
  const { statePath, devcycleDir, root } = placeOf(state);
  const paths = stopPaths(devcycleDir);
  const request = readStopRequest(devcycleDir);
  const prior = readStopRecord(devcycleDir);
  if (!request)
    return prior
      ? { record: prior, path: RECORD_REL, stopped: prior.stopped, left: prior.left }
      : { record: null, path: null, stopped: [], left: [], reason: "no stop was requested for this cycle" };
  await waitForQuiet(devcycleDir, request.requestedAt, { sleep, now });

  const caller = callerHash(env);
  const run = request.run;
  const requestedMs = Date.parse(request.requestedAt);
  const retired = run
    ? readProcesses(devcycleDir).filter((p) => p.run === run && p.endedAt && new Date(p.endedAt).getTime() >= requestedMs)
    : [];
  // SubagentStop does not fire for a TaskStop-ed subagent, so its dispatch stamp is written here. Only the
  // owning session can TaskStop, and a dispatch record holds the raw id, which only this session knows.
  for (const { id, kind, session, endedBy } of retired)
    if (kind === "subagent" && endedBy === "taskstop" && session === caller)
      mark({ root, sessionId: env.CLAUDE_CODE_SESSION_ID, agentId: id, now: now() });

  const { driver = null, onDevice = null } = request.actions ?? {};
  const stage = field(readFileSync(statePath, "utf8"), "stage")?.split(/\s+/)[0] ?? null;
  const stopped = uniqueBy([
    ...(prior?.stopped ?? []),
    ...(driver?.exit === 0 ? [{ id: "driver", kind: "driver", how: driver.detail }] : []),
    ...(onDevice?.stopped ? [{ id: "on-device app", kind: "app", how: `stopped ${onDevice.stopped} launched process group(s)` }] : []),
    ...retired.map((p) => ({ id: p.id, kind: p.kind, how: howStopped(p) })),
  ]);
  const left = uniqueBy([
    ...(prior?.left ?? []).filter(({ kind }) => kind === "app"),
    ...(driver?.exit === 1 ? [{ id: "driver", kind: "driver", reason: driver.detail }] : []),
    ...(onDevice?.skipped ?? []).map(({ pid, reason }) => ({
      id: `pid ${pid}`, kind: "app",
      reason: reason === "mismatch" ? "it is not the process the launch started, so it was left alone" : "could not confirm it is the process the launch started, so it was left alone",
    })),
    ...(onDevice?.error ? [{ id: "on-device app", kind: "app", reason: onDevice.error }] : []),
    ...(run ? openProcesses(devcycleDir, { run, now: now() }) : []).map((p) => ({ id: p.id, kind: p.kind, reason: leftReason(p, caller) })),
    ...(stage === "on-device" ? [{ id: "browser tabs", kind: "tabs", reason: "tabs the on-device driver opened may remain, and devcycle keeps no record of them: close them yourself" }] : []),
  ]);
  const ledger = stage === "execution" ? orElse(() => latestLedgerEvents(devcycleDir), {}) : {};
  const record = {
    stage,
    stoppedAt: prior?.stoppedAt ?? stamp(),
    stoppedBy: prior?.stoppedBy ?? caller,
    run,
    sessions: request.sessions,
    position: positionOf(devcycleDir, run, stage, ledger),
    ledger,
    uncommitted: orElse(() => uncommittedPaths(root), []),
    stopped,
    left,
  };
  atomicWrite(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  atomicWrite(statePath, withStateRow(readFileSync(statePath, "utf8"), "stopped", `${record.stoppedAt} ${RECORD_REL}`));
  markHandoff({ statePath, state: "ready", action: "continue", env });
  // Last, so the guard stays live until the record exists.
  rmSync(paths.request, { force: true });
  return { record, path: RECORD_REL, stopped, left };
}

export function resumeStopped({ state }) {
  const { statePath, devcycleDir } = placeOf(state);
  const paths = stopPaths(devcycleDir);
  const text = readFileSync(statePath, "utf8");
  const hadRow = field(text, "stopped") !== null;
  const hadRecord = existsSync(paths.record);
  const record = readStopRecord(devcycleDir);
  if (hadRow) atomicWrite(statePath, withoutStateRow(text, "stopped"));
  // A finalize that died before its last step would otherwise keep denying this session.
  if (hadRow || hadRecord) rmSync(paths.request, { force: true });
  if (!hadRecord) return { resumed: hadRow, record: null };
  mkdirSync(paths.history, { recursive: true });
  renameSync(paths.record, join(paths.history, `${(record?.stoppedAt ?? stamp()).replaceAll(":", "-")}.json`));
  return { resumed: true, record };
}

const USAGE = "usage: stop-cycle.mjs list [--state <file>] | request --state <file> | finalize --state <file> | resume --state <file>";
const SUBCOMMANDS = {
  list: ({ state }) => listCandidates({ state }),
  request: ({ state }) => requestStop({ state }),
  finalize: ({ state }) => finalizeStop({ state }),
  resume: ({ state }) => resumeStopped({ state }),
};

async function main([sub, ...rest]) {
  if (!Object.hasOwn(SUBCOMMANDS, sub ?? "")) throw new Error(`unknown subcommand ${JSON.stringify(sub ?? "")}`);
  const { flags } = parseFlags(rest, { "--state": "value" }, { requireValues: "nonEmpty" });
  const state = flags["--state"] ?? null;
  if (sub !== "list" && !state) throw new Error(`${sub} needs --state <path to .devcycle/state.md>`);
  return SUBCOMMANDS[sub]({ state });
}

if (isMain(import.meta.url, process.argv[1]))
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result)),
    (err) => {
      console.error(`stop-cycle: ${err.message}`);
      console.error(`stop-cycle: ${USAGE}`);
      process.exitCode = 1;
    }
  );
