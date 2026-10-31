// scripts/drive-result.mjs: the driver's result file and classifyDrive, the one reading of a run's
// state. Each test hand-writes the lock and the result into a throwaway .devcycle/.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { acquireDriveLock, DRIVE_LOCK_REL, readDriveLockHolder } from "../../scripts/drive-lock.mjs";
import {
  classifyDrive, driverMayRun, HANDLED_REL, holderRunning, markResultHandled, noProgressEndsAfter, readDriveResult,
  readHandledResult, RESULT_REL, RESUMABLE, writeCrashedResult, writeDriveResult,
} from "../../scripts/drive-result.mjs";

function cycle(stage = "execution") {
  const root = makeTempDir("drive-result-");
  mkdirSync(join(root, ".devcycle"));
  const statePath = join(root, ".devcycle", "state.md");
  writeFileSync(statePath, `# devcycle state\n- stage: ${stage}\n`);
  return { root, statePath };
}
const writeLock = (root, fields) =>
  writeFileSync(join(root, DRIVE_LOCK_REL), JSON.stringify({ hostname: hostname(), state: ".devcycle/state.md", log: ".devcycle/drive.log", ...fields }));
const live = () => ({ pid: process.pid, startTime: processStartTime(process.pid) });
// A child that has exited and been reaped: its pid names no process.
const dead = () => ({ pid: spawnSync(process.execPath, ["-e", ""]).pid, startTime: processStartTime(process.pid) });
const reused = () => ({ pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970" });
const result = (fields = {}) => ({
  code: 1, outcome: "failed", reason: null, task: null, detail: "", startedAt: "2026-10-13T00:00:00Z",
  endedAt: "2026-10-13T00:05:00Z", progressed: false, noProgressEnds: 1, ...fields,
});
const writeHandled = (root, fields) => writeFileSync(join(root, HANDLED_REL), JSON.stringify(result(fields)));
const classify = (statePath) => classifyDrive({ statePath });

test("readDriveLockHolder returns the lock as written, a dead holder's included, and null for a missing or unparsable lock", () => {
  const { root } = cycle();
  assert.equal(readDriveLockHolder(root), null);
  const holder = dead();
  writeLock(root, holder);
  assert.equal(readDriveLockHolder(root).pid, holder.pid);
  writeFileSync(join(root, DRIVE_LOCK_REL), "{half a lock");
  assert.equal(readDriveLockHolder(root), null);
});

test("writeDriveResult writes atomically, and both readers treat a missing or unparsable file as absent", () => {
  const { root } = cycle();
  assert.equal(readDriveResult(root), null);
  const r = result({ code: 4, outcome: "gate-stop", reason: "needs-user", task: "3", detail: "which file?" });
  writeDriveResult(root, r);
  assert.deepEqual(readDriveResult(root), r);
  assert.deepEqual(readdirSync(join(root, ".devcycle")).sort(), ["drive-result.json", "state.md"], "a temp file was left behind");
  for (const bad of ["{not json", "null", "3"]) {
    writeFileSync(join(root, RESULT_REL), bad);
    assert.equal(readDriveResult(root), null, bad);
    writeFileSync(join(root, HANDLED_REL), bad);
    assert.equal(readHandledResult(root), null, bad);
  }
});

test("markResultHandled renames the result over any earlier handled one and says whether there was one", () => {
  const { root } = cycle();
  assert.equal(markResultHandled(root), false);
  writeDriveResult(root, result({ detail: "first" }));
  assert.equal(markResultHandled(root), true);
  assert.equal(existsSync(join(root, RESULT_REL)), false);
  assert.equal(readHandledResult(root).detail, "first");
  writeDriveResult(root, result({ detail: "second" }));
  assert.equal(markResultHandled(root), true);
  assert.equal(readHandledResult(root).detail, "second");
});

test("noProgressEndsAfter counts consecutive resumable ends without progress, chained through the handled result", () => {
  assert.deepEqual([...RESUMABLE].sort(), ["crashed", "failed", "interrupted", "wait-cap"]);
  const { root } = cycle();
  const after = (progressed = false) => noProgressEndsAfter(root, { progressed, outcome: "interrupted", reason: null });
  assert.equal(after(), 1, "with no handled result");
  writeHandled(root, { outcome: "interrupted", noProgressEnds: 5 });
  assert.equal(after(true), 0, "progress resets the count");
  for (const [fields, expected] of [
    [{ outcome: "interrupted", noProgressEnds: 1 }, 2],
    [{ outcome: "failed", noProgressEnds: 1 }, 2],
    [{ outcome: "crashed", noProgressEnds: 1 }, 2],
    [{ outcome: "budget", reason: "wait-cap", noProgressEnds: 3 }, 4],
    [{ outcome: "budget", reason: "max-usd", noProgressEnds: 3 }, 1],
    [{ outcome: "gate-stop", reason: "needs-user", noProgressEnds: 4 }, 1],
    [{ outcome: "stopped", noProgressEnds: 4 }, 1],
  ]) {
    writeHandled(root, fields);
    assert.equal(after(), expected, JSON.stringify(fields));
  }
});

test("holderRunning: a live holder runs; no holder, a dead pid, a reused pid and a process-group pid do not", () => {
  const { root } = cycle();
  assert.equal(holderRunning(root, live()), true);
  assert.equal(holderRunning(root, null), false);
  assert.equal(holderRunning(root, dead()), false);
  assert.equal(holderRunning(root, reused()), false);
  assert.equal(holderRunning(root, { ...live(), pid: 0 }), false);
});

test("holderRunning: a lock that carries its holder's start in clock ticks is judged by them, so ticks naming another start do not run", () => {
  const { root } = cycle();
  const holder = { ...live(), ticks: "1" };
  writeLock(root, holder);
  assert.equal(holderRunning(root, holder), false);
});

// A PATH with no ps in it stands in for a sandbox that cannot run ps. The hand-written locks carry no
// machine or boot id, so judging them spawns nothing else either.
test("holderRunning: where ps cannot run it trusts a live pid, unless the lock's clock ticks can judge it", () => {
  const { root } = cycle();
  const ticked = { ...live(), ticks: "1" };
  writeLock(root, ticked);
  const path = process.env.PATH;
  process.env.PATH = makeTempDir("drive-result-no-ps-");
  try {
    assert.equal(holderRunning(root, live()), true);
    assert.equal(holderRunning(root, ticked), false);
  } finally {
    process.env.PATH = path;
  }
});

// ps derives a process's start time from the wall clock, so a clock step (a resume from suspend, an
// NTP correction) moves the time it prints; the start in ticks since boot does not move.
test("holderRunning: on Linux a live driver whose ps start time a clock step moved still runs", { skip: process.platform !== "linux" && "only a Linux lock carries /proc start ticks" }, () => {
  const { root, statePath } = cycle();
  const { ok, lock } = acquireDriveLock(root, { statePath: ".devcycle/state.md", logPath: ".devcycle/drive.log" });
  assert.ok(ok && typeof lock.ticks === "string", JSON.stringify(lock));
  const stepped = { ...lock, startTime: "Thu Jan  1 00:00:00 1970" };
  writeFileSync(join(root, DRIVE_LOCK_REL), JSON.stringify(stepped));
  assert.equal(holderRunning(root, stepped), true);
  assert.equal(classify(statePath).running, true);
});

test("classifyDrive: a live lock naming this state file is a running driver, whatever result file is beside it", () => {
  const { root, statePath } = cycle();
  writeDriveResult(root, result({ outcome: "complete", code: 0 }));
  writeLock(root, live());
  assert.deepEqual(classify(statePath), {
    running: true, pid: process.pid, log: ".devcycle/drive.log", outcome: null, reason: null, detail: "", task: null,
    progressed: false, noProgressEnds: 0, next: "none",
  });
});

test("classifyDrive: a lock naming a dead or a reused pid, with no result, is a crash to restart", () => {
  for (const holder of [dead(), reused()]) {
    const { root, statePath } = cycle();
    writeLock(root, holder);
    const c = classify(statePath);
    assert.deepEqual([c.running, c.outcome, c.noProgressEnds, c.next], [false, "crashed", 1, "restart"], JSON.stringify(holder));
  }
  const { root, statePath } = cycle();
  writeLock(root, dead());
  writeDriveResult(root, result({ code: 4, outcome: "gate-stop", reason: "branch" }));
  assert.deepEqual([classify(statePath).outcome, classify(statePath).next], ["gate-stop", "answer-gate"], "a result beside a dead lock decides");
});

test("classifyDrive ignores a lock that names another state file, live or dead", () => {
  const { root, statePath } = cycle();
  mkdirSync(join(root, "sub", ".devcycle"), { recursive: true });
  writeFileSync(join(root, "sub", ".devcycle", "state.md"), "- stage: execution\n");
  writeLock(root, live());
  assert.equal(classify(statePath).running, true, "control: a live lock naming this state runs");
  for (const holder of [live(), dead()]) {
    writeLock(root, { ...holder, state: "sub/.devcycle/state.md" });
    const c = classify(statePath);
    assert.deepEqual([c.running, c.outcome, c.next], [false, null, "none"], JSON.stringify(holder));
  }
});

test("driverMayRun protects a driver of this cycle only: the lock must name this state file, as an attach requires", () => {
  const { root, statePath } = cycle();
  assert.equal(driverMayRun(root, statePath), false, "no lock, no driver");
  writeLock(root, live());
  assert.equal(driverMayRun(root, statePath), true, "a live lock naming this state file");
  writeLock(root, { ...live(), state: "sub/.devcycle/state.md" });
  assert.equal(driverMayRun(root, statePath), false, "a live lock naming another state file");
  writeLock(root, dead());
  assert.equal(driverMayRun(root, statePath), false, "a lock whose holder is gone");
  writeLock(root, { ...live(), state: undefined });
  assert.equal(driverMayRun(root, statePath), false, "a lock naming no state file is no driver of this cycle");
});

test("classifyDrive maps each outcome to its next step, copying the result's reason, task and detail", () => {
  const cases = [
    ["branch-review", { code: 0, outcome: "complete" }, "branch-review", null],
    ["planning", { outcome: "left-execution" }, "resume-stage", null],
    ["execution", { code: 130, outcome: "interrupted" }, "restart", null],
    ["execution", { outcome: "failed" }, "restart", null],
    ["execution", { code: 6, outcome: "budget", reason: "wait-cap" }, "restart", "wait-cap"],
    ["execution", { code: 4, outcome: "gate-stop", reason: "needs-user" }, "answer-gate", "needs-user"],
    ["execution", { code: 5, outcome: "stalled" }, "answer-gate", "stalled"],
    ["execution", { code: 3, outcome: "environment" }, "answer-gate", "environment"],
    ["execution", { code: 6, outcome: "budget", reason: "max-usd" }, "answer-gate", "max-usd"],
    ["execution", { code: 130, outcome: "stopped" }, "answer-gate", "stopped"],
  ];
  for (const [stage, fields, next, reason] of cases) {
    const { root, statePath } = cycle(stage);
    writeDriveResult(root, result({ ...fields, task: "3", detail: "the detail" }));
    const c = classify(statePath);
    assert.deepEqual([c.running, c.outcome, c.next, c.reason, c.task, c.detail], [false, fields.outcome, next, reason, "3", "the detail"], JSON.stringify(fields));
  }
});

test("classifyDrive: complete or left-execution with the state back at execution is a rewind, and reads as none", () => {
  for (const outcome of ["complete", "left-execution"]) {
    const { root, statePath } = cycle("branch-review");
    writeDriveResult(root, result({ outcome }));
    assert.notEqual(classify(statePath).next, "none", `control: ${outcome} at branch-review`);
    writeFileSync(statePath, "# devcycle state\n- stage: execution\n");
    assert.equal(classify(statePath).next, "none", outcome);
  }
});

test("classifyDrive: a second resumable end without progress turns restart into the no-progress question", () => {
  for (const fields of [{ outcome: "interrupted" }, { outcome: "failed" }, { outcome: "budget", reason: "wait-cap" }]) {
    const { root, statePath } = cycle();
    writeDriveResult(root, result({ ...fields, noProgressEnds: 1 }));
    assert.equal(classify(statePath).next, "restart", JSON.stringify(fields));
    writeDriveResult(root, result({ ...fields, noProgressEnds: 2 }));
    const c = classify(statePath);
    assert.deepEqual([c.next, c.reason, c.noProgressEnds], ["answer-gate", "no-progress", 2], JSON.stringify(fields));
  }
  // Chained the way the driver chains it: the previous end, handled, then this one.
  const { root, statePath } = cycle();
  writeHandled(root, { outcome: "interrupted", noProgressEnds: 1 });
  writeDriveResult(root, result({ outcome: "interrupted", noProgressEnds: noProgressEndsAfter(root, { progressed: false, outcome: "interrupted", reason: null }) }));
  assert.deepEqual([classify(statePath).next, classify(statePath).reason], ["answer-gate", "no-progress"]);
});

test("classifyDrive: crashes count toward the no-progress bound, whether the dead driver left its starting result or none", () => {
  const startedAt = "2026-10-13T00:00:00Z";
  const { root, statePath } = cycle();
  writeLock(root, dead());
  writeCrashedResult(root, { startedAt, progressed: false });
  let c = classify(statePath);
  assert.deepEqual([c.outcome, c.noProgressEnds, c.next], ["crashed", 1, "restart"]);
  assert.match(c.detail, /drive\.log/);
  // The restart that crashes in turn: its start hands off the first crash, then writes its own.
  markResultHandled(root);
  writeCrashedResult(root, { startedAt, progressed: false });
  c = classify(statePath);
  assert.deepEqual([c.outcome, c.noProgressEnds, c.next, c.reason], ["crashed", 2, "answer-gate", "no-progress"]);
  writeCrashedResult(root, { startedAt, progressed: true });
  c = classify(statePath);
  assert.deepEqual([c.progressed, c.noProgressEnds, c.next], [true, 0, "restart"], "a crash after progress restarts");
  // A driver that died before it wrote its starting result chains the same way.
  const bare = cycle();
  writeLock(bare.root, dead());
  writeHandled(bare.root, { outcome: "crashed", noProgressEnds: 1 });
  c = classify(bare.statePath);
  assert.deepEqual([c.outcome, c.noProgressEnds, c.next, c.reason], ["crashed", 2, "answer-gate", "no-progress"]);
});

test("classifyDrive: no result, a handled result and an unparsable result all read as none", () => {
  const { root, statePath } = cycle();
  assert.equal(classify(statePath).next, "none");
  writeDriveResult(root, result({ code: 4, outcome: "gate-stop", reason: "needs-user" }));
  assert.equal(classify(statePath).next, "answer-gate", "control: an unhandled stop is a question");
  markResultHandled(root);
  assert.deepEqual([classify(statePath).outcome, classify(statePath).next], [null, "none"]);
  writeFileSync(join(root, RESULT_REL), "{torn");
  assert.deepEqual([classify(statePath).outcome, classify(statePath).next], [null, "none"]);
});
