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
function runPs(pid) {
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env });
}

const startTimeFrom = (ps) => (ps.status === 0 && ps.stdout.trim()) || null;

export function processStartTime(pid) {
  return startTimeFrom(runPs(pid));
}

// `ps` derives a start time from the boot time, which a clock step moves, so one process can read a
// second or two apart between two calls; a pid reused by a later process starts further off than that.
const START_TOLERANCE_MS = 2000;
const startedAt = (lstart) => Date.parse(`${lstart} UTC`);

// A `ps` that could not run says nothing about the holder, and a wrong "dead" takes a live lock, so
// it reads as alive. So does a live pid whose holder could not record its own start time.
export function isLiveHolder(holder) {
  const ps = runPs(holder.pid);
  if (ps.error) return true;
  const started = startTimeFrom(ps);
  if (started === null) return false;
  if (holder.startTime === null) return true;
  const gap = Math.abs(startedAt(started) - startedAt(holder.startTime));
  return started === holder.startTime || gap <= START_TOLERANCE_MS;
}

// A timed-out wait, told apart from any error the locked function throws, and from another lock's
// timeout, by the lock path it carries.
export class LockTimeoutError extends Error {
  constructor(lockPath) {
    super(`file-lock: timed out waiting for ${lockPath}`);
    this.lockPath = lockPath;
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const unlinkIfPresent = (path) => {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
};

const ageMs = (path) => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

// A lock that does not parse is a holder caught between creating the file and writing it; it is
// waited on like a live one, unless it is older than the whole timeout — then its writer died in
// that gap and nothing else will ever remove it.
function isStale(lockPath, lockText, timeoutMs) {
  try {
    return !isLiveHolder(JSON.parse(lockText));
  } catch {
    return ageMs(lockPath) > timeoutMs;
  }
}

const readLock = (lockPath) => {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
};

// Removes a dead holder's lock, one reclaimer at a time. A dead holder cannot release, so under the
// guard its file stays put once it has been read again after the judgement; a different file by then
// means the holder released and another process took the lock. A crash inside the guard leaves it
// behind, which is why an old one is cleared; that needs a crash first, and is accepted.
function reclaimIfStale(lockPath, timeoutMs) {
  const guard = `${lockPath}.reclaim`;
  try {
    closeSync(openSync(guard, "wx"));
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    if (ageMs(guard) > timeoutMs) unlinkIfPresent(guard);
    return false;
  }
  try {
    const lockText = readLock(lockPath);
    if (lockText === null || !isStale(lockPath, lockText, timeoutMs) || readLock(lockPath) !== lockText) return false;
    unlinkIfPresent(lockPath);
    return true;
  } finally {
    unlinkIfPresent(guard);
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
    if (reclaimIfStale(lockPath, timeoutMs)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
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
