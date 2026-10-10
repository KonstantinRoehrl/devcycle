// scripts/wave-setup.mjs: /devcycle:continue's execution resume path in one call. Each cycle is a
// throwaway git repo holding a state file, a plan and a ledger; the depth probe gets no session id or
// a fixture transcript root, so nothing here reads the real ~/.claude.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, sh, writeInto } from "./helpers.mjs";
import { RETRY_CAP, taskPosition, waveSetup } from "../../scripts/wave-setup.mjs";
import { acquireDriveLock, driveTokenHash, releaseDriveLock } from "../../scripts/drive-lock.mjs";
import { parseLedgerLine } from "../../scripts/task-ledger.mjs";
import { reviewLoopId } from "../../scripts/task-verdict.mjs";
import { ROSTER, formatKnobsLine, resolveKnobs } from "../../scripts/resolve-knobs.mjs";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/wave-setup.mjs");
const KNOBS = formatKnobsLine(resolveKnobs(Object.fromEntries(ROSTER.map(({ key }) => [key, ""]))).knobs);
const LEAN = KNOBS.replace("profile=standard", "profile=lean");
const DRIVE_ROW = "- drive: auto model=claude-haiku-4-5 opted=2026-10-08T10:00:00Z";
// The token a driver hands the sessions it starts; withLock's lock holds its hash.
const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

const PLAN = [
  "# Fixture plan", "",
  "### Task 1: First", "**Files:**", "- Create: src/a.mjs", "- Test: tests/a.test.mjs",
  "**Interfaces:** none", "**Dependencies:** none (completely independent)", "**Evidence:** red-green",
  "**Quality constraints:** none", "**Lessons:**", "",
  "- [ ] Run `node --test tests/a.test.mjs` — expect red.", "- [ ] Run `node --test tests/a.test.mjs` — expect green.", "",
  "### Task 2: Second", "**Files:**", "- Modify: src/b.mjs", "- Test: tests/b.test.mjs",
  "**Interfaces:** none", "**Dependencies:** none (completely independent)", "**Evidence:** green-green (behavior-preserving)",
  "**Quality constraints:** none", "**Lessons:**", "",
  "- [ ] Run `node --test tests/b.test.mjs` — expect green.", "",
  "### Task 3: Third", "**Files:**", "- Modify: src/a.mjs",
  "**Interfaces:** none", "**Dependencies:** Tasks 1+2 committed", "**Evidence:** convention (node scripts/validate.mjs)",
  "**Quality constraints:** none", "**Lessons:**", "",
  "- [ ] Run `node scripts/validate.mjs` — expect `validate: ok`.", "",
  "## Dispatch Map", "",
  "- Wave 1: Task 1, Task 2 (file-disjoint)", "- Wave 2: Task 3 (needs Tasks 1+2 committed)", "",
].join("\n");

const entry = (task, event, outcome, ref = "none") => `- [2026-10-08T10:00:00Z] task=${task} event=${event} outcome=${outcome} ref=${ref}`;
const committed = (task) => entry(task, "committed", "accepted", "abc1234");
const positionOf = ({ task, position, next }) => ({ task, position, next });

function cycle({ ledger = null, state = [], branch = "feat/x", root = null, planHeader = "docs/plan.md", plan = PLAN } = {}) {
  const repo = realpathSync(makeRepo());
  sh("git", ["checkout", "-qb", "feat/x"], { cwd: repo });
  writeInto(repo, "docs/plan.md", plan);
  const statePath = writeInto(repo, ".devcycle/state.md", [
    "# devcycle state", "- stage: execution", `- root: ${root ?? repo}`, `- branch: ${branch} (cut from main at 0000000)`,
    "- request: fixture cycle", "- plan: docs/plan.md", "- ledger: .devcycle/ledger.md", "- run: 00000000000000a1", ...state,
  ].join("\n") + "\n");
  const ledgerPath = join(repo, ".devcycle", "ledger.md");
  if (ledger)
    writeFileSync(ledgerPath, [`Plan: \`${planHeader}\``, "Branch: `feat/x` (cut from `main` at `0000000`)",
      "Profile: `standard` (evidence tail 40 lines)", "", ...ledger, ""].join("\n"));
  return { repo, statePath, ledgerPath };
}
const setup = (c, opts = {}) => waveSetup({ statePath: c.statePath, cwd: c.repo, env: {}, ...opts });
// A driven session: --drive, with the token the lock's driver handed it.
const driven = (c, opts = {}) => setup(c, { drive: true, ...opts, env: { DEVCYCLE_DRIVE_TOKEN: TOKEN, ...opts.env } });
function withLock(c, fn, statePath = c.statePath) {
  const { lock } = acquireDriveLock(c.repo, { statePath, logPath: join(c.repo, ".devcycle", "drive.log"), tokenHash: driveTokenHash(TOKEN) });
  try {
    return fn(lock);
  } finally {
    releaseDriveLock(c.repo, lock);
  }
}
// A transcript root whose session for `repo` stands at 152340 tokens on a 1M window: over budget.
function overBudget(repo) {
  const projects = makeTempDir("wave-setup-projects-");
  const dir = join(projects, repo.replaceAll("/", "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sess-1.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-10-08T10:00:00Z", message: {
    model: "claude-opus-5", content: [],
    usage: { input_tokens: 52340, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 9 } } }) + "\n");
  return { CLAUDE_CODE_SESSION_ID: "sess-1", CLAUDE_DOCTOR_PROJECTS: projects };
}

test("every resume-table row maps a task's last ledger event to its next action, most specific row first", () => {
  const rows = [
    [[], "not-dispatched", "dispatch-implementer"],
    [[entry(2, "dispatched", "implementer retry 0", ".devcycle/briefs/2-implementer.md")], "dispatched", "redispatch-implementer"],
    [[entry(2, "report-received", "complete", ".devcycle/reports/2.md")], "report-received", "dispatch-reviewer"],
    [[entry(2, "review-round", "round 1", ".devcycle/briefs/2-reviewer-round-1.md")], "review-round", "redispatch-reviewer"],
    [[entry(2, "review-verdict", "accepted")], "accepted", "commit"],
    [[entry(2, "review-verdict", "rejected (needs-changes)")], "rejected", "fix"],
    [[entry(2, "report-received", "rejected (intake bounce)", ".devcycle/findings/2-intake-0-0.md")], "intake-bounce", "fix"],
    [[entry(2, "report-received", "blocked", ".devcycle/reports/2.md")], "blocked", "needs-user"],
    [[entry(2, "review-verdict", "rejected (green gate: 3 failing)")], "rejected", "fix"],
    [[entry(2, "review-verdict", "rejected (missing findings file)", ".devcycle/findings/2-round-1.md")], "missing-findings", "redispatch-reviewer"],
    [[entry(2, "report-received", "rejected (missing report file)", ".devcycle/reports/2.md")], "missing-report", "redispatch-implementer"],
    [[entry(2, "review-verdict", "deferred (concurrent sibling edits)")], "deferred", "regate-after-quiesce"],
    [[committed(2)], "committed", "done"],
    [[entry(2, "dispatched", "sweep 4 targets")], "sweep-dispatched", "rerun-sweep"],
    [[entry(2, "dispatched", "sweep 4 targets"), entry(2, "review-verdict", "applied-none")], "sweep-decision", "needs-user"],
    [[entry(2, "user-decision", "keep the residue")], "user-decision", "follow-decision"],
  ];
  for (const [lines, position, next] of rows)
    assert.deepEqual(taskPosition(lines.map(parseLedgerLine)), { position, next }, lines.join(" | ") || "no ledger line");
});

test("a third intake bounce, missing report or missing findings is a decision for the user, never another retry", () => {
  for (const [event, outcome] of [["report-received", "rejected (intake bounce)"], ["report-received", "rejected (missing report file)"],
    ["review-verdict", "rejected (missing findings file)"]]) {
    const lines = [parseLedgerLine(entry(2, event, outcome))];
    assert.notEqual(taskPosition(lines, { retries: () => RETRY_CAP }).next, "needs-user", `${outcome}: retry ${RETRY_CAP} is still allowed`);
    assert.deepEqual(taskPosition(lines, { retries: () => RETRY_CAP + 1 }), { position: "retry-cap", next: "needs-user" }, outcome);
  }
  const c = cycle({ ledger: [committed(1), ...[1, 2, 3].map((n) =>
    entry(2, "review-verdict", "rejected (missing findings file)", `.devcycle/findings/2-round-${n}.md`))] });
  assert.deepEqual(positionOf(setup(c).tasks[1]), { task: "2", position: "retry-cap", next: "needs-user" });
});

test("an exhausted-unresolved loop is pending until a decision of that task names its loop id; drive and config decisions never clear it", () => {
  const c = cycle({ ledger: [committed(1), entry(2, "review-verdict", "rejected (needs-changes)")] });
  writeInto(c.repo, `.devcycle/findings/${reviewLoopId(2)}-status.md`, "status: exhausted-unresolved rounds: 3/3 residue: 2 carried-to: none\n");
  let r = setup(c);
  assert.deepEqual(r.pendingDecision, { task: "2", loopId: "task-2-review" });
  assert.deepEqual(positionOf(r.tasks[1]), { task: "2", position: "exhausted-unresolved", next: "needs-user" });
  appendFileSync(c.ledgerPath, entry("config", "user-decision", "knobs changed mid-cycle: task-2-review", ".devcycle/state.md") + "\n");
  appendFileSync(c.ledgerPath, entry("drive", "user-decision", "unattended (model=x) task-2-review", ".devcycle/state.md") + "\n");
  assert.deepEqual(setup(c).pendingDecision, { task: "2", loopId: "task-2-review" });
  appendFileSync(c.ledgerPath, entry(2, "user-decision", "carry the residue of task-2-review to an issue") + "\n");
  r = setup(c);
  assert.equal(r.pendingDecision, null);
  assert.deepEqual(positionOf(r.tasks[1]), { task: "2", position: "user-decision", next: "follow-decision" });
});

// The status file carries no time, but every exhaustion is a rejection line in the ledger: one after
// the latest decision naming the loop is an exhaustion that decision never saw.
test("a review loop exhausted again after the user's decision is pending again; a missing findings file is no exhaustion", () => {
  const c = cycle({ ledger: [committed(1), entry(2, "review-verdict", "rejected", ".devcycle/findings/2-round-3.md"),
    entry(2, "user-decision", "one more round for task-2-review")] });
  writeInto(c.repo, `.devcycle/findings/${reviewLoopId(2)}-status.md`, "status: exhausted-unresolved rounds: 3/3 residue: 2 carried-to: none\n");
  appendFileSync(c.ledgerPath, [
    entry(2, "review-round", "round 4"),
    entry(2, "review-verdict", "rejected (missing findings file)", ".devcycle/findings/2-round-4.md"),
    entry(2, "review-round", "round 4"),
    entry(2, "review-verdict", "accepted", ".devcycle/findings/2-round-4.md"),
  ].join("\n") + "\n");
  assert.equal(setup(c).pendingDecision, null);
  appendFileSync(c.ledgerPath, entry(2, "review-verdict", "rejected (green gate: exit 1)", ".devcycle/evidence/2-gate.txt") + "\n");
  const r = setup(c);
  assert.deepEqual(r.pendingDecision, { task: "2", loopId: "task-2-review" });
  assert.deepEqual(positionOf(r.tasks[1]), { task: "2", position: "exhausted-unresolved", next: "needs-user" });
});

test("the current wave is the first with uncommitted work; dispatchable tasks carry their brief inputs once their dependencies are committed", () => {
  const fresh = setup(cycle());
  assert.equal(fresh.wave, 1);
  assert.deepEqual(fresh.dispatchable.map((d) => [d.task, d.testCmd]), [["1", "node --test tests/a.test.mjs"], ["2", "node --test tests/b.test.mjs"]]);
  assert.match(fresh.entryLines[0], /^entry: .*playbooks\/executing-waves\.md$/);

  const first = setup(cycle({ ledger: [committed(1)] }));
  assert.deepEqual([first.ok, first.action, first.wave, first.appended], [true, "resume", 1, []]);
  assert.deepEqual(first.tasks.map(positionOf), [{ task: "1", position: "committed", next: "done" }, { task: "2", position: "not-dispatched", next: "dispatch-implementer" }]);
  assert.deepEqual(first.dispatchable, [{ task: "2", files: ["src/b.mjs", "tests/b.test.mjs"], evidence: "green-green (behavior-preserving)",
    evidenceClass: "green-green", testCmd: "node --test tests/b.test.mjs", dependencies: [], mapRow: { wave: 1, tasks: [1, 2] } }]);

  const second = setup(cycle({ ledger: [committed(1), committed(2)] }));
  assert.equal(second.wave, 2);
  assert.deepEqual(second.dispatchable, [{ task: "3", files: ["src/a.mjs"], evidence: "convention (node scripts/validate.mjs)",
    evidenceClass: "convention", testCmd: null, dependencies: ["1", "2"], mapRow: { wave: 2, tasks: [3] } }]);

  const done = setup(cycle({ ledger: [1, 2, 3].map(committed) }));
  assert.deepEqual([done.wave, done.tasks, done.dispatchable, done.pendingDecision], [null, [], [], null]);
});

// Steps 5 and 6 need a task's evidence class, test command and review round whatever step it resumes
// at, not only when an implementer is next.
test("every uncommitted task carries its brief inputs and the round its next review takes", () => {
  const inputs = (t) => [t.task, t.next, t.evidenceClass, t.testCmd, t.reviewRound];
  const round1 = entry(1, "review-round", "round 1");
  const reviewing = setup(cycle({ ledger: [entry(1, "report-received", "complete"), round1,
    entry(2, "review-round", "round 1"), entry(2, "review-verdict", "accepted")] }));
  assert.deepEqual(reviewing.tasks.map(inputs), [
    ["1", "redispatch-reviewer", "red-green", "node --test tests/a.test.mjs", 1],
    ["2", "commit", "green-green", "node --test tests/b.test.mjs", 2],
  ]);
  assert.deepEqual(reviewing.tasks[0].files, ["src/a.mjs", "tests/a.test.mjs"]);
  assert.equal(reviewing.tasks[1].evidence, "green-green (behavior-preserving)");
  const missing = entry(1, "review-verdict", "rejected (missing findings file)");
  const gateFail = entry(2, "review-verdict", "rejected (green gate: exit 1)");
  const later = setup(cycle({ ledger: [round1, missing, entry(2, "review-round", "round 1"), entry(2, "review-verdict", "accepted"), gateFail,
    entry(2, "report-received", "complete")] }));
  assert.deepEqual(later.tasks.map(inputs), [
    ["1", "redispatch-reviewer", "red-green", "node --test tests/a.test.mjs", 1],
    ["2", "dispatch-reviewer", "green-green", "node --test tests/b.test.mjs", 2],
  ], "a missing findings file keeps its round open; a green-gate rejection closes it");
  const deferred = setup(cycle({ ledger: [committed(1), entry(2, "review-verdict", "deferred (concurrent sibling edits)")] }));
  assert.deepEqual(deferred.tasks.map(inputs), [["1", "done", undefined, undefined, undefined],
    ["2", "regate-after-quiesce", "green-green", "node --test tests/b.test.mjs", 1]]);
});

// playbooks/executing-waves.md § Wave formation: a task is ready once its dependencies are committed,
// whatever Map wave lists it, and never runs beside a task holding one of its files.
test("a later Map wave's task joins the current wave once its dependencies are committed, unless a task holding one of its files is ahead of it", () => {
  const plan = PLAN.split("## Dispatch Map")[0] + [
    "### Task 4: Early", "**Files:**", "- Create: src/c.mjs", "**Interfaces:** none", "**Dependencies:** Task 1 committed",
    "**Evidence:** red-green", "**Quality constraints:** none", "**Lessons:**", "",
    "### Task 5: Overlapping", "**Files:**", "- Modify: src/b.mjs", "**Interfaces:** none", "**Dependencies:** Task 1 committed",
    "**Evidence:** red-green", "**Quality constraints:** none", "**Lessons:**", "",
    "## Dispatch Map", "", "- Wave 1: Task 1, Task 2", "- Wave 2: Task 3, Task 4, Task 5 (Task 3 needs Tasks 1+2; Tasks 4 and 5 need Task 1)", "",
  ].join("\n");
  const waiting = setup(cycle({ plan, ledger: [committed(1)] }));
  assert.equal(waiting.wave, 1);
  assert.deepEqual(waiting.tasks.map((t) => [t.task, t.position]),
    [["1", "committed"], ["2", "not-dispatched"], ["4", "not-dispatched"], ["5", "not-dispatched"]]);
  assert.deepEqual(waiting.dispatchable.map((d) => [d.task, d.mapRow.wave]), [["2", 1], ["4", 2]], "Task 5 waits: Task 2 goes first on src/b.mjs");
  const running = setup(cycle({ plan, ledger: [committed(1), entry(2, "dispatched", "implementer retry 0")] }));
  assert.deepEqual(running.dispatchable.map((d) => d.task), ["2", "4"], "Task 5 waits while Task 2 is in flight on src/b.mjs");
  const after = setup(cycle({ plan, ledger: [committed(1), committed(2)] }));
  assert.deepEqual([after.wave, after.dispatchable.map((d) => d.task)], [2, ["3", "4", "5"]]);
});

test("a ledger whose Plan: header names another plan is a previous cycle's: none of its lines counts", () => {
  const r = setup(cycle({ ledger: [committed(1), committed(2)], planHeader: "docs/old-plan.md" }));
  assert.equal(r.wave, 1);
  assert.deepEqual(r.tasks.map((t) => t.position), ["not-dispatched", "not-dispatched"]);
});

test("knob drift compares the recorded knobs: line with the fresh one; a matching knobs-declined row is flagged", () => {
  const c = cycle({ state: [`- ${KNOBS}`] });
  const r = setup(c, { knobsLine: LEAN });
  assert.deepEqual(r.knobDrift, ["profile: standard → lean"]);
  assert.equal(r.state.knobsLine, KNOBS.replace(/^knobs: /, ""));
  assert.equal(r.state.knobsDeclined, false);
  assert.deepEqual(setup(c, { knobsLine: KNOBS }).knobDrift, []);
  const declined = cycle({ state: [`- ${KNOBS}`, `- knobs-declined: ${LEAN.replace(/^knobs: /, "")}`] });
  assert.equal(setup(declined, { knobsLine: LEAN }).state.knobsDeclined, true);
  const unrecorded = setup(cycle(), { knobsLine: LEAN });
  assert.deepEqual([unrecorded.knobDrift, unrecorded.state.knobsLine], [[], null]);
});

test("the branch verdict: on the recorded topic branch, on another branch, or a recorded default branch", () => {
  const c = cycle();
  assert.deepEqual(setup(c).branch, { recorded: "feat/x", current: "feat/x", verdict: "ok" });
  sh("git", ["checkout", "-q", "main"], { cwd: c.repo });
  assert.deepEqual(setup(c).branch, { recorded: "feat/x", current: "main", verdict: "switch-needed" });
  assert.equal(setup(cycle({ branch: "main" })).branch.verdict, "integration");
});

test("the depth band rides along; an unmeasurable depth is unknown, and neither stops a manual resume", () => {
  const c = cycle();
  const unknown = setup(c);
  assert.deepEqual([unknown.depth.band, unknown.depth.tokens, unknown.depthBand, unknown.action], ["unknown", null, "unknown", "resume"]);
  const deep = setup(c, { env: overBudget(c.repo) });
  assert.deepEqual([deep.depth.band, deep.depth.tokens, deep.depthBand, deep.action], ["over-budget", 152340, "over-budget", "resume"]);
});

test("manual stops: another checkout's file, a stale file, a live driver on this state file", () => {
  const foreign = setup(cycle({ root: "/nowhere/else" }));
  assert.deepEqual([foreign.action, foreign.stopReason], ["stop", "foreign-state"]);
  const planning = cycle();
  writeFileSync(planning.statePath, readFileSync(planning.statePath, "utf8").replace("- stage: execution", "- stage: planning"));
  assert.deepEqual([setup(planning).stopReason, setup(planning).stopDetail], ["resume-check", "the state file is at stage planning, not execution"]);
  const stale = setup(cycle({ state: ["- spec: docs/gone.md"] }));
  assert.deepEqual([stale.action, stale.stopReason], ["stop", "resume-check"]);
  assert.match(stale.stopDetail, /spec: recorded artifact does not exist on disk: docs\/gone\.md/);
  const c = cycle();
  withLock(c, (lock) => {
    const r = setup(c);
    assert.deepEqual([r.action, r.stopReason, r.drive.lock], ["stop", "driver-running", { pid: process.pid, log: lock.log }]);
    assert.match(r.stopDetail, new RegExp(`; if pid ${process.pid} is no longer running \\(after a reboot, say\\), remove \\.devcycle/drive\\.lock$`));
  });
  withLock(c, () => assert.equal(setup(c).action, "resume"), join(c.repo, ".devcycle", "other-state.md"));
});

test("drive mode: only a session holding the live driver's token drives; not opted in, and every gate a stop", () => {
  const opted = { state: [DRIVE_ROW] };
  assert.equal(driven(cycle(opted)).stopReason, "no-driver");
  const typed = cycle(opted);
  withLock(typed, () => {
    for (const env of [{}, { DEVCYCLE_DRIVE_TOKEN: "" }, { DEVCYCLE_DRIVE_TOKEN: "not-the-token" }]) {
      const r = setup(typed, { drive: true, env });
      assert.deepEqual([r.action, r.stopReason], ["stop", "no-driver"], `--drive typed beside a live driver resumed with ${JSON.stringify(env)}`);
    }
    assert.equal(setup(typed).stopReason, "driver-running", "a manual continue beside a live driver resumed");
    assert.equal(driven(typed).action, "resume");
  });
  const plain = cycle();
  withLock(plain, () => assert.equal(driven(plain).stopReason, "not-opted-in"));
  const elsewhere = cycle(opted);
  withLock(elsewhere, () => assert.equal(driven(elsewhere).stopReason, "no-driver"), join(elsewhere.repo, ".devcycle", "other-state.md"));
  const drift = cycle({ state: [DRIVE_ROW, `- ${KNOBS}`] });
  withLock(drift, () => assert.deepEqual(
    [driven(drift, { knobsLine: LEAN }).stopReason, driven(drift, { knobsLine: KNOBS }).action], ["knob-drift", "resume"]));
  const moved = cycle(opted);
  sh("git", ["checkout", "-q", "main"], { cwd: moved.repo });
  withLock(moved, () => assert.equal(driven(moved).stopReason, "branch"));
  const deep = cycle(opted);
  withLock(deep, () => assert.equal(driven(deep, { env: overBudget(deep.repo) }).stopReason, "depth-at-start"));
  const closed = cycle(opted);
  writeFileSync(closed.statePath, readFileSync(closed.statePath, "utf8").replace("- stage: execution", "- stage: branch-review"));
  withLock(closed, () => assert.equal(driven(closed).stopReason, "resume-check"));
  const capped = cycle({ ...opted, ledger: [committed(1), ...[1, 2, 3].map(() =>
    entry(2, "report-received", "rejected (missing report file)", ".devcycle/reports/2.md"))] });
  withLock(capped, () => {
    const r = driven(capped);
    assert.deepEqual([r.action, r.stopReason, r.stopDetail], ["stop", "needs-user", "task 2: retry-cap"]);
  });
  const swept = cycle({ ...opted, ledger: [committed(1), entry(2, "dispatched", "sweep 4 targets"), entry(2, "review-verdict", "applied-none")] });
  withLock(swept, () => {
    const r = driven(swept);
    assert.deepEqual([r.action, r.stopReason, r.stopDetail], ["stop", "sweep-fallback", "task 2: sweep-decision"]);
  });
});

test("drive mode: a resumable cycle reports its opt-in, its model, its driver and whether the opt-in line is logged", () => {
  const c = cycle({ state: [DRIVE_ROW], ledger: [committed(1)] });
  withLock(c, (lock) => {
    const r = driven(c, { knobsLine: KNOBS });
    assert.equal(r.action, "resume");
    assert.deepEqual(r.drive, { opted: true, model: "claude-haiku-4-5", lock: { pid: process.pid, log: lock.log }, optInLogged: false });
    assert.ok(!JSON.stringify(r).includes(driveTokenHash(TOKEN)), "wave-setup reports the lock's token hash");
    appendFileSync(c.ledgerPath, entry("drive", "user-decision", "unattended (model=claude-haiku-4-5)", ".devcycle/state.md") + "\n");
    assert.equal(driven(c).drive.optInLogged, true);
  });
});

test("cli: one JSON object on stdout; a usage error exits 2, a state file outside git exits 3", () => {
  const home = makeTempDir("wave-setup-home-");
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_DOCTOR_PROJECTS: home };
  const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", ...opts });
  const c = cycle({ ledger: [committed(1)] });
  const ok = run(["--state", c.statePath, "--knobs", KNOBS], { cwd: c.repo });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim().split("\n").length, 1);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.ok, out.action, out.wave, out.appended, out.depthBand], [true, "resume", 1, [], "unknown"]);
  for (const args of [[], ["--state"], ["--state", c.statePath, "--bogus"]]) {
    const r = run(args, { cwd: c.repo });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}`);
    const usage = JSON.parse(r.stdout);
    assert.deepEqual([usage.ok, usage.action], [false, "usage-error"]);
    assert.match(usage.error, /^wave-setup: /);
  }
  const outside = makeTempDir("wave-setup-nogit-");
  const state = writeInto(outside, ".devcycle/state.md", "# devcycle state\n- stage: execution\n");
  const r = run(["--state", state], { cwd: outside, env: { ...env, GIT_CEILING_DIRECTORIES: dirname(outside) } });
  assert.equal(r.status, 3, r.stdout);
  const failure = JSON.parse(r.stdout);
  assert.deepEqual([failure.ok, failure.action], [false, "environment-error"]);
  assert.match(failure.error, /not a git repository/);
});

// The hooks module joins a session to its run only on a main-loop Bash call carrying the session
// append (hooks/devcycle-mod.mjs `appendsSessionRow`; tests/mod/guard.test.ts pins the join). An
// append folded into wave-setup would never be seen, and agent tracing and the subagent governor
// would silently stay off.
test("continue keeps the session append as its own call beside wave-setup, and wave-setup never appends one", () => {
  const section = readFileSync(join(ROOT, "commands/continue.md"), "utf8").split("\n## Execution resume\n")[1]?.split("\n## ")[0] ?? "";
  assert.ok(section.includes("scripts/wave-setup.mjs"), "commands/continue.md § Execution resume no longer runs wave-setup.mjs");
  const spans = [...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const appends = spans.filter((s) => /run-record\.mjs append .*--kind session/.test(s));
  assert.equal(appends.length, 1, "§ Execution resume must carry exactly one --kind session append");
  assert.ok(!appends[0].includes("wave-setup"), "the session append is folded into the wave-setup call");
  assert.ok(spans.filter((s) => s.includes("wave-setup.mjs")).every((s) => !s.includes("--kind session")));
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(!source.includes("--kind session") && !source.includes("run-record"), "scripts/wave-setup.mjs appends or names the session row");
});
