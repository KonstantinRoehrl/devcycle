import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DRIVE_LOCK_REL } from "../../scripts/drive-lock.mjs";
import { RESULT_REL } from "../../scripts/drive-result.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { createRelay, follow, LOG_TAIL_LINES, reportedLine, statusReport, waitForEnd, WATCH_LEVELS } from "../../scripts/drive-watch.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";

const WATCH = fileURLToPath(new URL("../../scripts/drive-watch.mjs", import.meta.url));
const DRIVER = fileURLToPath(new URL("../../scripts/drive-execution.mjs", import.meta.url));
const STAMP = "[drive 2026-10-13T00:00:00Z] ";
const RESULT = { code: 0, outcome: "complete", reason: null, task: null, detail: "", startedAt: "2026-10-13T00:00:00Z",
  endedAt: "2026-10-13T01:00:00Z", progressed: true, noProgressEnds: 0 };

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const bytes = (text) => Buffer.byteLength(text);

function makeCycle(stage = "execution") {
  const root = makeRepo();
  const statePath = writeInto(root, ".devcycle/state.md", `# devcycle state\n- stage: ${stage}\n- run: 0123456789abcdef\n`);
  const logPath = writeInto(root, ".devcycle/drive.log", "");
  return { root, statePath, logPath };
}

const setStage = (c, stage) => writeFileSync(c.statePath, `# devcycle state\n- stage: ${stage}\n- run: 0123456789abcdef\n`);
const writeLock = (root, fields) =>
  writeInto(root, DRIVE_LOCK_REL, JSON.stringify({ hostname: hostname(), state: ".devcycle/state.md", log: ".devcycle/drive.log", ...fields }));
const liveLock = (root) => writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
const releaseLock = (root) => rmSync(join(root, DRIVE_LOCK_REL), { force: true });
const writeResult = (root, fields = {}) => writeInto(root, RESULT_REL, JSON.stringify({ ...RESULT, ...fields }));

function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for drive-watch");
    await pause(20);
  }
}

test("reportedLine reports session starts, task outcomes, wave ends, waits, stops and driver errors, and nothing else", () => {
  const reported = [
    "session 1 starts — wave 1, model claude-sonnet-5-5",
    "session 1 · 12 tool calls · task=1 event=committed outcome=ok",
    "session 1 · 14 tool calls · task=2 event=review-verdict outcome=approved",
    "session 2 · 3 tool calls · task=drive event=user-decision outcome=keep going",
    "session 2 · 5 tool calls · task=3 event=intake outcome=rejected (intake bounce)",
    "wave 1 of 3 complete",
    "wait: usage limit until its reset — resuming at 2026-10-13T05:01:00.000Z",
    "wait: transient failure (api-error), attempt 2 — resuming at 2026-10-13T05:03:00.000Z",
    "wait: silent session — resuming at 2026-10-13T05:05:00.000Z",
    "stopped for you — needs-user: which branch?",
  ];
  for (const message of reported) assert.equal(reportedLine(STAMP + message), message);
  const raw = "drive-execution: the plan docs/plan.md cannot be read";
  assert.equal(reportedLine(raw), raw);
  const quiet = [
    "session 1 · 2 tool calls · task=1 event=dispatched outcome=ok",
    "session 1 · 4 tool calls · task=1 event=review-round outcome=1",
    "session 1 · 6 tool calls · task=1 event=report-received outcome=ok",
    "session 1 ended — handoff; ledger +2, commits +1, $0.25",
    "execution is complete — the branch is ready for branch review",
  ];
  for (const message of quiet) assert.equal(reportedLine(STAMP + message), null, message);
  assert.equal(reportedLine("node:internal/process: some raw stderr"), null);
  assert.equal(reportedLine(""), null);
});

test("reportedLine relays by level: end only the driver's errors, wave the run's milestones, all each task's outcomes too", () => {
  const error = "drive-execution: the plan docs/plan.md cannot be read";
  const milestones = [
    "session 2 starts — wave 1, model claude-sonnet-5-5, effort high",
    "wave 1 of 3 complete",
    "wait: silent session — resuming at 2026-10-13T05:05:00.000Z",
    "stopped for you — needs-user: which branch?",
  ];
  const outcomes = [
    "session 1 · 12 tool calls · task=1 event=committed outcome=green gate passed",
    "session 1 · 14 tool calls · task=2 event=review-verdict outcome=rejected",
    "session 2 · 3 tool calls · task=drive event=user-decision outcome=keep going",
    "session 2 · 5 tool calls · task=3 event=report-received outcome=rejected (intake bounce)",
  ];
  assert.deepEqual(WATCH_LEVELS, ["end", "wave", "all"]);
  for (const level of WATCH_LEVELS) assert.equal(reportedLine(error, level), error, level);
  for (const message of [...milestones, ...outcomes]) assert.equal(reportedLine(STAMP + message, "end"), null, message);
  for (const message of milestones) assert.equal(reportedLine(STAMP + message, "wave"), message);
  for (const message of outcomes) assert.equal(reportedLine(STAMP + message, "wave"), null, message);
  for (const message of [...milestones, ...outcomes]) assert.equal(reportedLine(STAMP + message, "all"), message);
});

test("createRelay at all folds a task's accepted verdict into its commit line, counting the review rounds it saw", () => {
  const relay = createRelay("all");
  const lines = [
    "session 1 · 4 tool calls · task=1 event=review-round outcome=round 1",
    "session 1 · 6 tool calls · task=1 event=review-verdict outcome=rejected",
    "session 1 · 8 tool calls · task=1 event=review-round outcome=round 2",
    "session 1 · 9 tool calls · task=1 event=review-verdict outcome=accepted",
    "session 1 · 9 tool calls · task=2 event=review-round outcome=round 1",
    "session 1 · 10 tool calls · task=2 event=review-verdict outcome=accepted",
    "session 1 · 11 tool calls · task=2 event=committed outcome=green gate passed",
    "session 1 · 12 tool calls · task=1 event=committed outcome=green gate passed",
    "session 2 · 2 tool calls · task=3 event=review-round outcome=round 2",
    "session 2 · 3 tool calls · task=3 event=review-verdict outcome=accepted",
    "session 2 · 4 tool calls · task=3 event=committed outcome=green gate passed",
    "session 2 · 5 tool calls · task=4 event=report-received outcome=rejected (intake bounce)",
    "session 2 · 6 tool calls · task=drive event=user-decision outcome=keep going",
  ];
  assert.deepEqual(lines.map((message) => relay.push(STAMP + message)), [
    null,
    "session 1 · 6 tool calls · task=1 event=review-verdict outcome=rejected",
    null,
    null,
    null,
    null,
    "task 2 committed (1 review round)",
    "task 1 committed (2 review rounds)",
    null,
    null,
    "task 3 committed",
    "session 2 · 5 tool calls · task=4 event=report-received outcome=rejected (intake bounce)",
    "session 2 · 6 tool calls · task=drive event=user-decision outcome=keep going",
  ]);
  for (const level of ["end", "wave"]) {
    const filtered = createRelay(level);
    assert.deepEqual(lines.map((message) => filtered.push(STAMP + message)), lines.map(() => null), level);
  }
  assert.throws(() => createRelay("loud"), /unknown watch level "loud": expected one of end, wave, all/);
});

test("createRelay prints a wait: line only when it differs from the last one it printed", () => {
  const usage = "wait: usage limit until its reset — resuming at 2026-10-13T05:01:00.000Z";
  const transient = "wait: transient failure (api-error), attempt 2 — resuming at 2026-10-13T05:03:00.000Z";
  const start = "session 3 starts — wave 2, model m";
  for (const level of ["wave", "all"]) {
    const relay = createRelay(level);
    const printed = [usage, usage, start, usage, transient, usage].map((message) => relay.push(STAMP + message));
    assert.deepEqual(printed, [usage, null, start, null, transient, usage], level);
  }
  assert.equal(createRelay("end").push(STAMP + usage), null);
});

test("statusReport is the classifier's verdict plus the log's last LOG_TAIL_LINES lines", () => {
  const c = makeCycle("branch-review");
  writeResult(c.root);
  const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, i) => `${STAMP}line ${i}`);
  writeFileSync(c.logPath, lines.join("\n") + "\n");
  const report = statusReport({ statePath: c.statePath });
  assert.equal(report.running, false);
  assert.equal(report.outcome, "complete");
  assert.equal(report.next, "branch-review");
  assert.deepEqual(report.logTail, lines.slice(-LOG_TAIL_LINES));
  rmSync(c.logPath);
  assert.deepEqual(statusReport({ statePath: c.statePath }).logTail, [], "a missing log is an empty tail, not an error");
});

test("follow writes each reported line with the byte offset it ends at, holds back a partial line, and ends with the verdict", async () => {
  const c = makeCycle();
  const before = `${STAMP}session 0 starts — wave 1, model m\n`;
  writeFileSync(c.logPath, before);
  liveLock(c.root);
  const out = [];
  const following = follow({ statePath: c.statePath, pollMs: 20, write: (s) => out.push(s) });
  const lines = [
    `${STAMP}session 1 starts — wave 1, model claude-sonnet-5-5\n`,
    `${STAMP}session 1 · 2 tool calls · task=1 event=dispatched outcome=ok\n`,
    `${STAMP}session 1 · 9 tool calls · task=1 event=committed outcome=ok\n`,
  ];
  for (const l of lines) {
    appendFileSync(c.logPath, l);
    await pause(40);
  }
  appendFileSync(c.logPath, `${STAMP}wave 1 of 2 com`);
  await pause(80);
  assert.ok(!out.some((s) => s.startsWith("wave 1")), "a line was reported before its newline arrived");
  appendFileSync(c.logPath, "plete\n");
  await pause(40);
  setStage(c, "branch-review");
  writeResult(c.root);
  releaseLock(c.root);
  await following;
  const ends = [];
  let offset = bytes(before);
  for (const l of [...lines, `${STAMP}wave 1 of 2 complete\n`]) ends.push((offset += bytes(l)));
  assert.deepEqual(out, [
    `session 1 starts — wave 1, model claude-sonnet-5-5 @${ends[0]}\n`,
    `task 1 committed @${ends[2]}\n`,
    `wave 1 of 2 complete @${ends[3]}\n`,
    "drive ended: complete — none → next: branch-review\n",
  ]);
});

test("follow --since resumes after the last reported line without loss or repeat, and restarts at 0 on a shorter log", async () => {
  const c = makeCycle("branch-review");
  writeResult(c.root);
  writeFileSync(c.logPath, [
    `${STAMP}session 1 starts — wave 1, model m`,
    `${STAMP}session 1 · 9 tool calls · task=1 event=committed outcome=ok`,
    `${STAMP}wave 1 of 1 complete`,
  ].join("\n") + "\n");
  const run = async (since) => {
    const out = [];
    await follow({ statePath: c.statePath, since, pollMs: 20, write: (s) => out.push(s) });
    return out;
  };
  const all = await run(0);
  assert.equal(all.length, 4, all.join(""));
  const resumeAt = Number(all[0].match(/ @(\d+)\n$/)[1]);
  assert.deepEqual(await run(resumeAt), all.slice(1));
  assert.deepEqual(await run(bytes(all.join("")) * 10), all, "a log shorter than --since was not read from 0");
});

test("follow relays at the level it is given, every printed line keeping its @offset tail", async () => {
  const c = makeCycle("branch-review");
  writeResult(c.root);
  const lines = [
    `${STAMP}session 1 starts — wave 1, model m`,
    `${STAMP}session 1 · 4 tool calls · task=1 event=review-round outcome=round 1`,
    `${STAMP}session 1 · 6 tool calls · task=1 event=review-verdict outcome=accepted`,
    `${STAMP}session 1 · 9 tool calls · task=1 event=committed outcome=green gate passed`,
    `${STAMP}wave 1 of 1 complete`,
    "drive-execution: the plan docs/plan.md cannot be read",
  ];
  writeFileSync(c.logPath, lines.join("\n") + "\n");
  let offset = 0;
  const ends = lines.map((l) => (offset += bytes(l) + 1));
  const run = async (level) => {
    const out = [];
    await follow({ statePath: c.statePath, since: 0, pollMs: 20, level, write: (s) => out.push(s) });
    return out;
  };
  const error = `drive-execution: the plan docs/plan.md cannot be read @${ends[5]}\n`;
  const ended = "drive ended: complete — none → next: branch-review\n";
  assert.deepEqual(await run("end"), [error, ended]);
  assert.deepEqual(await run("wave"), [`session 1 starts — wave 1, model m @${ends[0]}\n`, `wave 1 of 1 complete @${ends[4]}\n`, error, ended]);
  assert.deepEqual(await run("all"), [
    `session 1 starts — wave 1, model m @${ends[0]}\n`,
    `task 1 committed (1 review round) @${ends[3]}\n`,
    `wave 1 of 1 complete @${ends[4]}\n`,
    error,
    ended,
  ]);
  await assert.rejects(run("loud"), /unknown watch level "loud"/);
});

test("follow prints the end line at once when no driver runs, or when the lock names a dead pid", async () => {
  const c = makeCycle();
  const out = [];
  await follow({ statePath: c.statePath, pollMs: 60_000, write: (s) => out.push(s) });
  assert.deepEqual(out, ["drive ended: none — none → next: none\n"]);
  writeLock(c.root, { pid: deadPid(), startTime: "Thu Jan  1 00:00:00 1970" });
  const crashed = [];
  await follow({ statePath: c.statePath, pollMs: 60_000, write: (s) => crashed.push(s) });
  assert.match(crashed.join(""), /^drive ended: crashed — \S+ → next: restart\n$/);
});

test("waitForEnd resolves only once the lock is released or its pid is dead", async () => {
  const c = makeCycle();
  liveLock(c.root);
  let settled = false;
  const waiting = waitForEnd({ statePath: c.statePath, pollMs: 20 }).then((r) => {
    settled = true;
    return r;
  });
  await pause(150);
  assert.equal(settled, false, "waitForEnd returned while the driver's lock was live");
  writeResult(c.root, { code: 4, outcome: "gate-stop", reason: "needs-user", task: "2", detail: "which branch?" });
  releaseLock(c.root);
  const report = await waiting;
  assert.equal(report.running, false);
  assert.equal(report.outcome, "gate-stop");
  assert.equal(report.next, "answer-gate");
  assert.ok(Array.isArray(report.logTail));

  const dead = makeCycle();
  writeLock(dead.root, { pid: deadPid(), startTime: "Thu Jan  1 00:00:00 1970" });
  const crashed = await waitForEnd({ statePath: dead.statePath, pollMs: 20 });
  assert.equal(crashed.outcome, "crashed");
  assert.equal(crashed.next, "restart");
});

const POLL_ENV = { ...process.env, DEVCYCLE_DRIVE_POLL_MS: "20" };
const runSync = (args) => spawnSync(process.execPath, [WATCH, ...args], { env: POLL_ENV, encoding: "utf8" });

test("the CLI refuses a usage error with exit 2", () => {
  const c = makeCycle();
  const bad = [
    [], ["--status"], ["--status", "--wait", "--state", c.statePath], ["--follow", "--since", "-1", "--state", c.statePath],
    ["--status", "--since", "0", "--state", c.statePath], ["--status", "--state", c.statePath, "--bogus"],
    ["--status", "--state", join(c.root, "nowhere", "state.md")], ["--status", "--state"],
    ["--status", "--level", "end", "--state", c.statePath], ["--follow", "--level", "loud", "--state", c.statePath],
    ["--follow", "--level", "--state", c.statePath],
  ];
  for (const args of bad) assert.equal(runSync(args).status, 2, `expected a usage error for ${JSON.stringify(args)}`);
});

test("the CLI's --status and --wait print the report as JSON, and --follow streams until the driver ends", async () => {
  const c = makeCycle();
  for (const mode of ["--status", "--wait"]) {
    const r = runSync([mode, "--state", c.statePath]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\{/, `${mode} printed no JSON`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.running, false);
    assert.equal(report.next, "none");
    assert.deepEqual(report.logTail, []);
  }
  liveLock(c.root);
  const child = spawn(process.execPath, [WATCH, "--follow", "--since", "0", "--state", c.statePath], { env: POLL_ENV });
  try {
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const closed = new Promise((done) => child.on("close", (code) => done(code)));
    appendFileSync(c.logPath, `${STAMP}session 1 starts — wave 1, model m\n`);
    await waitFor(() => out.includes("session 1 starts"));
    releaseLock(c.root);
    assert.equal(await closed, 0);
    assert.match(out, /^session 1 starts — wave 1, model m @\d+\ndrive ended: none — none → next: none\n$/);
  } finally {
    child.kill("SIGKILL");
  }
});

test("the CLI's --follow --level end relays only the end line, and --level wave the session start too", () => {
  const c = makeCycle();
  writeFileSync(c.logPath, `${STAMP}session 1 starts — wave 1, model m\n`);
  const atEnd = runSync(["--follow", "--since", "0", "--level", "end", "--state", c.statePath]);
  assert.equal(atEnd.status, 0, atEnd.stderr);
  assert.equal(atEnd.stdout, "drive ended: none — none → next: none\n");
  const atWave = runSync(["--follow", "--since", "0", "--level", "wave", "--state", c.statePath]);
  assert.equal(atWave.status, 0, atWave.stderr);
  assert.match(atWave.stdout, /^session 1 starts — wave 1, model m @\d+\ndrive ended: none — none → next: none\n$/);
});

test("drive-execution.mjs forwards --status, --wait and --follow to drive-watch, and refuses a misuse with exit 2", () => {
  const root = makeRepo();
  const statePath = writeInto(root, ".devcycle/state.md", "# devcycle state\n- stage: execution\n- run: 0123456789abcdef\n");
  const run = (args) => spawnSync(process.execPath, [DRIVER, ...args], { env: { ...process.env, DEVCYCLE_DRIVE_POLL_MS: "20" }, encoding: "utf8" });
  for (const mode of ["--status", "--wait"]) {
    const r = run([mode, "--state", statePath]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\{/, `${mode} printed no JSON`);
    assert.equal(JSON.parse(r.stdout).next, "none");
  }
  const followed = run(["--follow", "--since", "0", "--state", statePath]);
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(followed.stdout, "drive ended: none — none → next: none\n");
  for (const args of [["--status"], ["--status", "--wait", "--state", statePath], ["--status", "--since", "0", "--state", statePath]])
    assert.equal(run(args).status, 2, `expected a usage error for ${JSON.stringify(args)}`);
});
