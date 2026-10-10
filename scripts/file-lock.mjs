// One owner for cross-process mutual exclusion on a file. atomicWrite (scripts/atomic-write.mjs)
// makes a single write atomic, but two concurrent read-check-append cycles on the ledger or a run
// record still interleave and can lose or duplicate a line; holding `<file>.lock` across the whole
// cycle closes that. The lock records its holder's pid and process start time, so a lock left by a
// killed process — or by a dead pid the OS has since reused — is recognised as stale and reclaimed.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";

// `lstart` is printed in the caller's timezone and locale, so it is pinned: a lock written from one
// terminal is compared by a process started from another.
export function processStartTime(pid) {
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env });
  const started = ps.status === 0 ? ps.stdout.trim() : "";
  return started || null;
}

// `ps` derives a start time from the boot time, which a clock step moves, so one process can read a
// second or two apart between two calls; a pid reused by a later process starts further off than that.
const START_TOLERANCE_MS = 2000;
const startedAt = (lstart) => Date.parse(`${lstart} UTC`);

export function isLiveHolder(holder) {
  const started = processStartTime(holder.pid);
  if (started === null) return false;
  const gap = Math.abs(startedAt(started) - startedAt(holder.startTime));
  return started === holder.startTime || gap <= START_TOLERANCE_MS;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readHolder(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

const unlinkIfPresent = (path) => {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
};

// A lock that does not parse is a holder caught between creating the file and writing it; it is
// waited on like a live one, unless it is older than the whole timeout — then its writer died in
// that gap and nothing else will ever remove it.
function isStale(lockPath, timeoutMs) {
  const holder = readHolder(lockPath);
  if (holder) return !isLiveHolder(holder);
  try {
    return Date.now() - statSync(lockPath).mtimeMs > timeoutMs;
  } catch {
    return false;
  }
}

export function withFileLock(target, fn, { timeoutMs = 10000, pollMs = 25 } = {}) {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    // Two waiters that both judged the same dead holder stale can race here, the slower one
    // unlinking the faster one's fresh lock; that needs a crash first, and is accepted.
    if (isStale(lockPath, timeoutMs)) {
      unlinkIfPresent(lockPath);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`file-lock: timed out waiting for ${lockPath}`);
    sleep(pollMs);
  }
  try {
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), hostname: hostname() }));
    } finally {
      closeSync(fd);
    }
    return fn();
  } finally {
    unlinkIfPresent(lockPath);
  }
}
