// The unattended-execution driver's claim on a checkout (spec 4.B.5): .devcycle/drive.lock beside
// the state file names the driver process, the state file it drives, its log and the hash of the
// token it hands its sessions. `toplevel` is that checkout's root, the directory holding the state
// file's .devcycle/. One driver holds it at a time; a holder whose process is gone, or whose pid now
// belongs to a process started at another time, is stale and reclaimed. /devcycle:continue (through
// wave-setup.mjs) and the git guard only ask whether a live driver holds it.
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { isLiveHolder, processStartTime } from "./file-lock.mjs";

export const DRIVE_LOCK_REL = ".devcycle/drive.lock";
const RECLAIM_WAIT_MS = 2000;
const POLL_MS = 10;

const lockPath = (toplevel) => join(toplevel, DRIVE_LOCK_REL);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The lock is readable by anything in the checkout, so it carries only this hash: holding the token
// itself is what proves a session was started by the driver that holds the lock.
export const driveTokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");

function readRaw(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseHolder(raw) {
  try {
    const holder = JSON.parse(raw);
    return Number.isInteger(holder?.pid) && typeof holder.startTime === "string" ? holder : null;
  } catch {
    return null;
  }
}

// Another host's process cannot be asked about, so its lock counts as live: reclaiming it is the
// user's call, never a guess.
const isLive = (holder) => holder !== null && (holder.hostname !== hostname() || isLiveHolder(holder));

// Creates `path` holding `content` only when nothing is there. Linking a complete temp file into
// place is as exclusive as O_EXCL, and the file never exists empty: an empty lock would read as
// unparsable, so as stale, to a starter racing this one.
function publish(path, content) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Removing a stale lock is check-then-act: a starter that judged it stale a moment ago would unlink
// a lock another starter has published since. So one reclaimer at a time, holding
// `drive.lock.reclaim`, re-reads the lock and removes it only while it is still the stale file it
// judged. Returns true when the caller should try to publish again, false while another starter
// holds the reclaim.
function reclaim(path, staleRaw, self) {
  const mutex = `${path}.reclaim`;
  if (!publish(mutex, JSON.stringify({ pid: self.pid, startTime: self.startTime, hostname: self.hostname }) + "\n")) {
    const raw = readRaw(mutex);
    if (raw === null) return true;
    // A reclaimer killed inside these few calls leaves the mutex behind. Clearing it would reopen
    // the race it closes, so this fails closed and names the files instead.
    if (!isLive(parseHolder(raw)))
      throw new Error(`drive-lock: a starter died while reclaiming ${path}; if no driver runs, remove ${mutex} and ${path}`);
    return false;
  }
  try {
    if (readRaw(path) === staleRaw) rmSync(path, { force: true });
  } finally {
    rmSync(mutex, { force: true });
  }
  return true;
}

export function acquireDriveLock(toplevel, { statePath, logPath, tokenHash = null }) {
  const path = lockPath(toplevel);
  const startTime = processStartTime(process.pid);
  if (startTime === null) throw new Error("drive-lock: cannot read this process's start time");
  const lock = { pid: process.pid, startTime, hostname: hostname(), state: statePath, log: logPath, tokenHash };
  const content = JSON.stringify(lock) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + RECLAIM_WAIT_MS;
  for (;;) {
    if (publish(path, content)) return { ok: true, lock };
    const raw = readRaw(path);
    if (raw === null) continue; // released between the link and the read
    const holder = parseHolder(raw);
    if (isLive(holder)) return { ok: false, holder };
    if (reclaim(path, raw, lock)) continue;
    if (Date.now() >= deadline) throw new Error(`drive-lock: another starter has been reclaiming ${path} for ${RECLAIM_WAIT_MS} ms`);
    sleep(POLL_MS);
  }
}

export function releaseDriveLock(toplevel, lock) {
  const path = lockPath(toplevel);
  const holder = parseHolder(readRaw(path));
  if (holder?.pid === lock.pid && holder.startTime === lock.startTime) rmSync(path, { force: true });
}

export function readLiveDriveLock(toplevel) {
  const holder = parseHolder(readRaw(lockPath(toplevel)));
  return isLive(holder) ? holder : null;
}
