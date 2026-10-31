import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { logStep, readStage } from "../../scripts/stage-log.mjs";

const CLI = fileURLToPath(new URL("../../scripts/stage-log.mjs", import.meta.url));
const RUN = "00000000000000a1";
const STAGE = { run: RUN, stage: "scoping" };
function cycle(state = `# devcycle state\n- stage: scoping\n- run: ${RUN}\n`) {
  const dir = join(makeTempDir("stage-log-"), ".devcycle");
  mkdirSync(dir);
  writeFileSync(join(dir, "state.md"), state);
  return dir;
}
const logFile = (dir) => join(dir, "stage-log", `${RUN}.jsonl`);
const lines = (dir) => readFileSync(logFile(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: JSON.parse(r.stdout) };
}

test("a step lands as one line carrying its stage, key, stamp, data and ref", () => {
  const dir = cycle();
  const { appended } = logStep(dir, { ...STAGE, key: "research-map", ref: ".devcycle/research.md", data: { files: 3 }, now: "2026-10-30T10:00:00Z" });
  assert.equal(appended, true);
  assert.deepEqual(lines(dir), [{ stage: "scoping", key: "research-map", at: "2026-10-30T10:00:00Z", data: { files: 3 }, ref: ".devcycle/research.md" }]);
});

test("the same step logged again appends nothing, and new content appends and wins", () => {
  const dir = cycle();
  logStep(dir, { ...STAGE, key: "interview-batch-1", data: { a: 1 } });
  assert.equal(logStep(dir, { ...STAGE, key: "interview-batch-1", data: { a: 1 } }).appended, false);
  assert.equal(lines(dir).length, 1);
  assert.equal(logStep(dir, { ...STAGE, key: "interview-batch-1", data: { a: 2 } }).appended, true);
  assert.equal(lines(dir).length, 2);
  assert.deepEqual(readStage(dir, STAGE).map((l) => l.data), [{ a: 2 }]);
});

test("a read returns the latest line per key for its stage only, latest last", () => {
  const dir = cycle();
  logStep(dir, { ...STAGE, key: "one", data: 1 });
  logStep(dir, { ...STAGE, key: "two", data: 2 });
  logStep(dir, { ...STAGE, key: "one", data: 3 });
  logStep(dir, { run: RUN, stage: "planning", key: "one", data: 9 });
  assert.deepEqual(readStage(dir, STAGE).map((l) => [l.key, l.data]), [["two", 2], ["one", 3]]);
  assert.deepEqual(readStage(dir, { run: RUN, stage: "brainstorm" }), []);
});

test("a run with no log reads as empty, and another run's log is never read", () => {
  const dir = cycle();
  logStep(dir, { ...STAGE, key: "one" });
  assert.deepEqual(readStage(dir, { run: "00000000000000b2", stage: "scoping" }), []);
});

test("a torn last line costs nothing but itself", () => {
  const dir = cycle();
  logStep(dir, { ...STAGE, key: "one" });
  appendFileSync(logFile(dir), '{"stage":"scoping","key":"to');
  logStep(dir, { ...STAGE, key: "two" });
  assert.deepEqual(readStage(dir, STAGE).map((l) => l.key), ["one", "two"]);
});

test("a bad run, stage or key, or a machine path as ref, is refused before anything is written", () => {
  const dir = cycle();
  for (const bad of [{ ...STAGE, run: "../x" }, { ...STAGE, stage: "a/b" }, { ...STAGE, key: "a b" }, { ...STAGE, key: "../x" }])
    assert.throws(() => logStep(dir, { key: "k", ...bad }), /run id|--stage|--key/, JSON.stringify(bad));
  assert.throws(() => logStep(dir, { ...STAGE, key: "k", ref: join(sep, "opt", "x", "file") }), /--ref must be relative/);
});

test("the CLI logs and reads through the state file's run", () => {
  const dir = cycle();
  const state = join(dir, "state.md");
  const logged = cli("log", "--state", state, "--stage", "scoping", "--key", "scope-written", "--ref", ".devcycle/scope.md", "--data", '{"words":12}');
  assert.equal(logged.code, 0);
  assert.deepEqual(logged.out.appended, ["scope-written"]);
  assert.deepEqual(cli("log", "--state", state, "--stage", "scoping", "--key", "scope-written", "--ref", ".devcycle/scope.md", "--data", '{"words":12}').out.appended, []);
  const read = cli("read", "--state", state, "--stage", "scoping");
  assert.equal(read.code, 0);
  assert.deepEqual(read.out.steps.map((s) => [s.key, s.ref, s.data]), [["scope-written", ".devcycle/scope.md", { words: 12 }]]);
});

test("the CLI separates a usage error (exit 2) from an environment error (exit 3)", () => {
  const dir = cycle();
  const state = join(dir, "state.md");
  assert.equal(cli("log", "--state", state, "--stage", "scoping").code, 2, "no --key");
  assert.equal(cli("log", "--state", state, "--stage", "scoping", "--key", "k", "--data", "{no").code, 2, "bad JSON");
  assert.equal(cli("nonsense").code, 2);
  assert.equal(cli("read", "--state", join(dir, "absent.md"), "--stage", "scoping").code, 3);
  const noRun = cycle("# devcycle state\n- stage: scoping\n- run: none\n");
  assert.equal(cli("read", "--state", join(noRun, "state.md"), "--stage", "scoping").code, 3);
});
