import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { startProcess, readRecord } from "../../scripts/on-device-launch.mjs";
import { recordProcess, retireProcess } from "../../scripts/process-registry.mjs";
import { gitToplevel, hashSession, recordPath } from "../../scripts/run-record.mjs";
import { logStep } from "../../scripts/stage-log.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { finalizeStop, listCandidates, requestStop, resumeStopped, waitForQuiet } from "../../scripts/stop-cycle.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

process.env.DEVCYCLE_RUNS_DIR = makeTempDir("stop-cycle-runs-");
const SCRIPT = join(process.cwd(), "scripts/stop-cycle.mjs");
const RUN = "0123456789abcdef";
const ME = "session-me";
const OTHER = "session-other";
const ENV = { CLAUDE_CODE_SESSION_ID: ME };
const OLD = "2026-10-30T09:00:00Z";

function cycle({ stage = "planning", run = RUN, root: recordedRoot } = {}) {
  const root = realpathSync(makeTempDir("stop-cycle-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".devcycle"));
  const state = join(root, ".devcycle/state.md");
  writeFileSync(state, [
    "# devcycle state", `- root: ${recordedRoot ?? root}`, "- request: add a thing", "- branch: feat/thing", `- stage: ${stage}`,
    `- run: ${run}`, "- knobs: profile=standard handoffNotification=both", `- updated: ${OLD}`, "",
  ].join("\n"));
  return { root, state, dir: join(root, ".devcycle") };
}
const joinRun = (root, ...sessions) => {
  const path = recordPath(gitToplevel(root), RUN);
  mkdirSync(join(path, ".."), { recursive: true });
  for (const id of sessions) appendFileSync(path, `${JSON.stringify({ kind: "session", sessionHash: hashSession(id) })}\n`);
};
const open = (dir, id, kind, session = ME) =>
  recordProcess(dir, { id, kind, session: hashSession(session), run: RUN, stage: "planning", startedAt: OLD });
// A clock that only sleep moves, so the ten-second quiet wait costs no real time.
const fakeTime = (startMs = Date.now()) => {
  const clock = { ms: startMs };
  return { now: () => clock.ms, sleep: async (ms) => { clock.ms += ms; }, clock };
};
// A normal implementer dispatch: its ledger line and the record scripts/task-dispatch.mjs writes, which
// names the dispatching session and, once bound, the agent.
function dispatched(dir, task, { session = OTHER, agentId, role = "implementer", ...rest } = {}) {
  const key = role === "implementer" ? `${task}/dispatched/1/0` : `${task}/review-round/1/0`;
  appendFileSync(join(dir, "ledger.md"), `- [${OLD}] task=${task} event=${role === "implementer" ? "dispatched" : "review-round"} outcome=ok ref=none key=${key}\n`);
  mkdirSync(join(dir, "dispatch"), { recursive: true });
  const [, , round, retry] = key.split("/");
  writeFileSync(join(dir, "dispatch", `${task}-${role}-${round}-${retry}.json`), JSON.stringify({ startedAt: OLD, sessionId: session, ...(agentId ? { agentId } : {}), ...rest }));
}
const writeLock = (root, fields) =>
  writeFileSync(join(root, ".devcycle/drive.lock"), JSON.stringify({ hostname: hostname(), state: ".devcycle/state.md", log: ".devcycle/drive.log", ...fields }));

test("list names each open cycle with what the stop command shows, leaves out a closed one and flags a foreign one", () => {
  const { root, state } = cycle();
  const nested = join(root, "packages/app/.devcycle");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "state.md"), "- request: old\n- stage: done\n");
  assert.deepEqual(listCandidates({ cwd: root }), {
    candidates: [{ state, request: "add a thing", branch: "feat/thing", stage: "planning", foreign: false }],
  });
  const foreign = cycle({ root: "/somewhere/else" });
  assert.equal(listCandidates({ state: foreign.state }).candidates[0].foreign, true);
});

test("request records who joined, reports what each session owns, and refuses a foreign state file", async () => {
  const { root, state, dir } = cycle();
  joinRun(root, ME, OTHER);
  open(dir, "aself", "subagent");
  open(dir, "bself", "shell");
  open(dir, "aother", "subagent", OTHER);
  const result = await requestStop({ state, env: ENV, ...fakeTime() });
  assert.equal(result.requested, true);
  assert.deepEqual(result.driver, { exit: 3, detail: "no driver was running" });
  assert.deepEqual(result.onDevice, { stopped: 0, alreadyGone: 0, skipped: [] });
  assert.deepEqual(result.owned, [{ id: "aself", kind: "subagent" }, { id: "bself", kind: "shell" }]);
  assert.deepEqual(result.otherSessions, [{ id: "aother", kind: "subagent", session: hashSession(OTHER) }]);
  const request = JSON.parse(readFileSync(join(dir, "stop-request"), "utf8"));
  assert.match(request.requestedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(request.requestedBy, hashSession(ME));
  assert.equal(request.run, RUN);
  assert.deepEqual(request.sessions, [hashSession(ME), hashSession(OTHER)]);

  const foreign = cycle({ root: "/somewhere/else" });
  const refused = await requestStop({ state: foreign.state, env: ENV, ...fakeTime() });
  assert.equal(refused.requested, false);
  assert.match(refused.reason, /another checkout/);
  assert.equal(existsSync(join(foreign.dir, "stop-request")), false, "a foreign cycle got a stop request");
});

test("request lists a foreground subagent another session dispatched, which no registry entry covers", async () => {
  const { root, state, dir } = cycle({ stage: "execution" });
  joinRun(root, ME, OTHER);
  dispatched(dir, "3", { agentId: "afg" });
  dispatched(dir, "4", { role: "reviewer" });
  dispatched(dir, "5", { agentId: "astopped", stopped: OLD });
  dispatched(dir, "6", { agentId: "aended", endedAt: OLD });
  open(dir, "acovered", "subagent");
  dispatched(dir, "7", { session: ME, agentId: "acovered" });
  dispatched(dir, "8", { session: ME });
  const result = await requestStop({ state, env: ENV, ...fakeTime() });
  assert.deepEqual(result.owned.map(({ id }) => id), ["acovered", "task 8 implementer"]);
  assert.deepEqual(result.otherSessions.map(({ id, kind, session }) => [id, kind, session]), [
    ["task 3 implementer (agent afg)", "subagent", hashSession(OTHER)],
    ["task 4 reviewer", "subagent", hashSession(OTHER)],
  ]);
});

test("finalize reports an in-flight foreground subagent in left by task, role and agent, never one already stopped or ended", async () => {
  const { root, state, dir } = cycle({ stage: "execution" });
  joinRun(root, ME, OTHER);
  dispatched(dir, "3", { agentId: "afg" });
  dispatched(dir, "4", { role: "reviewer" });
  dispatched(dir, "5", { agentId: "astopped", stopped: OLD });
  dispatched(dir, "6", { agentId: "aended", endedAt: OLD });
  open(dir, "acovered", "subagent");
  dispatched(dir, "7", { session: ME, agentId: "acovered" });
  dispatched(dir, "8", { session: ME });
  await requestStop({ state, env: ENV, ...fakeTime() });
  const { left, record } = await finalizeStop({ state, env: ENV, mark: () => {}, ...fakeTime() });
  const reason = Object.fromEntries(left.map((e) => [e.id, e.reason]));
  assert.deepEqual(Object.keys(reason).sort(), ["acovered", "task 3 implementer (agent afg)", "task 4 reviewer", "task 8 implementer"]);
  assert.match(reason["task 3 implementer (agent afg)"], /next tool call is denied, so it ends then, and one inside a long tool call runs until that call returns/);
  assert.match(reason["task 4 reviewer"], /next tool call is denied/);
  assert.match(reason["task 8 implementer"], /stop it here with \/tasks/);
  assert.deepEqual(left.filter(({ id }) => id.startsWith("task ")).map((e) => e.kind), ["subagent", "subagent", "subagent"]);
  assert.deepEqual(record.left, left);
});

test("request signals a live driver and waits for its lock to clear before it returns", async () => {
  const { root, state } = cycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const signalled = [];
  const { now, sleep } = fakeTime();
  let polls = 0;
  const result = await requestStop({
    state, env: ENV, now,
    kill: (pid, signal) => signalled.push([pid, signal]),
    sleep: async (ms) => {
      await sleep(ms);
      if (++polls === 3) execFileSync("rm", [join(root, ".devcycle/drive.lock")]);
    },
  });
  assert.deepEqual(signalled, [[process.pid, "SIGTERM"]]);
  assert.equal(polls, 3, "request returned before the driver's lock cleared");
  assert.deepEqual(result.driver, { exit: 0, detail: `stopped the driver (pid ${process.pid})` });
});

test("request bounds the wait for a driver that never exits, and reports it", async () => {
  const { root, state } = cycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const time = fakeTime();
  const started = time.now();
  const result = await requestStop({ state, env: ENV, kill: () => {}, now: time.now, sleep: time.sleep });
  assert.equal(time.now() - started, 15_000);
  assert.match(result.driver.detail, /had not exited after 15 s/);
});

test("a driver that refuses the signal is reported with its manual advice and no machine path", async () => {
  const { root, state } = cycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const refuse = () => { throw Object.assign(new Error("no"), { code: "EPERM" }); };
  const result = await requestStop({ state, env: ENV, kill: refuse, ...fakeTime() });
  assert.equal(result.driver.exit, 1);
  assert.match(result.driver.detail, new RegExp(`^could not signal the driver \\(pid ${process.pid}: EPERM\\).*kill ${process.pid}`));
  assert.ok(!result.driver.detail.includes(root), "the detail carries a machine path");
});

test("request stops the launched on-device app and reports a broken launch record instead of failing", async () => {
  const { root, state } = cycle();
  startProcess({ cmd: "sleep 30", dir: root });
  const { pid } = readRecord(root).processes[0];
  const result = await requestStop({ state, env: ENV, ...fakeTime() });
  assert.equal(result.onDevice.stopped, 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

  const broken = cycle();
  writeFileSync(join(broken.dir, "on-device-launch.json"), "{}");
  const again = await requestStop({ state: broken.state, env: ENV, ...fakeTime() });
  assert.equal(again.requested, true);
  assert.match(again.onDevice.error, /no processes list/);
});

test("an unreadable or corrupt launch record reaches the report and the record with no machine path or record content", async () => {
  const unreadable = cycle();
  // A directory in the record's place fails the read whoever runs the suite, where a file mode would not under root.
  mkdirSync(join(unreadable.dir, "on-device-launch.json"));
  const corrupt = cycle();
  const secret = "launch-record-content";
  writeFileSync(join(corrupt.dir, "on-device-launch.json"), `{"${secret}": `);
  for (const [{ root, state, dir }, expected] of [
    [unreadable, "could not read the launch record (EISDIR)"],
    [corrupt, "could not read the launch record (it is not valid JSON)"],
  ]) {
    const { onDevice } = await requestStop({ state, env: ENV, ...fakeTime() });
    assert.equal(onDevice.error, expected);
    await finalizeStop({ state, env: ENV, ...fakeTime() });
    const record = readFileSync(join(dir, "stop.json"), "utf8");
    assert.ok(JSON.parse(record).left.some(({ reason }) => reason === expected), "the record does not report the failed read");
    assert.ok(!record.includes(root), "the record carries a machine path");
    assert.ok(!record.includes(secret), "the record carries the launch record's content");
  }
});

test("a launch record the file mode denies keeps its full path out of the report and the record", {
  skip: process.getuid?.() === 0 ? "runs as root, where mode 0 does not deny access" : false,
}, async () => {
  const { root, state, dir } = cycle();
  writeFileSync(join(dir, "on-device-launch.json"), "{}");
  chmodSync(join(dir, "on-device-launch.json"), 0o000);
  const { onDevice } = await requestStop({ state, env: ENV, ...fakeTime() });
  assert.equal(onDevice.error, "could not read the launch record (EACCES)");
  await finalizeStop({ state, env: ENV, ...fakeTime() });
  assert.ok(!readFileSync(join(dir, "stop.json"), "utf8").includes(root), "the record carries a machine path");
});

test("a repeated request keeps the first stop's time, sessions and results", async () => {
  const { root, state, dir } = cycle();
  joinRun(root, ME);
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const time = fakeTime();
  const kill = () => execFileSync("rm", [join(root, ".devcycle/drive.lock")]);
  await requestStop({ state, env: ENV, kill, ...time });
  const first = JSON.parse(readFileSync(join(dir, "stop-request"), "utf8"));
  joinRun(root, OTHER);
  const second = await requestStop({ state, env: ENV, ...time });
  const after = JSON.parse(readFileSync(join(dir, "stop-request"), "utf8"));
  assert.equal(after.requestedAt, first.requestedAt);
  assert.deepEqual(after.sessions, [hashSession(ME), hashSession(OTHER)]);
  assert.equal(second.driver.exit, 0, "the repeat erased the driver the first run stopped");
});

test("waitForQuiet ends ten seconds after the last denial and never past sixty seconds from the request", async () => {
  const { dir } = cycle();
  const ack = join(dir, "stop-ack");
  const start = Date.parse(OLD);
  const quiet = fakeTime(start);
  await waitForQuiet(dir, OLD, quiet);
  assert.equal(quiet.now() - start, 10_000);

  const denied = fakeTime(start);
  let polls = 0;
  await waitForQuiet(dir, OLD, {
    now: denied.now,
    sleep: async (ms) => {
      await denied.sleep(ms);
      if (++polls <= 4) appendFileSync(ack, "denied\n");
    },
  });
  assert.equal(denied.now() - start, 2_000 + 10_000);

  const endless = fakeTime(start);
  await waitForQuiet(dir, OLD, {
    now: endless.now,
    sleep: async (ms) => {
      await endless.sleep(ms);
      appendFileSync(ack, "denied\n");
    },
  });
  assert.equal(endless.now() - start, 60_000);
});

test("finalize writes the record, adds the row, marks the handoff ready and deletes the request, every other row intact", async () => {
  const { root, state, dir } = cycle({ stage: "brainstorm" });
  joinRun(root, ME);
  writeFileSync(join(root, "draft.md"), "work in progress\n");
  logStep(dir, { run: RUN, stage: "brainstorm", key: "question-batch-1" });
  await requestStop({ state, env: ENV, ...fakeTime() });
  const before = readFileSync(state, "utf8");
  const result = await finalizeStop({ state, env: ENV, mark: () => assert.fail("nothing was TaskStop-ed"), ...fakeTime() });

  assert.equal(result.path, ".devcycle/stop.json");
  const record = JSON.parse(readFileSync(join(dir, "stop.json"), "utf8"));
  assert.deepEqual(result.record, record);
  assert.equal(record.stage, "brainstorm");
  assert.equal(record.run, RUN);
  assert.equal(record.stoppedBy, hashSession(ME));
  assert.deepEqual(record.sessions, [hashSession(ME)]);
  assert.deepEqual(record.position, { done: ["question-batch-1"], last: "question-batch-1", summary: "1 steps logged, the last question-batch-1" });
  assert.deepEqual(record.ledger, {});
  assert.ok(record.uncommitted.includes("draft.md"), "the record does not name the uncommitted file");
  assert.equal(readFileSync(join(root, "draft.md"), "utf8"), "work in progress\n");
  assert.equal(existsSync(join(dir, "stop-request")), false);

  const after = readFileSync(state, "utf8");
  assert.match(after, new RegExp(`^- stopped: ${record.stoppedAt} \\.devcycle/stop\\.json$`, "m"));
  assert.match(after, /^- handoff: ready \S+$/m);
  const dropped = after.split("\n").filter((l) => !/^- (stopped|handoff):/.test(l));
  assert.deepEqual(dropped, before.split("\n"), "finalize changed a row it does not own");
  assert.ok(!JSON.stringify(record).includes(ME), "the record carries a raw session id");
  assert.ok(!JSON.stringify(record).includes(root), "the record carries a machine path");
});

test("finalize reports what was stopped and left, and stamps only this stop's TaskStop-ed subagents", async () => {
  const { root, state, dir } = cycle({ stage: "on-device" });
  joinRun(root, ME, OTHER);
  for (const [id, kind, session] of [["adone", "subagent"], ["aearlier", "subagent"], ["afinished", "subagent", OTHER], ["bshell", "shell"], ["mwatch", "monitor"], ["aother", "subagent", OTHER], ["bother", "shell", OTHER], ["bstuck", "shell"]])
    open(dir, id, kind, session);
  retireProcess(dir, "aearlier", { endedAt: OLD, endedBy: "taskstop" });
  await requestStop({ state, env: ENV, ...fakeTime() });
  const later = new Date(Date.now() + 60_000).toISOString();
  for (const id of ["adone", "bshell", "mwatch"]) retireProcess(dir, id, { endedAt: later, endedBy: "taskstop" });
  retireProcess(dir, "afinished", { endedAt: later, endedBy: "finished" });

  const marked = [];
  const { stopped, left } = await finalizeStop({ state, env: ENV, mark: (args) => marked.push(args), ...fakeTime() });
  assert.deepEqual(marked.map(({ agentId, sessionId }) => [agentId, sessionId]), [["adone", ME]]);

  const how = Object.fromEntries(stopped.map((e) => [e.id, e.how]));
  assert.deepEqual(Object.keys(how).sort(), ["adone", "afinished", "bshell", "mwatch"]);
  assert.equal(how.adone, "stopped with TaskStop");
  assert.equal(how.afinished, "ended after the stop request");
  assert.match(how.mwatch, /may keep running/);

  const reason = Object.fromEntries(left.map((e) => [e.id, e.reason]));
  assert.deepEqual(Object.keys(reason).sort(), ["aother", "bother", "browser tabs", "bstuck"]);
  assert.match(reason.aother, /next tool call is denied/);
  assert.match(reason.bother, /only that session can stop it, with \/tasks/);
  assert.match(reason.bstuck, /stop it here with \/tasks/);
  assert.match(reason["browser tabs"], /close them yourself/);
});

test("finalize in execution records each task's last ledger event and names the plan's tasks not yet committed", async () => {
  const { root, state, dir } = cycle({ stage: "execution" });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/plan.md"), "# Plan\n\n### Task 1: a\n\n### Task 2: b\n\n### Task 3: c\n");
  appendFileSync(state, "- plan: docs/plan.md\n");
  writeFileSync(join(dir, "ledger.md"), [
    "# ledger", "Plan: `docs/plan.md`", `Run: \`${RUN}\``,
    "- [2026-10-30T09:00:00Z] task=1 event=dispatched outcome=ok ref=none key=1",
    "- [2026-10-30T09:01:00Z] task=1 event=committed outcome=green ref=none key=2",
    "- [2026-10-30T09:02:00Z] task=2 event=dispatched outcome=ok ref=none key=3",
    "- [2026-10-30T09:03:00Z] task=branch event=review-round outcome=ok ref=none key=4",
    "- [2026-10-30T09:04:00Z] task=drive event=user-decision outcome=ok ref=none key=5",
    "",
  ].join("\n"));
  await requestStop({ state, env: ENV, ...fakeTime() });
  const { record } = await finalizeStop({ state, env: ENV, ...fakeTime() });
  assert.deepEqual(record.ledger, { 1: "committed", 2: "dispatched", branch: "review-round", drive: "user-decision" });
  assert.equal(record.position.summary, "1 of 3 plan tasks committed; next: 2 (dispatched), 3 (not started)");
});

test("a ledger from another plan slot does not count toward the position", async () => {
  const { root, state, dir } = cycle({ stage: "execution" });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs/plan.md"), "### Task 1: a\n");
  appendFileSync(state, "- plan: docs/plan.md\n");
  writeFileSync(join(dir, "ledger.md"), [
    "# ledger", "Plan: `docs/older-plan.md`", "- [2026-10-30T09:01:00Z] task=1 event=committed outcome=green ref=none key=2", "",
  ].join("\n"));
  await requestStop({ state, env: ENV, ...fakeTime() });
  const { record } = await finalizeStop({ state, env: ENV, ...fakeTime() });
  assert.equal(record.position.summary, "0 of 1 plan tasks committed; next: 1 (not started)");
});

test("finalize in branch-review reports the lens result files on disk in the highest round and whether the refutation exists", async () => {
  const { state, dir } = cycle({ stage: "branch-review" });
  for (const [round, file] of [["round-1", "old.json"], ["round-2", "conventions.json"], ["round-2", "spec-compliance.md"], ["round-2", "_args.json"], ["round-10", "conventions.json"]]) {
    mkdirSync(join(dir, "review", round), { recursive: true });
    writeFileSync(join(dir, "review", round, file), "{}");
  }
  await requestStop({ state, env: ENV, ...fakeTime() });
  assert.equal((await finalizeStop({ state, env: ENV, ...fakeTime() })).record.position.summary, "round 10: 1 lens result file on disk, no refutation results");

  rmSync(join(dir, "review/round-10"), { recursive: true });
  writeFileSync(join(dir, "review/round-2/_refutation.json"), "{}");
  rmSync(join(dir, "stop.json"));
  await requestStop({ state, env: ENV, ...fakeTime() });
  assert.equal((await finalizeStop({ state, env: ENV, ...fakeTime() })).record.position.summary, "round 2: 2 lens result files on disk, refutation results present");
});

test("a stop record left by another run is filed under stop-history and not merged into this stop", async () => {
  const { state, dir } = cycle();
  writeFileSync(join(dir, "stop.json"), JSON.stringify({
    stage: "planning", stoppedAt: OLD, stoppedBy: "someone-else", run: "ffffffffffffffff",
    stopped: [{ id: "old", kind: "shell", how: "stopped with TaskStop" }], left: [{ id: "oldapp", kind: "app", reason: "left alone" }],
  }));
  await requestStop({ state, env: ENV, ...fakeTime() });
  const { record, stopped, left } = await finalizeStop({ state, env: ENV, ...fakeTime() });
  assert.notEqual(record.stoppedAt, OLD);
  assert.equal(record.stoppedBy, hashSession(ME));
  assert.equal(record.run, RUN);
  assert.ok(!stopped.some(({ id }) => id === "old") && !left.some(({ id }) => id === "oldapp"), "the other run's results were inherited");
  assert.match(readFileSync(state, "utf8"), new RegExp(`^- stopped: ${record.stoppedAt} `, "m"));
  const filed = JSON.parse(readFileSync(join(dir, "stop-history", `${OLD.replaceAll(":", "-")}.json`), "utf8"));
  assert.equal(filed.run, "ffffffffffffffff");
  assert.equal(filed.stoppedBy, "someone-else");
});

test("a second finalize leaves one record, and one with no request and no record says so", async () => {
  const { state, dir } = cycle();
  await requestStop({ state, env: ENV, ...fakeTime() });
  const first = await finalizeStop({ state, env: ENV, ...fakeTime() });
  const time = fakeTime();
  const started = time.now();
  const second = await finalizeStop({ state, env: ENV, ...time });
  assert.deepEqual(second.record, first.record);
  assert.equal(time.now(), started, "a finished stop waited again");
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("stop.json")), ["stop.json"]);
  assert.equal(readFileSync(state, "utf8").split("\n").filter((l) => l.startsWith("- stopped:")).length, 1);

  const none = await finalizeStop({ state: cycle().state, env: ENV, ...fakeTime() });
  assert.equal(none.record, null);
  assert.match(none.reason, /no stop was requested/);
});

test("stopping an already stopped cycle again keeps the first time and adds to what was stopped", async () => {
  const { state, dir } = cycle();
  const t = new Date(Date.now() + 60_000).toISOString();
  open(dir, "aone", "subagent");
  await requestStop({ state, env: ENV, ...fakeTime() });
  retireProcess(dir, "aone", { endedAt: t, endedBy: "taskstop" });
  const first = await finalizeStop({ state, env: ENV, mark: () => {}, ...fakeTime() });
  open(dir, "atwo", "subagent");
  await requestStop({ state, env: ENV, ...fakeTime() });
  retireProcess(dir, "atwo", { endedAt: t, endedBy: "taskstop" });
  const second = await finalizeStop({ state, env: ENV, mark: () => {}, ...fakeTime() });
  assert.equal(second.record.stoppedAt, first.record.stoppedAt);
  assert.deepEqual(second.stopped.map(({ id }) => id).sort(), ["aone", "atwo"]);
});

test("resume drops the row and files the record under stop-history, every other row intact; a repeat changes nothing", async () => {
  const { state, dir } = cycle();
  await requestStop({ state, env: ENV, ...fakeTime() });
  const { record } = await finalizeStop({ state, env: ENV, ...fakeTime() });
  const stoppedText = readFileSync(state, "utf8");
  const result = resumeStopped({ state });
  assert.deepEqual(result, { resumed: true, record });
  assert.equal(readFileSync(state, "utf8"), stoppedText.replace(/^- stopped:.*\n/m, ""));
  assert.equal(existsSync(join(dir, "stop.json")), false);
  assert.deepEqual(readdirSync(join(dir, "stop-history")), [`${record.stoppedAt.replaceAll(":", "-")}.json`]);
  assert.deepEqual(resumeStopped({ state }), { resumed: false, record: null });
});

test("resume clears a request a dead finalize left behind", () => {
  const { state, dir } = cycle();
  appendFileSync(state, `- stopped: ${OLD} .devcycle/stop.json\n`);
  writeFileSync(join(dir, "stop-request"), JSON.stringify({ requestedAt: new Date().toISOString(), sessions: [hashSession(ME)] }));
  assert.equal(resumeStopped({ state }).resumed, true);
  assert.equal(existsSync(join(dir, "stop-request")), false);

  // Finalize can also die between writing the record and writing the row.
  const noRow = cycle();
  writeFileSync(join(noRow.dir, "stop.json"), JSON.stringify({ stoppedAt: OLD }));
  writeFileSync(join(noRow.dir, "stop-request"), JSON.stringify({ requestedAt: new Date().toISOString(), sessions: [hashSession(ME)] }));
  assert.equal(resumeStopped({ state: noRow.state }).resumed, true);
  assert.equal(existsSync(join(noRow.dir, "stop-request")), false, "the record's request kept denying the session");
});

test("the CLI prints exactly one JSON object for each subcommand, driven by the session id in its environment", () => {
  const { root, state, dir } = cycle();
  joinRun(root, ME);
  open(dir, "aself", "subagent");
  const { DEVCYCLE_DRIVE_TOKEN, ...rest } = process.env;
  const env = { ...rest, ...ENV };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(cli("list").candidates[0].stage, "planning");
  assert.deepEqual(cli("request", "--state", state).owned, [{ id: "aself", kind: "subagent" }]);
  // Past the sixty-second cap, so the CLI's real clock has nothing to wait for.
  const request = JSON.parse(readFileSync(join(dir, "stop-request"), "utf8"));
  writeFileSync(join(dir, "stop-request"), JSON.stringify({ ...request, requestedAt: OLD }));
  assert.equal(cli("finalize", "--state", state).path, ".devcycle/stop.json");
  assert.equal(cli("resume", "--state", state).resumed, true);
  const bad = spawnSync(process.execPath, [SCRIPT, "request"], { cwd: root, env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^stop-cycle: request needs --state/m);
});
