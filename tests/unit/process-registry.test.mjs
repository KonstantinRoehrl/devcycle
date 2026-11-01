import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { openProcesses, readProcesses, reconcileSnapshot, recordProcess, retireProcess } from "../../scripts/process-registry.mjs";

const RUN = "00000000000000a1";
const T0 = Date.parse("2026-10-30T10:00:00Z");
const ENDED = { endedAt: "2026-10-30T10:01:00Z", endedBy: "finished" };
function dir() {
  const d = join(makeTempDir("process-registry-"), ".devcycle");
  mkdirSync(d);
  return d;
}
const entry = (id, kind, extra = {}) => ({ id, kind, session: "h1", run: RUN, stage: "execution", startedAt: "2026-10-30T10:00:00Z", ...extra });
const openIds = (d, now = T0) => openProcesses(d, { run: RUN, now }).map((e) => e.id);

test("a recorded process reads back whole, once, however often it is recorded", () => {
  const d = dir();
  assert.equal(recordProcess(d, entry("a1", "subagent", { ref: "x" })), true);
  assert.equal(recordProcess(d, entry("a1", "subagent")), false);
  assert.deepEqual(readProcesses(d), [entry("a1", "subagent", { ref: "x" })]);
  assert.equal(readFileSync(join(d, "processes.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("an unknown kind or end reason is refused", () => {
  const d = dir();
  assert.throws(() => recordProcess(d, entry("a1", "daemon")), /process kind/);
  assert.throws(() => retireProcess(d, "a1", { endedAt: "x", endedBy: "magic" }), /ends by/);
});

test("retiring folds into the entry, the first end stands, and an id never recorded stays unrecorded", () => {
  const d = dir();
  recordProcess(d, entry("a1", "subagent"));
  assert.equal(retireProcess(d, "a1", ENDED), true);
  assert.equal(retireProcess(d, "a1", { endedAt: "2026-10-30T10:02:00Z", endedBy: "taskstop" }), false);
  assert.deepEqual(readProcesses(d), [{ ...entry("a1", "subagent"), ...ENDED }]);
  assert.equal(retireProcess(d, "foreground", ENDED), false);
  assert.equal(readProcesses(d).length, 1);
});

test("open leaves out retired entries, other runs and those past their expiry", () => {
  const d = dir();
  recordProcess(d, entry("a1", "subagent"));
  recordProcess(d, entry("a2", "subagent"));
  retireProcess(d, "a2", ENDED);
  recordProcess(d, entry("a3", "subagent", { run: "00000000000000b2" }));
  recordProcess(d, entry("m1", "monitor", { expiresAt: "2026-10-30T10:05:00Z" }));
  assert.deepEqual(openIds(d), ["a1", "m1"]);
  assert.deepEqual(openIds(d, Date.parse("2026-10-30T10:05:00Z")), ["a1"]);
});

test("a snapshot retires this session's shells and subagents it no longer lists, and never a Monitor", () => {
  const d = dir();
  recordProcess(d, entry("s1", "shell"));
  recordProcess(d, entry("a1", "subagent"));
  recordProcess(d, entry("m1", "monitor"));
  recordProcess(d, entry("s2", "shell", { session: "h2" }));
  recordProcess(d, entry("s3", "shell", { run: "00000000000000b2" }));
  const snapshot = { session: "h1", run: RUN, now: T0 };
  assert.deepEqual(reconcileSnapshot(d, { ...snapshot, tasks: [{ id: "a1", type: "subagent", status: "running" }] }), ["s1"]);
  assert.deepEqual(reconcileSnapshot(d, { ...snapshot, tasks: [{ id: "a1", type: "subagent", status: "running" }] }), [], "idempotent");
  assert.equal(readProcesses(d).find((e) => e.id === "s1").endedBy, "absent");
  assert.deepEqual(readProcesses(d).filter((e) => !e.endedAt).map((e) => e.id), ["a1", "m1", "s2", "s3"]);
});
