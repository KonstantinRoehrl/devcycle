// The unattended-execution driver's claim on a checkout (spec 4.B.5): .devcycle/drive.lock beside
// the state file names the driver process, the state file it drives, its log and the hash of the
// token it hands its sessions, and the machine, boot and pid namespace it runs in. `toplevel` is
// that checkout's root, the directory holding the state file's .devcycle/. One driver holds it at a
// time; a holder whose process is gone, or whose pid now belongs to a process started at another
// time, is stale and reclaimed. /devcycle:continue (through
// wave-setup.mjs) and the git guard only ask whether a live driver holds it.
import { linkSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { hostname, uptime } from "node:os";
import { spawnSync } from "node:child_process";
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

// macOS renames a host with the network it joins, so a lock a crash left before a reboot can name
// another host than this machine now does. The lock also names the machine by an id that survives
// that — systemd's machine-id, or the Mac's platform UUID — kept only as a hash like the token.
function readMachineId() {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const id = readRaw(path)?.trim();
    if (id) return id;
  }
  if (process.platform !== "darwin") return null;
  const ioreg = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
  return ioreg.stdout?.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? null;
}

// The kernel instance: each boot draws a new one, so a clone of this machine running beside it, with
// the same machine id, has another.
function readBootId() {
  if (process.platform !== "darwin") return readRaw("/proc/sys/kernel/random/boot_id")?.trim() || null;
  return spawnSync("sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" }).stdout?.trim() || null;
}

// Linux only: containers on one kernel share its boot id, and those from one image its machine id,
// but a pid names a process only inside its own pid namespace.
function readPidNamespace() {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return null;
  }
}

// Linux only: when a process started, in clock ticks since boot (proc(5), field 22). `ps` derives its
// start time from the wall clock, so a clock step moves that; nothing moves this.
function startTicks(pid) {
  const stat = readRaw(`/proc/${pid}/stat`);
  // Field 2, the command name, is parenthesised and may itself hold spaces and parentheses.
  return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
}

const hashed = (id) => (id ? createHash("sha256").update(id).digest("hex") : null);
const once = (read) => {
  let value;
  return () => (value === undefined ? (value = read()) : value);
};
const machineId = once(() => hashed(readMachineId()));
const bootId = once(() => hashed(readBootId()));
const pidNamespace = once(readPidNamespace);

const ownIdentity = (startTime) => ({
  pid: process.pid, startTime, hostname: hostname(),
  machine: machineId(), boot: bootId(), pidns: pidNamespace(), ticks: startTicks(process.pid),
});

// The machine id decides when both sides have one; a lock written without it falls back to the
// hostname.
const onThisMachine = (holder) =>
  typeof holder.machine === "string" && machineId() ? holder.machine === machineId() : holder.hostname === hostname();

const startedBeforeThisBoot = (holder) => Date.parse(`${holder.startTime} UTC`) < Date.now() - uptime() * 1000;

// A process this one cannot ask about — on another machine, in another pid namespace, or under
// another boot of this machine id while this boot ran — counts as live: reclaiming its lock is the
// user's call, never a guess. A process that started before this boot cannot have outlived it.
function isLive(holder) {
  if (holder === null) return false;
  if (!onThisMachine(holder)) return true;
  if (typeof holder.boot === "string" && holder.boot !== bootId()) return !startedBeforeThisBoot(holder);
  if (typeof holder.pidns === "string" && holder.pidns !== pidNamespace()) return true;
  if (typeof holder.ticks === "string") return startTicks(holder.pid) === holder.ticks;
  return isLiveHolder(holder);
}

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
  if (!publish(mutex, JSON.stringify(ownIdentity(self.startTime)) + "\n")) {
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
  const lock = { ...ownIdentity(startTime), state: statePath, log: logPath, tokenHash };
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
