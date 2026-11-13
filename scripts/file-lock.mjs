// One owner for cross-process mutual exclusion on a file. atomicWrite (scripts/atomic-write.mjs)
// makes a single write atomic, but two concurrent read-check-append cycles on the ledger or a run
// record still interleave and can lose or duplicate a line; holding `<file>.lock` across the whole
// cycle closes that. The lock records its holder's pid and process start time, so a lock left by a
// killed process — or by a dead pid the OS has since reused — is recognised as stale and reclaimed.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sleepSync } from "./sleep.mjs";

// `lstart` is printed in the caller's timezone and locale, so it is pinned: a lock written from one
// terminal is compared by a process started from another.
function runPs(pid) {
  const env = { ...process.env, LC_ALL: "C", TZ: "UTC" };
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env });
}

const startTimeFrom = (ps) => (ps.status === 0 && ps.stdout.trim()) || null;

const WINDOWS = process.platform === "win32";
// .NET counts 100 ns ticks from 0001-01-01; the Unix epoch is this many of them.
const UNIX_EPOCH_TICKS = 621355968000000000n;
// Warm, a read takes ~300 ms; a first PowerShell start on a busy or scanned machine (a CI runner with ten
// test processes starting at once) can take more than three seconds, and a timed-out read of the driver's
// own start time stops it from taking its lock at all. Only a hung PowerShell ever waits this long.
const POWERSHELL_TIMEOUT_MS = 15000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The shape `ps -o lstart=` prints under LC_ALL=C TZ=UTC, so a lock written on Windows reads like a
// POSIX one to every `Date.parse(\`${startTime} UTC\`)`.
export function lstartFromTicks(ticks) {
  const d = new Date(Number((BigInt(ticks) - UNIX_EPOCH_TICKS) / 10000n));
  const two = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

// Windows PowerShell 5.1 by absolute path, so a PATH entry cannot stand in for it; DEVCYCLE_POWERSHELL
// replaces it for tests.
const powershell = () =>
  process.env.DEVCYCLE_POWERSHELL ||
  (process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe");

// Judged by stdout alone: PowerShell's exit code for a missing pid depends on how the expression is
// written, and its error text is localized. Nothing on stdout — no such pid, another user's process,
// a PowerShell that cannot run or timed out — is null.
function readWindowsStart(pid) {
  if (!Number.isInteger(pid)) return null;
  const command = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().Ticks }`;
  const r = spawnSync(powershell(), ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS });
  const ticks = (r.stdout ?? "").trim();
  return /^\d+$/.test(ticks) ? lstartFromTicks(ticks) : null;
}

// A process's own start never changes, and each PowerShell read costs ~300 ms.
let ownStart = null;

export function processStartTime(pid) {
  if (!WINDOWS) return startTimeFrom(runPs(pid));
  if (pid !== process.pid) return readWindowsStart(pid);
  return (ownStart ??= readWindowsStart(pid));
}

// `ps` derives a start time from the boot time, which a clock step moves, so one process can read a
// second or two apart between two calls; a pid reused by a later process starts further off than that.
const START_TOLERANCE_MS = 2000;
const startedAt = (lstart) => Date.parse(`${lstart} UTC`);

export function startedAsRecorded(started, recorded) {
  if (recorded === null) return true;
  return started === recorded || Math.abs(startedAt(started) - startedAt(recorded)) <= START_TOLERANCE_MS;
}

// kill(pid, 0) sends nothing: ESRCH says the pid is gone, EPERM that it exists under another user.
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Windows asks two questions: whether the pid exists, which needs no PowerShell, and whether it is
// still the process that wrote the lock. A start time that cannot be read cannot say no, so live.
function isLiveWindowsHolder(holder) {
  if (!pidExists(holder.pid)) return false;
  const started = processStartTime(holder.pid);
  return started === null || startedAsRecorded(started, holder.startTime);
}

// A `ps` that could not run says nothing about the holder, and a wrong "dead" takes a live lock, so
// it reads as alive. So does a live pid whose holder could not record its own start time.
export function isLiveHolder(holder) {
  if (WINDOWS) return isLiveWindowsHolder(holder);
  const ps = runPs(holder.pid);
  if (ps.error) return true;
  const started = startTimeFrom(ps);
  if (started === null) return false;
  return startedAsRecorded(started, holder.startTime);
}

// A timed-out wait, told apart from any error the locked function throws, and from another lock's
// timeout, by the lock path it carries.
export class LockTimeoutError extends Error {
  constructor(lockPath) {
    super(`file-lock: timed out waiting for ${lockPath}`);
    this.lockPath = lockPath;
  }
}

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

// Windows refuses to create a file that another process has pending delete with EPERM (or a
// transient EBUSY/EACCES) rather than EEXIST, so there those codes mean the file is still held.
const WINDOWS_HELD_CODES = new Set(["EEXIST", "EPERM", "EBUSY", "EACCES"]);
const heldByAnother = (err) => (WINDOWS ? WINDOWS_HELD_CODES.has(err.code) : err.code === "EEXIST");

// Removes a dead holder's lock, one reclaimer at a time. A dead holder cannot release, so under the
// guard its file stays put once it has been read again after the judgement; a different file by then
// means the holder released and another process took the lock. A crash inside the guard leaves it
// behind, which is why an old one is cleared; that needs a crash first, and is accepted.
function reclaimIfStale(lockPath, timeoutMs) {
  const guard = `${lockPath}.reclaim`;
  try {
    closeSync(openSync(guard, "wx"));
  } catch (err) {
    if (!heldByAnother(err)) throw err;
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
  // A Windows start-time read is a PowerShell launch (~300 ms, seconds on a loaded machine); it is
  // cached, so taking it before the lock keeps it out of the time every waiter spends blocked.
  if (WINDOWS) processStartTime(process.pid);
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (!heldByAnother(err)) throw err;
    }
    if (reclaimIfStale(lockPath, timeoutMs)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
    sleepSync(pollMs);
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
