// The driver's result file and the one reading of a run's state. scripts/drive-execution.mjs writes
// .devcycle/drive-result.json as a crash when a run starts and replaces it with the run's end before
// it releases its lock; classifyDrive turns that file, the lock and the state's stage into what the
// next /devcycle:continue does. Nothing else decides what a driver's end means.
import { mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { readDriveLockHolder, readLiveDriveLock } from "./drive-lock.mjs";
import { isLiveHolder, processStartTime } from "./file-lock.mjs";
import { field } from "./md-field.mjs";

export const LOG_REL = ".devcycle/drive.log";
export const RESULT_REL = ".devcycle/drive-result.json";
export const HANDLED_REL = ".devcycle/drive-result.handled.json";
export const STOP_REQUEST_REL = ".devcycle/drive-stop-request";
// The ends a restart retries as they are: none of them needs a person.
export const RESUMABLE = new Set(["interrupted", "failed", "wait-cap", "crashed"]);
// A run that ends this many times in a row without progress fails the same way every time.
const NO_PROGRESS_LIMIT = 2;

const resumableKey = (result) => (result.outcome === "budget" ? result.reason : result.outcome);

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeDriveResult(root, result) {
  mkdirSync(join(root, ".devcycle"), { recursive: true });
  atomicWrite(join(root, RESULT_REL), JSON.stringify(result, null, 2) + "\n");
}

export function readDriveResult(root) {
  return readJson(join(root, RESULT_REL));
}

export function readHandledResult(root) {
  return readJson(join(root, HANDLED_REL));
}

export function markResultHandled(root) {
  try {
    renameSync(join(root, RESULT_REL), join(root, HANDLED_REL));
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export function noProgressEndsAfter(root, { progressed }) {
  if (progressed) return 0;
  const previous = readHandledResult(root);
  return previous && RESUMABLE.has(resumableKey(previous)) ? (Number(previous.noProgressEnds) || 0) + 1 : 1;
}

const CRASH_DETAIL =
  "the driver ended without recording how its run ended (killed, or out of memory); the end of .devcycle/drive.log may say why";

// What a run that dies before it records its end leaves behind: written as the run starts, and again
// once it makes progress, so a crash counts toward the no-progress bound like any resumable end.
export function writeCrashedResult(root, { startedAt, progressed }) {
  writeDriveResult(root, {
    code: null, outcome: "crashed", reason: null, task: null, detail: CRASH_DETAIL, startedAt, endedAt: null,
    progressed, noProgressEnds: noProgressEndsAfter(root, { progressed }),
  });
}

// kill(pid, 0) says whether the pid exists. A lock that carries its holder's start in clock ticks
// (Linux) is judged by the lock module, which needs no ps: a clock step moves the start time ps
// prints, never the ticks. Otherwise the start time, where ps can read it, says whether the pid is
// still the process that wrote the lock; where ps cannot run, that stays "unverified".
export function holderLiveness(root, holder) {
  // kill() reads a pid of 0 or below as a process group.
  if (!holder || !(holder.pid > 0)) return "gone";
  try {
    process.kill(holder.pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return "gone";
  }
  if (typeof holder.ticks === "string") {
    const live = readLiveDriveLock(root);
    return live?.pid === holder.pid && live.startTime === holder.startTime ? "running" : "gone";
  }
  if (processStartTime(holder.pid) === null) return "unverified";
  return isLiveHolder(holder) ? "running" : "gone";
}

// A watcher whose sandbox runs no ps trusts the pid alone.
export const holderRunning = (root, holder) => holderLiveness(root, holder) !== "gone";

// Whether a driver of the cycle at statePath may still run: the lock names that state file and its
// holder is not provably gone, by the watcher's reading or the lock module's. A holder only one of
// them calls dead (a ps that cannot run leaves it "unverified" to the watcher and dead to the lock
// module) still counts. Like an attach (classifyDrive), it guards only the driver of this state file:
// a lock for another cycle in the checkout neither blocks a migration nor means a driver runs here.
export function driverMayRun(root, statePath) {
  const holder = readDriveLockHolder(root);
  return lockNamesState(root, holder, statePath) && (holderRunning(root, holder) || readLiveDriveLock(root) !== null);
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function lockNamesState(root, holder, statePath) {
  return typeof holder?.state === "string" && real(resolve(root, holder.state)) === real(statePath);
}

function stageOf(statePath) {
  try {
    return field(readFileSync(statePath, "utf8"), "stage")?.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

function nextFor(result, stage) {
  if (result.outcome === "complete" || result.outcome === "left-execution") {
    // The cycle was rewound to execution since: that run's end no longer describes it.
    if (stage === "execution") return { next: "none" };
    return { next: result.outcome === "complete" ? "branch-review" : "resume-stage" };
  }
  const key = resumableKey(result);
  if (RESUMABLE.has(key))
    return result.noProgressEnds >= NO_PROGRESS_LIMIT ? { next: "answer-gate", reason: "no-progress" } : { next: "restart" };
  if (result.outcome === "gate-stop") return { next: "answer-gate" };
  // stalled, environment, stopped and budget/max-usd — and an outcome this reader does not know.
  return { next: "answer-gate", reason: key ?? null };
}

export function classifyDrive({ statePath }) {
  const state = resolve(statePath);
  const root = dirname(dirname(state));
  const idle = {
    running: false, pid: null, log: null, outcome: null, reason: null, detail: "", task: null,
    progressed: false, noProgressEnds: 0, next: "none",
  };
  const holder = readDriveLockHolder(root);
  const ours = holder !== null && lockNamesState(root, holder, state);
  if (ours && holderRunning(root, holder)) return { ...idle, running: true, pid: holder.pid, log: holder.log ?? null };
  const result = readDriveResult(root);
  if (!result && !ours) return idle;
  // A driver that died before it wrote its starting result is read as the crash that result records.
  if (!result) {
    const crashed = { ...idle, pid: holder.pid, log: holder.log ?? null, outcome: "crashed", detail: CRASH_DETAIL, noProgressEnds: noProgressEndsAfter(root, { progressed: false }) };
    return { ...crashed, ...nextFor(crashed, stageOf(state)) };
  }
  const ended = {
    ...idle,
    outcome: result.outcome ?? null,
    reason: result.reason ?? null,
    detail: String(result.detail ?? ""),
    task: result.task ?? null,
    progressed: result.progressed === true,
    noProgressEnds: Number(result.noProgressEnds) || 0,
  };
  return { ...ended, ...nextFor(ended, stageOf(state)) };
}
