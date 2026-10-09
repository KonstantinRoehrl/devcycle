import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { DRIVE_LOCK_REL } from "../../scripts/drive-lock.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { inFlightFiles, SESSION_START_TOKENS } from "../../scripts/drive-execution.mjs";
import { commitAll, makeFakeBin, makeRepo, sh, writeInto } from "./helpers.mjs";

const DRIVER = fileURLToPath(new URL("../../scripts/drive-execution.mjs", import.meta.url));
const STUB_URL = new URL("../fixtures/stub-claude.mjs", import.meta.url).href;
const RUN = "0123456789abcdef";
const MODEL = "claude-sonnet-5-5";
// scripts/drive-signal.mjs's reasons, pinned verbatim: the driver passes each one through untouched.
const STOP_REASONS = ["needs-user", "knob-drift", "foreign-state", "resume-check", "branch", "depth-at-start",
  "sweep-fallback", "scope-change", "no-driver", "not-opted-in"];

const PLAN = [
  "# Fixture plan", "",
  "### Task 1: first", "", "**Files:**", "- Modify: src/a.txt", "",
  "**Dependencies:** none (completely independent)", "",
  "### Task 2: second", "", "**Files:**", "- Modify: src/b.txt", "",
  "**Dependencies:** Tasks 1 committed", "",
  "## Dispatch Map", "",
  "- Wave 1: Task 1 (no dependencies)",
  "- Wave 2: Task 2 (needs Task 1 committed)", "",
].join("\n");

const line = (task, event, ref = "none") => `task=${task} event=${event} outcome=ok ref=${ref}`;
const DONE = [line(1, "committed", "abc1234"), line(2, "committed", "def5678")];

// A git repo on a topic branch holding a two-wave plan, a state file at execution and an empty ledger.
function makeCycle({ branch = "feat/drive", stage = "execution", drive = `- drive: auto model=${MODEL} opted=2026-10-08T00:00:00Z` } = {}) {
  const root = makeRepo();
  if (branch !== "main") sh("git", ["checkout", "-q", "-b", branch], { cwd: root });
  writeInto(root, "src/a.txt", "a\n");
  writeInto(root, "src/b.txt", "b\n");
  writeInto(root, "other.txt", "other\n");
  writeInto(root, "docs/plan.md", PLAN);
  commitAll(root, "chore: fixture");
  writeInto(root, ".devcycle/state.md", [
    "# devcycle state", `- stage: ${stage}`, `- root: ${root}`, `- branch: ${branch} (cut from main at 0000000)`,
    "- request: fixture", "- kind: feature", "- plan: docs/plan.md", "- plan-counts: planned=2 waves=2",
    "- ledger: .devcycle/ledger.md", `- run: ${RUN}`, ...(drive ? [drive] : []), "- updated: 2026-10-08T00:00:00Z", "",
  ].join("\n"));
  writeInto(root, ".devcycle/ledger.md",
    "Plan: `docs/plan.md`\nBranch: `" + branch + "` (cut from `main` at `0000000`)\nProfile: `standard` (evidence tail 40 lines)\n\n");
  return root;
}

// One isolated world per scenario: its own HOME (the sandbox probe writes under ~/.claude), runs dir,
// scenario and call log, and a `claude` on PATH that is the stub. DEVCYCLE_NESTED_RUN and a stale
// DEVCYCLE_DRIVE_TOKEN are set on purpose — the driver must strip the one and replace the other in
// every session it starts. CLAUDECODE, which a suite run inside Claude Code inherits, is dropped:
// only the test that is about it sets it.
const { CLAUDECODE: _claudeCode, ...BASE_ENV } = process.env;
function harness(scenario = [], env = {}) {
  const dir = makeTempDir("devcycle-drive-test-");
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const bin = join(makeFakeBin("claude", `import(${JSON.stringify(STUB_URL)});\n`), "claude");
  return {
    bin,
    runsDir: join(dir, "runs"),
    callsPath: join(dir, "calls.jsonl"),
    env: {
      ...BASE_ENV,
      PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
      HOME: home,
      DEVCYCLE_RUNS_DIR: join(dir, "runs"),
      STUB_CLAUDE_SCENARIO: join(dir, "scenario.json"),
      STUB_CLAUDE_CALLS: join(dir, "calls.jsonl"),
      DEVCYCLE_NESTED_RUN: "1",
      DEVCYCLE_DRIVE_TOKEN: "inherited-token",
      ...env,
    },
  };
}

const calls = (h) => (existsSync(h.callsPath) ? readFileSync(h.callsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function records(h) {
  if (!existsSync(h.runsDir)) return [];
  return readdirSync(h.runsDir).flatMap((slug) => {
    const p = join(h.runsDir, slug, `${RUN}.jsonl`);
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "drive") : [];
  });
}

function startDriver(root, h, flags = []) {
  const child = spawn(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, ...flags], { cwd: root, env: h.env });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const closed = new Promise((res) => child.on("close", (code) => res(code)));
  return { child, result: async () => ({ code: await closed, out }) };
}

async function drive(root, scenario, { flags = [], env = {} } = {}) {
  const h = harness(scenario, env);
  const r = await startDriver(root, h, flags).result();
  return { ...r, calls: calls(h), records: records(h) };
}

// Pre-flight only: --dry-run spawns nothing and takes no lock.
function dryRun(root, flags = [], env = {}) {
  const h = harness([], env);
  const r = spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--dry-run", ...flags], { cwd: root, env: h.env, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr, calls: calls(h) };
}

async function waitFor(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the driver");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const lockPath = (root) => join(root, DRIVE_LOCK_REL);
const writeLock = (root, fields) =>
  writeFileSync(lockPath(root), JSON.stringify({ hostname: hostname(), state: ".devcycle/state.md", log: ".devcycle/drive.log", ...fields }));

test("drives one fresh session per wave until the state reaches branch-review, writing one drive record per session", async () => {
  const root = makeCycle();
  const r = await drive(root, [
    { ledger: [line(1, "dispatched"), DONE[0]] },
    { ledger: [line(2, "dispatched"), DONE[1]], stage: "branch-review", costUsd: 0.25, denials: 1 },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["handoff", "handoff"]);
  assert.deepEqual(
    r.records.map((x) => [x.ledgerLinesBefore, x.ledgerLinesAfter, x.committedBefore, x.committedAfter, x.waveAtStart]),
    [[0, 2, 0, 1, 1], [2, 4, 1, 2, 2]],
  );
  assert.equal(r.records[1].costUsd, 0.25);
  assert.equal(r.records[1].guardDenials, 1);
  assert.equal(r.records[0].depthTokens, 60010);
  assert.equal(r.records[0].model, MODEL);
  assert.match(r.records[0].sessionHash, /^[0-9a-f]{64}$/);
  assert.match(r.out, /task=1 event=committed/);
  assert.ok(!existsSync(lockPath(root)), "the lock outlived the driver");
});

test("each session is claude -p on the drive prompt with auto permissions, stream-json and an explicit model, and never sees DEVCYCLE_NESTED_RUN", async () => {
  const root = makeCycle();
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls[0].argv, ["-p", "/devcycle:continue --drive .devcycle/state.md", "--model", MODEL,
    "--permission-mode", "auto", "--output-format", "stream-json", "--verbose"]);
  assert.equal(r.calls[0].nested, false, "DEVCYCLE_NESTED_RUN reached the driven session");
  const pinned = await drive(makeCycle(), [{ ledger: DONE, stage: "branch-review" }], { flags: ["--model", "claude-opus-5-5"] });
  assert.equal(pinned.calls[0].argv[pinned.calls[0].argv.indexOf("--model") + 1], "claude-opus-5-5");
});

test("each session gets this driver's own token, whose hash and only its hash the lock holds; every run draws a new one", async () => {
  const r = await drive(makeCycle(), [{ ledger: [line(1, "dispatched"), DONE[0]] }, { ledger: [DONE[1]], stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
  const [first, second] = r.calls;
  assert.match(first.token, /^[0-9a-f]{32}$/, "the driven session was not handed a token (or kept the inherited one)");
  assert.equal(first.lockTokenHash, createHash("sha256").update(first.token).digest("hex"));
  assert.equal(second.token, first.token, "one driver run hands every session the same token");
  const again = await drive(makeCycle(), [{ ledger: DONE, stage: "branch-review" }]);
  assert.notEqual(again.calls[0].token, first.token, "two driver runs share a token");
});

test("a session that ends mid-wave is respawned, and the safety valve's label is recorded as valve", async () => {
  const root = makeCycle();
  const r = await drive(root, [
    { ledger: [line(1, "dispatched")], result: "## Handoff\n- Session ended mid-wave: 0 of 1 tasks done (stage: execution)" },
    { ledger: [DONE[0]] },
    { ledger: [DONE[1]], stage: "branch-review" },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["valve", "handoff", "handoff"]);
});

test("sessions without a ledger line are stalls: --max-stalls in a row exits 5 with the last result text, and progress resets the count", async () => {
  const root = makeCycle();
  const question = "Which state file should I resume: .devcycle/state.md or sub/.devcycle/state.md?";
  const r = await drive(root, [{ result: "nothing to do" }, { ledger: [line(1, "dispatched")] }, { result: "still nothing" }, { result: question }]);
  assert.equal(r.code, 5, r.out);
  assert.ok(r.out.includes(question), "the last session's result text was not printed");
  assert.deepEqual(r.records.map((x) => [x.exitReason, x.stallCount]), [["stalled", 1], ["handoff", 0], ["stalled", 1], ["stalled", 2]]);
  const three = await drive(makeCycle(), [{ result: "nothing" }], { flags: ["--max-stalls", "3"] });
  assert.equal(three.code, 5);
  assert.equal(three.calls.length, 3);
});

test("sessions that add ledger lines but no report, verdict or commit are churn: --max-churn in a row exits 5", async () => {
  const dying = { ledger: [line(1, "dispatched")], noResult: true, exitCode: 1 };
  const r = await drive(makeCycle(), [dying]);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.calls.length, 3, "the default --max-churn is 3");
  assert.match(r.out, /3 sessions in a row added ledger lines but no report, verdict or commit/);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["error", "error", "stalled"]);
  const reported = await drive(makeCycle(), [dying, dying, { ledger: [line(1, "report-received")] }, dying, dying, dying], { flags: ["--max-churn", "3"] });
  assert.equal(reported.code, 5, reported.out);
  assert.equal(reported.calls.length, 6, "a report resets the churn count");
  const two = await drive(makeCycle(), [dying], { flags: ["--max-churn", "2"] });
  assert.equal(two.calls.length, 2);
});

// A claude that dies before its init event reports no session id, and sessions like that end within
// the same second: each still gets its own drive row. Five of them cannot all start in different
// seconds, so the first run collides on any key built from a timestamp.
test("sessions that die before init each write their own drive row", async () => {
  const five = await drive(makeCycle(), [{ noInit: true }], { flags: ["--max-stalls", "5"] });
  assert.equal(five.code, 5, five.out);
  assert.deepEqual(five.records.map((x) => x.exitReason), ["error", "error", "error", "error", "stalled"]);
  const r = await drive(makeCycle(), [{ noInit: true }]);
  assert.equal(r.code, 5, r.out);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.records.map((x) => x.exitReason), ["error", "stalled"]);
  assert.equal(new Set(r.records.map((x) => x.sessionHash)).size, 2);
  const token = r.calls[0].token;
  for (const row of r.records) assert.ok(!JSON.stringify(row).includes(token), "a drive row stores the raw drive token");
});

test("every stop reason a driven session signals ends the driver with exit 4, its reason and its detail", async () => {
  for (const reason of STOP_REASONS) {
    const r = await drive(makeCycle(), [{ stop: { reason, detail: `detail for ${reason}` } }]);
    assert.equal(r.code, 4, `${reason}: ${r.out}`);
    assert.ok(r.out.includes(reason) && r.out.includes(`detail for ${reason}`), r.out);
    assert.deepEqual(r.records.map((x) => [x.exitReason, x.stopReason]), [["stopped", reason]]);
  }
});

test("a drive-stop.json left from an earlier run is cleared before the next session", async () => {
  const root = makeCycle();
  writeInto(root, ".devcycle/drive-stop.json", JSON.stringify({ reason: "needs-user", detail: "old" }));
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
});

test("--max-usd caps the total and passes each session the remainder as --max-budget-usd", async () => {
  const r = await drive(makeCycle(), [{ ledger: [line(1, "dispatched")], costUsd: 0.6 }], { flags: ["--max-usd", "1"] });
  assert.equal(r.code, 6, r.out);
  assert.equal(r.calls.length, 2);
  const budgetOf = (c) => c.argv[c.argv.indexOf("--max-budget-usd") + 1];
  assert.deepEqual(r.calls.map(budgetOf), ["1.00", "0.40"]);
  assert.equal(r.records.at(-1).exitReason, "budget");
});

test("a usage limit waits for the reset and retries without counting a stall; past --max-backoff it exits 6", async () => {
  const waited = await drive(makeCycle(), [{ rateLimitInSec: 1 }, { ledger: DONE, stage: "branch-review" }], { flags: ["--max-stalls", "1"] });
  assert.equal(waited.code, 0, waited.out);
  assert.deepEqual(waited.records.map((x) => [x.exitReason, x.stallCount]), [["budget", 0], ["handoff", 0]]);

  const capped = await drive(makeCycle(), [{ rateLimitInSec: 120 }], { flags: ["--max-backoff", "1"] });
  assert.equal(capped.code, 6, capped.out);
  assert.equal(capped.calls.length, 1);

  const resetAt = Math.floor(Date.now() / 1000) + 120;
  const fromText = await drive(makeCycle(), [{ isError: true, result: `Claude AI usage limit reached|${resetAt}` }], { flags: ["--max-backoff", "1"] });
  assert.equal(fromText.code, 6, fromText.out);
  assert.equal(fromText.records[0].exitReason, "budget");
});

test("SIGINT stops the running session, writes its record, releases the lock and exits 130", async () => {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched")], hangMs: 60000 }]);
  const d = startDriver(root, h);
  await waitFor(() => calls(h).length === 1);
  const { pid } = calls(h)[0];
  d.child.kill("SIGINT");
  const r = await d.result();
  assert.equal(r.code, 130, r.out);
  assert.ok(!existsSync(lockPath(root)), "the lock outlived an interrupted driver");
  assert.deepEqual(records(h).map((x) => x.exitReason), ["interrupted"]);
  assert.throws(() => process.kill(pid, 0), "the driven session survived the interrupt");
});

test("after a SIGKILL the next driver reclaims the dead holder's lock and carries on", async () => {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched")], hangMs: 60000 }, { ledger: DONE, stage: "branch-review" }]);
  const first = startDriver(root, h);
  await waitFor(() => calls(h).length === 1);
  first.child.kill("SIGKILL");
  await first.result();
  try { process.kill(-calls(h)[0].pid, "SIGKILL"); } catch { /* already gone */ }
  assert.equal(JSON.parse(readFileSync(lockPath(root), "utf8")).pid, first.child.pid, "the killed driver left no lock to reclaim");
  const r = await startDriver(root, h).result();
  assert.equal(r.code, 0, r.out);
  assert.equal(calls(h).length, 2);
  assert.deepEqual(records(h).map((x) => x.exitReason), ["handoff"]);
  assert.ok(!existsSync(lockPath(root)));
});

test("a lock whose pid is alive but whose start time differs is a reused pid, and is reclaimed", async () => {
  const root = makeCycle();
  writeLock(root, { pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970" });
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 0, r.out);
});

test("--detach returns at once with the driver's pid, and the detached driver walks to branch-review on its own, logging to .devcycle/drive.log", async () => {
  const root = makeCycle();
  const h = harness([{ ledger: [line(1, "dispatched"), DONE[0]], hangMs: 2000 }, { ledger: [DONE[1]], stage: "branch-review" }]);
  const r = spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { cwd: root, env: h.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { pid, log } = JSON.parse(r.stdout);
  assert.equal(log, ".devcycle/drive.log");
  assert.doesNotThrow(() => process.kill(pid, 0), "the detached driver was not running when --detach returned");
  // A new session's leader leads its own process group too: the caller's hangup cannot reach it.
  assert.equal(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim(), String(pid));
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 30000);
  assert.deepEqual(records(h).map((x) => x.exitReason), ["handoff", "handoff"]);
  assert.ok(!existsSync(lockPath(root)), "the detached driver left its lock behind");
  assert.match(readFileSync(join(root, ".devcycle", "drive.log"), "utf8"), /execution is complete/);

  const refused = spawnSync(process.execPath, [DRIVER, "--state", join(makeCycle({ branch: "main" }), ".devcycle", "state.md"), "--claude", h.bin, "--detach"], { env: h.env, encoding: "utf8" });
  assert.equal(refused.status, 3, "a pre-flight refusal must reach the caller before anything detaches");
});

test("a second driver on a live lock exits 3, naming the running one, and leaves its lock alone", async () => {
  const root = makeCycle();
  writeLock(root, { pid: process.pid, startTime: processStartTime(process.pid) });
  const before = readFileSync(lockPath(root), "utf8");
  const r = await drive(root, [{ ledger: DONE, stage: "branch-review" }]);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, new RegExp(`pid ${process.pid}`));
  assert.equal(r.calls.length, 0);
  assert.equal(readFileSync(lockPath(root), "utf8"), before);
});

test("a session without devcycle loaded, with plugin errors, or a claude that never starts is an environment failure: exit 3", async () => {
  const missing = await drive(makeCycle(), [{ plugins: [{ name: "superpowers" }] }]);
  assert.equal(missing.code, 3, missing.out);
  assert.match(missing.out, /devcycle is not loaded/);
  assert.deepEqual(missing.records.map((x) => x.exitReason), ["environment"]);
  const broken = await drive(makeCycle(), [{ pluginErrors: [{ plugin: "devcycle", error: "bad manifest" }] }]);
  assert.equal(broken.code, 3, broken.out);
  assert.match(broken.out, /plugin error/);
  const h = harness();
  const absent = spawnSync(process.execPath, [DRIVER, "--state", join(makeCycle(), ".devcycle", "state.md"), "--claude", join(h.runsDir, "no-such-claude")], { env: h.env, encoding: "utf8" });
  assert.equal(absent.status, 3, absent.stdout + absent.stderr);
  assert.match(absent.stdout + absent.stderr, /cannot run/);
});

test("pre-flight refuses the default branch, an integration branch, a branch other than the recorded one, and an unresolvable default", () => {
  for (const branch of ["main", "dev"]) {
    const r = dryRun(makeCycle({ branch }));
    assert.equal(r.code, 3, `${branch}: ${r.out}`);
    assert.match(r.out, /default or an integration branch/);
  }
  const root = makeCycle();
  sh("git", ["checkout", "-q", "-b", "elsewhere"], { cwd: root });
  const moved = dryRun(root);
  assert.equal(moved.code, 3, moved.out);
  assert.match(moved.out, /on elsewhere, but the state records feat\/drive/);
  const unnamed = makeCycle();
  sh("git", ["branch", "-qm", "main", "trunk"], { cwd: unnamed });
  const unresolved = dryRun(unnamed);
  assert.equal(unresolved.code, 3, unresolved.out);
  assert.match(unresolved.out, /cannot resolve the default branch/);
});

// D7: an agent never starts a driver. Inside Claude Code (CLAUDECODE set) the only start that passes
// is the opt-in gate's start-now, before any driven session has ended and written its drive row.
test("from inside a Claude Code session the driver starts only while the opt-in is unused", async () => {
  const root = makeCycle();
  const h = harness([{ stop: { reason: "needs-user", detail: "which branch?" } }]);
  const preflight = (env) => spawnSync(process.execPath, [DRIVER, "--state", join(root, ".devcycle", "state.md"), "--claude", h.bin, "--dry-run"],
    { cwd: root, env: { ...h.env, ...env }, encoding: "utf8" });
  assert.equal(preflight({ CLAUDECODE: "1" }).status, 0, "the opt-in gate's start-now was refused");
  assert.equal((await startDriver(root, h).result()).code, 4, "the first driven session did not stop");
  assert.equal(records(h).length, 1);
  const agent = preflight({ CLAUDECODE: "1" });
  assert.equal(agent.status, 3, agent.stdout + agent.stderr);
  assert.match(agent.stdout + agent.stderr, /start it from your own terminal/);
  assert.equal(preflight({}).status, 0, "a start from the user's own terminal was refused");
});

test("pre-flight allows tracked edits inside the current wave's in-flight Files and untracked files, and refuses any other tracked change", () => {
  const root = makeCycle();
  writeInto(root, "src/a.txt", "half-done implementer edit\n");
  writeInto(root, "notes.txt", "untracked\n");
  const allowed = dryRun(root);
  assert.equal(allowed.code, 0, allowed.out);
  assert.deepEqual(JSON.parse(allowed.out.trim().split("\n").at(-1)).command.slice(1, 3), ["-p", "/devcycle:continue --drive .devcycle/state.md"]);
  assert.equal(allowed.calls.length, 0, "--dry-run spawned a session");

  writeInto(root, "other.txt", "stray\n");
  const refused = dryRun(root);
  assert.equal(refused.code, 3, refused.out);
  assert.match(refused.out, /other\.txt/);

  const later = makeCycle();
  writeInto(later, ".devcycle/ledger.md", readFileSync(join(later, ".devcycle/ledger.md"), "utf8") + `- [2026-10-08T00:00:00Z] ${DONE[0]}\n`);
  writeInto(later, "src/a.txt", "edit to a committed task's file\n");
  const committedTask = dryRun(later);
  assert.equal(committedTask.code, 3, committedTask.out);
  assert.match(committedTask.out, /src\/a\.txt/);
});

test("pre-flight refuses a state without the drive row, a state off execution, a model whose window cannot hold a session start, and a sandbox", () => {
  const notOpted = dryRun(makeCycle({ drive: null }));
  assert.equal(notOpted.code, 3, notOpted.out);
  assert.match(notOpted.out, /drive: auto/);

  const planning = dryRun(makeCycle({ stage: "planning" }));
  assert.equal(planning.code, 3, planning.out);
  assert.match(planning.out, /stage planning, not execution/);

  assert.equal(SESSION_START_TOKENS, 55000);
  const small = dryRun(makeCycle(), ["--model", "claude-haiku-4-5-20251001"]);
  assert.equal(small.code, 3, small.out);
  assert.match(small.out, /over-budget band/);

  const home = makeTempDir("devcycle-drive-readonly-home-");
  chmodSync(home, 0o500);
  try {
    const sandbox = dryRun(makeCycle(), [], { HOME: home });
    assert.equal(sandbox.code, 3, sandbox.out);
    assert.match(sandbox.out, /sandbox/);
  } finally {
    chmodSync(home, 0o700);
  }
});

test("--check-sandbox answers with JSON and touches no state; usage errors exit 2", () => {
  const h = harness();
  const run = (args) => spawnSync(process.execPath, [DRIVER, ...args], { env: h.env, encoding: "utf8" });
  const probe = run(["--check-sandbox"]);
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), { sandboxed: false });
  for (const args of [[], ["--state"], ["--state", "x", "--bogus"], ["--state", "x", "--max-stalls", "0"], ["--state", "x", "--max-usd", "abc"]])
    assert.equal(run(args).status, 2, `expected a usage error for ${JSON.stringify(args)}`);
});

test("inFlightFiles names the first wave with an uncommitted task and only its uncommitted tasks' files", () => {
  const entry = (task, event) => ({ task: String(task), event });
  assert.deepEqual(inFlightFiles(PLAN, []), { wave: 1, files: new Set(["src/a.txt"]) });
  assert.deepEqual(inFlightFiles(PLAN, [entry(1, "dispatched")]), { wave: 1, files: new Set(["src/a.txt"]) });
  assert.deepEqual(inFlightFiles(PLAN, [entry(1, "committed")]), { wave: 2, files: new Set(["src/b.txt"]) });
  assert.deepEqual(inFlightFiles(PLAN, [entry(1, "committed"), entry(2, "committed")]), { wave: null, files: new Set() });
  // A later wave's task the ledger already names was dispatched ahead by readiness: in flight too.
  const ahead = PLAN.replace("**Dependencies:** Tasks 1 committed", "**Dependencies:** none (completely independent)");
  assert.deepEqual(inFlightFiles(ahead, [entry(2, "dispatched")]), { wave: 1, files: new Set(["src/a.txt", "src/b.txt"]) });
});
