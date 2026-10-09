// scripts/drive-lock.mjs: the driver's claim on a checkout. Each test locks a throwaway directory;
// a "live" holder is this test process itself, alive for the whole test.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { DRIVE_LOCK_REL, acquireDriveLock, driveTokenHash, readLiveDriveLock, releaseDriveLock } from "../../scripts/drive-lock.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";

const DRIVE_LOCK_MODULE = new URL("../../scripts/drive-lock.mjs", import.meta.url).href;
const paths = (dir) => ({ statePath: join(dir, ".devcycle", "state.md"), logPath: join(dir, ".devcycle", "drive.log") });
const lockFile = (dir) => join(dir, DRIVE_LOCK_REL);
function writeLock(dir, holder, path = lockFile(dir)) {
  mkdirSync(join(dir, ".devcycle"), { recursive: true });
  writeFileSync(path, typeof holder === "string" ? holder : JSON.stringify(holder));
}
// The pid of a process that has already exited.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const EPOCH = "Thu Jan  1 00:00:00 1970";
const staleHolder = () => ({ pid: deadPid(), startTime: EPOCH, hostname: hostname(), state: "s", log: "l" });

test("acquire writes the holder, readLiveDriveLock returns it, release removes it", () => {
  const dir = makeTempDir("drive-lock-");
  const { statePath, logPath } = paths(dir);
  const r = acquireDriveLock(dir, { statePath, logPath });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lock, { pid: process.pid, startTime: processStartTime(process.pid), hostname: hostname(), state: statePath, log: logPath, tokenHash: null });
  assert.deepEqual(readLiveDriveLock(dir), r.lock);
  assert.deepEqual(readdirSync(join(dir, ".devcycle")), ["drive.lock"], "the temp file the lock was linked from is gone");
  releaseDriveLock(dir, r.lock);
  assert.equal(existsSync(lockFile(dir)), false);
  assert.equal(readLiveDriveLock(dir), null);
});

test("the lock keeps only the hash of the driver's session token", () => {
  const dir = makeTempDir("drive-lock-");
  const r = acquireDriveLock(dir, { ...paths(dir), tokenHash: driveTokenHash("s3cret") });
  assert.equal(driveTokenHash("s3cret"), createHash("sha256").update("s3cret").digest("hex"));
  assert.equal(readLiveDriveLock(dir).tokenHash, driveTokenHash("s3cret"));
  assert.ok(!JSON.stringify(readLiveDriveLock(dir)).includes("s3cret"));
  releaseDriveLock(dir, r.lock);
});

test("a second acquire while a live holder holds the lock fails and names the holder", () => {
  const dir = makeTempDir("drive-lock-");
  const first = acquireDriveLock(dir, paths(dir));
  const second = acquireDriveLock(dir, paths(dir));
  assert.deepEqual(second, { ok: false, holder: first.lock });
  releaseDriveLock(dir, first.lock);
});

test("a holder whose process is gone is stale: not live, and reclaimed", () => {
  const dir = makeTempDir("drive-lock-");
  writeLock(dir, staleHolder());
  assert.equal(readLiveDriveLock(dir), null);
  const r = acquireDriveLock(dir, paths(dir));
  assert.equal(r.ok, true);
  assert.equal(readLiveDriveLock(dir).pid, process.pid);
  assert.deepEqual(readdirSync(join(dir, ".devcycle")), ["drive.lock"], "the reclaim left its mutex behind");
  releaseDriveLock(dir, r.lock);
});

test("a reused pid with another start time is stale", () => {
  const dir = makeTempDir("drive-lock-");
  writeLock(dir, { pid: process.pid, startTime: EPOCH, hostname: hostname(), state: "s", log: "l" });
  assert.equal(readLiveDriveLock(dir), null);
  const r = acquireDriveLock(dir, paths(dir));
  assert.equal(r.ok, true);
  assert.equal(r.lock.startTime, processStartTime(process.pid));
  releaseDriveLock(dir, r.lock);
});

test("an unreadable lock file is stale; another host's lock counts as live", () => {
  const torn = makeTempDir("drive-lock-");
  writeLock(torn, "{\"pid\":");
  assert.equal(readLiveDriveLock(torn), null);
  const r = acquireDriveLock(torn, paths(torn));
  assert.equal(r.ok, true);
  releaseDriveLock(torn, r.lock);

  const remote = makeTempDir("drive-lock-");
  const holder = { pid: deadPid(), startTime: EPOCH, hostname: "elsewhere.invalid", state: "s", log: "l" };
  writeLock(remote, holder);
  assert.deepEqual(readLiveDriveLock(remote), holder);
  assert.deepEqual(acquireDriveLock(remote, paths(remote)), { ok: false, holder });
});

test("release leaves a lock it does not own", () => {
  const dir = makeTempDir("drive-lock-");
  const r = acquireDriveLock(dir, paths(dir));
  releaseDriveLock(dir, { pid: process.pid, startTime: EPOCH });
  assert.equal(existsSync(lockFile(dir)), true);
  releaseDriveLock(dir, r.lock);
  assert.equal(existsSync(lockFile(dir)), false);
});

test("a reclaim mutex its dead owner left behind fails closed, naming both files, and takes no lock", () => {
  const dir = makeTempDir("drive-lock-");
  writeLock(dir, staleHolder());
  writeLock(dir, { pid: deadPid(), startTime: EPOCH, hostname: hostname() }, `${lockFile(dir)}.reclaim`);
  assert.throws(() => acquireDriveLock(dir, paths(dir)), /a starter died while reclaiming .*drive\.lock; if no driver runs, remove .*drive\.lock\.reclaim/);
  assert.equal(readLiveDriveLock(dir), null);
});

// Spec § 6 "Second driver … exit 3" must hold when the previous driver died hard and two starters
// race for its stale lock: each starter is a separate process, released by one stdin write so they
// call acquireDriveLock together, and kept alive until every answer is in, so a lock taken in a
// round stays live for the rest of it.
test("starters racing for a stale lock: exactly one takes it, every round", async () => {
  const starter = (dir) => `
    import { acquireDriveLock } from ${JSON.stringify(DRIVE_LOCK_MODULE)};
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => {
      const r = acquireDriveLock(${JSON.stringify(dir)}, { statePath: "s", logPath: "l" });
      process.stdout.write((r.ok ? "ok" : "held") + "\\n");
    });
    process.stdin.on("end", () => process.exit(0));`;
  const lines = (child, count) => new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.split("\n").length > count) resolve(out.split("\n").slice(0, count));
    });
    child.on("exit", () => resolve(out.split("\n").slice(0, count)));
  });
  for (let round = 0; round < 40; round++) {
    const dir = makeTempDir("drive-lock-race-");
    writeLock(dir, staleHolder());
    const children = [1, 2, 3, 4].map(() =>
      spawn(process.execPath, ["--input-type=module", "-e", starter(dir)], { stdio: ["pipe", "pipe", "inherit"] }));
    const answers = children.map((child) => lines(child, 2));
    await Promise.all(children.map((child) => new Promise((resolve) => child.stdout.once("data", resolve))));
    for (const child of children) child.stdin.write("go\n");
    const results = (await Promise.all(answers)).map((l) => l[1]);
    for (const child of children) child.stdin.end();
    await Promise.all(children.map((child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on("exit", resolve)))));
    assert.equal(results.filter((r) => r === "ok").length, 1, `round ${round}: ${results.join(", ")}`);
    assert.equal(results.filter((r) => r === "held").length, 3, `round ${round}: ${results.join(", ")}`);
  }
});
