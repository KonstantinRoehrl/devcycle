import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { processStartTime, isLiveHolder, withFileLock } from "../../scripts/file-lock.mjs";

const LOCK_MODULE = new URL("../../scripts/file-lock.mjs", import.meta.url).href;
const ATOMIC_MODULE = new URL("../../scripts/atomic-write.mjs", import.meta.url).href;

// A pid that was alive a moment ago and is not now: the shape a killed lock holder leaves behind.
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

test("processStartTime: a live pid has a start time, a finished one has none", () => {
  assert.match(processStartTime(process.pid) ?? "", /\d{4}/);
  assert.equal(processStartTime(deadPid()), null);
});

test("processStartTime: one process reads the same start time whatever the caller's timezone and locale", () => {
  const probe = `import { processStartTime } from ${JSON.stringify(LOCK_MODULE)};
    process.stdout.write(processStartTime(${process.pid}) ?? "");`;
  const env = { ...process.env, TZ: "Pacific/Kiritimati", LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" };
  const other = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
  assert.equal(other.stdout, processStartTime(process.pid));
});

test("isLiveHolder: the same pid with a different start time is a reused pid, not the holder", () => {
  assert.equal(isLiveHolder({ pid: process.pid, startTime: processStartTime(process.pid) }), true);
  assert.equal(isLiveHolder({ pid: process.pid, startTime: "Mon Jan  1 00:00:00 1990" }), false);
  assert.equal(isLiveHolder({ pid: deadPid(), startTime: "Mon Jan  1 00:00:00 1990" }), false);
});

// `ps -o lstart` derives a start time from the boot time, which a clock step shifts; a reading a
// second or two off is still the same process, a larger gap is another one.
test("isLiveHolder: a start time within two seconds of the recorded one is the same process", () => {
  const lstart = (ms) => {
    const [day, date, mon, year, time] = new Date(ms).toUTCString().replace(",", "").split(" ").filter(Boolean);
    return `${day} ${mon} ${String(Number(date)).padStart(2)} ${time} ${year}`;
  };
  const started = Date.parse(`${processStartTime(process.pid)} UTC`);
  assert.equal(lstart(started), processStartTime(process.pid), "the test's lstart format drifted from ps's");
  assert.equal(isLiveHolder({ pid: process.pid, startTime: lstart(started + 1000) }), true);
  assert.equal(isLiveHolder({ pid: process.pid, startTime: lstart(started - 2000) }), true);
  assert.equal(isLiveHolder({ pid: process.pid, startTime: lstart(started + 5000) }), false);
  assert.equal(isLiveHolder({ pid: process.pid, startTime: "not a date" }), false);
});

test("withFileLock: holds <target>.lock naming this process while fn runs, returns fn's value, removes it after", () => {
  const target = join(makeTempDir("file-lock-"), "ledger.md");
  const seen = withFileLock(target, () => JSON.parse(readFileSync(`${target}.lock`, "utf8")));
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.startTime, processStartTime(process.pid));
  assert.equal(typeof seen.hostname, "string");
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withFileLock: a throwing fn still releases the lock and the error propagates", () => {
  const target = join(makeTempDir("file-lock-"), "ledger.md");
  assert.throws(() => withFileLock(target, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withFileLock: a lock left by a dead process is reclaimed", () => {
  const target = join(makeTempDir("file-lock-"), "ledger.md");
  writeFileSync(`${target}.lock`, JSON.stringify({ pid: deadPid(), startTime: "Mon Jan  1 00:00:00 1990", hostname: "h" }));
  assert.equal(withFileLock(target, () => "ran", { timeoutMs: 500 }), "ran");
  assert.equal(existsSync(`${target}.lock`), false);
});

test("withFileLock: a live holder is waited on until the timeout, then refused", () => {
  const target = join(makeTempDir("file-lock-"), "ledger.md");
  const live = { pid: process.pid, startTime: processStartTime(process.pid), hostname: "h" };
  writeFileSync(`${target}.lock`, JSON.stringify(live));
  assert.throws(() => withFileLock(target, () => "ran", { timeoutMs: 150, pollMs: 10 }),
    /^Error: file-lock: timed out waiting for .*ledger\.md\.lock$/);
  assert.deepEqual(JSON.parse(readFileSync(`${target}.lock`, "utf8")), live, "a live holder's lock is never removed");
});

test("withFileLock: concurrent read-modify-write cycles in separate processes lose no line", async () => {
  const target = join(makeTempDir("file-lock-"), "ledger.md");
  writeFileSync(target, "");
  const worker = (id) => `
    import { readFileSync } from "node:fs";
    import { withFileLock } from ${JSON.stringify(LOCK_MODULE)};
    import { atomicWrite } from ${JSON.stringify(ATOMIC_MODULE)};
    for (let i = 0; i < 25; i++)
      withFileLock(${JSON.stringify(target)}, () =>
        atomicWrite(${JSON.stringify(target)}, readFileSync(${JSON.stringify(target)}, "utf8") + "w${id} " + i + "\\n"));`;
  await Promise.all([1, 2, 3, 4].map((id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker(id)], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${id} exited ${code}`))));
  })));
  const lines = readFileSync(target, "utf8").trim().split("\n");
  assert.equal(lines.length, 100);
  assert.equal(new Set(lines).size, 100);
});
