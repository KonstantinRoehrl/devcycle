import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { logStep } from "../../scripts/stage-log.mjs";
import { pathInsideRoot, planPosition, readPlanPosition } from "../../scripts/plan-resume.mjs";
import { writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/plan-resume.mjs", import.meta.url).pathname;
const ASSEMBLE = new URL("../../scripts/plan-assemble.mjs", import.meta.url).pathname;
const RUN = "00000000000000c5";
const WORK = `.devcycle/plan-work/${RUN}`;
const STATE = `# devcycle state\n- stage: planning\n- run: ${RUN}\n`;
const GROUPS = { 1: [1, 2], 2: [3, 4], 3: [5] };
const CUT = [1, 2, 3, 4, 5].map((num) => ({ num, wave: num < 3 ? 1 : num < 5 ? 2 : 3, deps: [], files: [`f${num}.mjs`], produces: 1 }));
const EMPTY = {
  strategy: null, groupsDone: [], nextGroup: null, drafted: [], missing: [], sections: [], pack: false, next: "draft",
  steps: [{ id: "plan-assembled", status: "pending" }, { id: "plan-gate", status: "pending" }],
};
const UNASSEMBLED = EMPTY.steps;
const taskText = (num) => `### Task ${num}: T${num}\n\n**Files:**\n- Create: \`f${num}.mjs\`\n\n**Dependencies:** none\n`;
const resume = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

function position(root) {
  const r = resume("--state", join(root, ".devcycle/state.md"));
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// A run at its task cut: the state file, the cut, the pack, the header and the drafting-plan row.
function startRun() {
  const root = makeTempDir("plan-resume-");
  const log = (key, extra) => logStep(join(root, ".devcycle"), { run: RUN, stage: "planning", key, ...extra });
  writeInto(root, ".devcycle/state.md", STATE);
  writeInto(root, `${WORK}/task-cut.json`, JSON.stringify(CUT));
  writeInto(root, `${WORK}/pack.md`, "# Context pack\n");
  log("drafting-plan", { data: { strategy: "checkpointed", groups: 0, drafters: 0, est: 4.2, cut: `${WORK}/task-cut.json` } });
  writeInto(root, `${WORK}/plan-header.md`, "# Plan\n\n**Goal:** g\n");
  log("plan-section-header", { ref: `${WORK}/plan-header.md` });
  return { root, log };
}

// One group's segment: each task file, then its plan-draft row, then the group's row.
function draftGroup({ root, log }, k, nums) {
  for (const num of nums) {
    writeInto(root, `${WORK}/tasks/task-${num}.md`, taskText(num));
    log(`plan-draft-${num}`, { ref: `${WORK}/tasks/task-${num}.md` });
  }
  log(`plan-group-${k}`, { data: { tasks: nums } });
}

function finish({ root, log }) {
  writeInto(root, `${WORK}/dispatch-map.md`, "## Dispatch Map\n\n- Wave 1: Task 1, Task 2\n- Wave 2: Task 3, Task 4\n- Wave 3: Task 5\n");
  log("plan-section-dispatch-map", { ref: `${WORK}/dispatch-map.md` });
  const out = join(root, "plan.md");
  const r = spawnSync("node", [ASSEMBLE, join(root, WORK), "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(out, "utf8");
}

test("a task is drafted only with both its plan-draft row and its task file, and the cut names what is missing", () => {
  const rows = [
    { key: "research-map", ref: ".devcycle/research.md" },
    { key: "drafting-plan", data: { strategy: "grouped", groups: 3, drafters: 3, est: 9.1 } },
    { key: "plan-draft-1" },
    { key: "plan-draft-3" },
    { key: "plan-draft-4" },
    { key: "plan-group-2", data: { tasks: [3, 4] } },
    { key: "plan-checkpoint-2" },
    { key: "plan-section-header", ref: "header.md" },
    { key: "plan-section-dispatch-map", ref: "gone.md" },
    { key: "plan-section-goal" },
  ];
  assert.deepEqual(
    planPosition({ rows, taskFiles: [3, 1, 2], cut: [5, 4, 3, 2, 1].map((num) => ({ num })), pack: true, refExists: (ref) => ref === "header.md" }),
    {
      strategy: "grouped", groupsDone: [2], nextGroup: 1, drafted: [1, 3], missing: [2, 4, 5], sections: ["goal", "header"], pack: true,
      next: "draft", steps: [{ id: "plan-assembled", status: "pending" }, { id: "checker-round-1", status: "pending" }, { id: "plan-gate", status: "pending" }],
    },
  );
});

test("before the cut there is no position, and once nothing is missing there is no next group", () => {
  assert.deepEqual(planPosition({ rows: [], taskFiles: [], cut: null, pack: false }), EMPTY);
  const rows = [{ key: "drafting-plan", data: { strategy: "checkpointed" } }, { key: "plan-draft-1" }, { key: "plan-group-2" }];
  assert.deepEqual(planPosition({ rows, taskFiles: [1], cut: [{ num: 1 }], pack: false }), {
    strategy: "checkpointed", groupsDone: [2], nextGroup: null, drafted: [1], missing: [], sections: [], pack: false, next: "assemble", steps: UNASSEMBLED,
  });
});

test("interrupting after group 1 and resuming from disk reaches the uninterrupted position and a byte-identical plan", () => {
  const straight = startRun();
  draftGroup(straight, 1, GROUPS[1]);
  const afterGroup1 = position(straight.root);
  assert.deepEqual(afterGroup1, {
    strategy: "checkpointed", groupsDone: [1], nextGroup: 2, drafted: [1, 2], missing: [3, 4, 5], sections: ["header"], pack: true, next: "draft", steps: UNASSEMBLED,
  });
  draftGroup(straight, 2, GROUPS[2]);
  draftGroup(straight, 3, GROUPS[3]);
  const straightPlan = finish(straight);

  const resumed = startRun();
  draftGroup(resumed, 1, GROUPS[1]);
  // The session ends inside group 2: Task 3's file is half written and its plan-draft row never logged.
  writeInto(resumed.root, `${WORK}/tasks/task-3.md`, "### Task 3: T3\n\n**Files:**\n");
  // The next session knows only what is on disk.
  let at = position(resumed.root);
  assert.deepEqual(at, afterGroup1);
  for (let guard = 0; guard < 3 && at.nextGroup !== null; guard++) {
    draftGroup(resumed, at.nextGroup, GROUPS[at.nextGroup].filter((num) => at.missing.includes(num)));
    at = position(resumed.root);
  }
  const resumedPlan = finish(resumed);
  assert.deepEqual(position(resumed.root), position(straight.root));
  assert.deepEqual(position(resumed.root), {
    strategy: "checkpointed", groupsDone: [1, 2, 3], nextGroup: null, drafted: [1, 2, 3, 4, 5], missing: [], sections: ["dispatch-map", "header"], pack: true,
    next: "assemble", steps: UNASSEMBLED,
  });
  assert.equal(resumedPlan, straightPlan);
});

test("the CLI reads the default cut, prints an empty position before drafting, and refuses bad input", () => {
  const root = makeTempDir("plan-resume-cli-");
  const devcycle = join(root, ".devcycle");
  const state = join(devcycle, "state.md");
  const log = (data) => logStep(devcycle, { run: RUN, stage: "planning", key: "drafting-plan", data });
  let r = resume();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^plan-resume: --state is required$/m);
  r = resume("--state", state, "extra");
  assert.equal(r.status, 2);
  r = resume("--state", state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-resume: no state file at .*state\.md$/m);
  writeInto(root, ".devcycle/state.md", "# devcycle state\n- stage: planning\n");
  r = resume("--state", state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-resume: .*state\.md names no run, so there is no planning position to resume$/m);
  writeInto(root, ".devcycle/state.md", STATE);
  assert.deepEqual(position(root), EMPTY);
  log({ strategy: "inline" });
  writeInto(root, `${WORK}/task-cut.json`, JSON.stringify(CUT.slice(0, 2)));
  assert.deepEqual(position(root), { ...EMPTY, strategy: "inline", nextGroup: 1, missing: [1, 2], next: "draft", steps: UNASSEMBLED });
  writeInto(root, `${WORK}/task-cut.json`, "not json");
  r = resume("--state", state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-resume: .*task-cut\.json: the cut is not valid JSON$/m);
  log({ strategy: "inline", cut: `${WORK}/gone.json` });
  r = resume("--state", state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-resume: no task cut at .*gone\.json$/m);
});

// Second-resolution stage-log stamps, so a test can order rows the way the log would.
const at = (second) => `2026-11-21T10:00:${String(second).padStart(2, "0")}Z`;
const row = (key, second, data) => ({ key, at: at(second), ...(data === undefined ? {} : { data }) });
const drafted = (strategy) => [row("drafting-plan", 0, { strategy }), row("plan-draft-1", 1)];
const after = (rows, extra = {}) => planPosition({ rows, taskFiles: [1], cut: [{ num: 1 }], pack: false, ...extra });
const view = ({ next, steps = [] }) => ({ next, steps: Object.fromEntries(steps.map(({ id, status }) => [id, status])) });
const MATCHES = { assembled: { matches: true } };

test("inline: the assembly is done only when it follows every draft and still matches, then the gate, then present", () => {
  const rows = drafted("inline");
  assert.deepEqual(view(after(rows)), { next: "assemble", steps: { "plan-assembled": "pending", "plan-gate": "pending" } });
  assert.deepEqual(view(after(rows, { planOnDisk: true })), { next: "assemble", steps: { "plan-assembled": "ambiguous", "plan-gate": "pending" } });
  const assembled = [...rows, row("plan-assembled", 2, { sha256: "h" })];
  assert.deepEqual(view(after(assembled, MATCHES)), { next: "gate", steps: { "plan-assembled": "done", "plan-gate": "pending" } });
  assert.equal(view(after(assembled, { assembled: { matches: false } })).steps["plan-assembled"], "redo", "the plan or the work files changed since");
  assert.equal(view(after(assembled)).steps["plan-assembled"], "redo", "a row with no assembly check is not trusted");
  const stale = [rows[0], row("plan-assembled", 1, { sha256: "h" }), row("plan-draft-1", 2)];
  assert.deepEqual(view(after(stale, MATCHES)), { next: "assemble", steps: { "plan-assembled": "redo", "plan-gate": "pending" } });
  const tie = [rows[0], row("plan-draft-1", 1), row("plan-assembled", 1, { sha256: "h" })];
  assert.equal(view(after(tie, MATCHES)).steps["plan-assembled"], "done", "a tie on the stamp falls back to the log's order");
  const tieStale = [rows[0], row("plan-assembled", 1, { sha256: "h" }), row("plan-draft-1", 1)];
  assert.equal(view(after(tieStale, MATCHES)).steps["plan-assembled"], "redo");
  assert.deepEqual(view(after([...assembled, row("plan-gate", 3, { exit: 1 })], MATCHES)), { next: "gate", steps: { "plan-assembled": "done", "plan-gate": "re-verify" } });
  assert.deepEqual(view(after([...assembled, row("plan-gate", 3, { exit: 0 })], MATCHES)), { next: "present", steps: { "plan-assembled": "done", "plan-gate": "re-verify" } });
  const gateBefore = [...rows, row("plan-gate", 2, { exit: 0 }), row("plan-assembled", 3, { sha256: "h" })];
  assert.equal(after(gateBefore, MATCHES).next, "gate", "a pass before the latest assembly gates the old plan");
  assert.equal(after([...drafted("checkpointed"), row("plan-assembled", 2, { sha256: "h" })], MATCHES).next, "gate", "checkpointed is inline: no checker round");
});

test("checker path: a round is done when every batch file is filled, and findings add a repair that a re-assembly closes", () => {
  for (const strategy of ["delegated", "grouped", "grouped-fork"])
    assert.deepEqual(Object.keys(view(after(drafted(strategy))).steps), ["plan-assembled", "checker-round-1", "plan-gate"], strategy);
  const assembled = [...drafted("grouped"), row("plan-assembled", 2, { sha256: "h" })];
  const checked = (findings) => [...assembled, row("checker-round-1", 3, { findings })];
  const round = (expected, filled) => ({ ...MATCHES, checker: new Map([[1, { expected, filled }]]) });
  assert.deepEqual(view(after(assembled, MATCHES)), { next: "checker", steps: { "plan-assembled": "done", "checker-round-1": "pending", "plan-gate": "pending" } });
  assert.equal(view(after(assembled, round(2, 1))).steps["checker-round-1"], "ambiguous", "batch files without the round's row");
  assert.deepEqual(view(after(checked(0), round(2, 1))), { next: "checker", steps: { "plan-assembled": "done", "checker-round-1": "redo", "plan-gate": "pending" } });
  assert.deepEqual(view(after(assembled, round(0, 0))), { next: "gate", steps: { "plan-assembled": "done", "checker-round-1": "done", "plan-gate": "pending" } },
    "a round with no edge to check has nothing to dispatch");
  assert.equal(view(after(checked(0), MATCHES)).steps["checker-round-1"], "redo", "a row with no round directory");
  assert.deepEqual(view(after(checked(0), round(2, 2))), { next: "gate", steps: { "plan-assembled": "done", "checker-round-1": "done", "plan-gate": "pending" } });
  assert.deepEqual(view(after(checked(3), round(2, 2))), {
    next: "repair", steps: { "plan-assembled": "done", "checker-round-1": "done", "plan-repair-1": "pending", "plan-gate": "pending" },
  });
  const repaired = [...checked(3), row("plan-repair-1", 4, { tasks: [1], findings: 3 })];
  assert.deepEqual(view(after(repaired, round(2, 2))), {
    next: "assemble", steps: { "plan-assembled": "redo", "checker-round-1": "done", "plan-repair-1": "redo", "plan-gate": "pending" },
  });
  // The re-assembly appends the key's newer line, so readStage returns it last.
  const reassembled = [...repaired.filter(({ key }) => key !== "plan-assembled"), row("plan-assembled", 5, { sha256: "h2" })];
  assert.deepEqual(view(after(reassembled, round(2, 2))), {
    next: "gate", steps: { "plan-assembled": "done", "checker-round-1": "done", "plan-repair-1": "done", "plan-gate": "pending" },
  });
  assert.equal(after([...reassembled, row("plan-gate", 6, { exit: 0 })], round(2, 2)).next, "present");
});

test("thorough is read from the profile: no plan drafts, a plan gates, and a passing gate row presents", () => {
  const thorough = (rows, planOnDisk) => view(planPosition({ rows, taskFiles: [], cut: null, pack: false, profile: "thorough", planOnDisk }));
  assert.deepEqual(thorough([], false), { next: "draft", steps: { "plan-gate": "pending" } });
  assert.deepEqual(thorough([], true), { next: "gate", steps: { "plan-gate": "pending" } });
  assert.deepEqual(thorough([row("plan-gate", 1, { exit: 1 })], true), { next: "gate", steps: { "plan-gate": "re-verify" } });
  assert.deepEqual(thorough([row("plan-gate", 1, { exit: 0 })], true), { next: "present", steps: { "plan-gate": "re-verify" } });
  const cutButNoTaskFiles = planPosition({ rows: drafted("inline"), taskFiles: [], cut: [{ num: 1 }], pack: false, profile: "thorough", planOnDisk: true });
  assert.equal(cutButNoTaskFiles.next, "gate", "the sub-skill writes no task file, so missing drafts do not hold a thorough plan");
});

test("a lean run stopped before its cut drafts next, with no drafting row and no cut", () => {
  const rows = [row("feasibility-verdict", 1), row("research-map", 2)];
  assert.deepEqual(view(planPosition({ rows, taskFiles: [], cut: null, pack: false, profile: "lean" })), {
    next: "draft", steps: { "plan-assembled": "pending", "plan-gate": "pending" },
  });
});

// A grouped run with every task drafted, Task 2 consuming Task 1, so the checker has one batch.
function draftedRun() {
  const run = startRun();
  run.log("drafting-plan", { data: { strategy: "grouped", groups: 1, drafters: 1, est: 1, cut: `${WORK}/task-cut.json` } });
  writeInto(run.root, `${WORK}/task-cut.json`, JSON.stringify(CUT.slice(0, 2)));
  writeInto(run.root, `${WORK}/tasks/task-1.md`, taskText(1));
  writeInto(run.root, `${WORK}/tasks/task-2.md`, taskText(2).replace("**Dependencies:** none", "**Dependencies:** Task 1 (consumes f1)"));
  for (const num of [1, 2]) run.log(`plan-draft-${num}`, { ref: `${WORK}/tasks/task-${num}.md` });
  writeInto(run.root, `${WORK}/dispatch-map.md`, "## Dispatch Map\n\n- Wave 1: Task 1\n- Wave 2: Task 2 (needs Task 1 committed)\n");
  return { ...run, state: join(run.root, ".devcycle/state.md"), plan: join(run.root, "plan.md") };
}
const assemble = ({ root, state, plan }, withState = true) => {
  const r = spawnSync("node", [ASSEMBLE, join(root, WORK), "--out", plan, ...(withState ? ["--state", state] : [])], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

test("readPlanPosition checks the logged assembly against the plan on disk and a fresh assembly, and counts the round's batch files", () => {
  const run = draftedRun();
  const steps = () => view(readPlanPosition(run.state));
  assert.deepEqual(steps(), { next: "assemble", steps: { "plan-assembled": "pending", "checker-round-1": "pending", "plan-gate": "pending" } });
  assemble(run, false);
  writeFileSync(run.state, `${STATE}- plan: plan.md\n`);
  assert.equal(steps().steps["plan-assembled"], "ambiguous", "a plan on plan: with no plan-assembled row");
  assemble(run);
  assert.deepEqual(steps(), { next: "checker", steps: { "plan-assembled": "done", "checker-round-1": "pending", "plan-gate": "pending" } });
  const task2 = readFileSync(join(run.root, `${WORK}/tasks/task-2.md`), "utf8");
  writeInto(run.root, `${WORK}/tasks/task-2.md`, `${task2}- [ ] an edit after the assembly\n`);
  assert.equal(steps().steps["plan-assembled"], "redo", "the work files no longer assemble to the plan");
  writeInto(run.root, `${WORK}/tasks/task-2.md`, task2);
  writeFileSync(run.plan, `${readFileSync(run.plan, "utf8")}tampered\n`);
  assert.equal(steps().steps["plan-assembled"], "redo", "the plan on disk no longer has the logged hash");
  assemble(run);
  const batch = `${WORK}/checker/round-1/batch-1.md`;
  writeInto(run.root, batch, "");
  assert.equal(steps().steps["checker-round-1"], "pending", "an empty batch file is no finished batch");
  writeInto(run.root, batch, "0 findings\n");
  assert.equal(steps().steps["checker-round-1"], "ambiguous", "a filled batch file without the round's row");
  writeInto(run.root, batch, "");
  run.log("checker-round-1", { ref: `${WORK}/checker/round-1`, data: { findings: 0 } });
  assert.equal(steps().steps["checker-round-1"], "redo", "the round's row with its batch file still empty");
  writeInto(run.root, batch, "0 findings\n");
  assert.deepEqual(steps(), { next: "gate", steps: { "plan-assembled": "done", "checker-round-1": "done", "plan-gate": "pending" } });
  run.log("plan-gate", { data: { exit: 0 } });
  assert.equal(steps().next, "present");
  assert.deepEqual(readPlanPosition(run.state).drafted, [1, 2]);
  writeFileSync(run.state, `${STATE}- plan: plan.md\n- knobs: profile=thorough gitPolicy=commit\n`);
  assert.deepEqual(steps(), { next: "present", steps: { "plan-gate": "re-verify" } }, "the knobs: line's profile picks the thorough path");
  // This test file exists, and sits outside the run's checkout.
  writeFileSync(run.state, `${STATE}- plan: ${relative(run.root, fileURLToPath(import.meta.url))}\n- knobs: profile=thorough\n`);
  assert.equal(steps().next, "draft", "a plan: path outside the checkout's root is not this run's plan");
});

test("readPlanPosition throws the CLI's messages instead of exiting", () => {
  const root = makeTempDir("plan-resume-throw-");
  const state = join(root, ".devcycle/state.md");
  assert.throws(() => readPlanPosition(state), { message: `no state file at ${state}` });
  writeInto(root, ".devcycle/state.md", "# devcycle state\n- stage: planning\n");
  assert.throws(() => readPlanPosition(state), { message: `${state} names no run, so there is no planning position to resume` });
  writeInto(root, ".devcycle/state.md", STATE);
  writeInto(root, `${WORK}/task-cut.json`, "not json");
  assert.throws(() => readPlanPosition(state), { message: /task-cut\.json: the cut is not valid JSON$/ });
});

test("pathInsideRoot names a path under the root, and nothing for the root itself or a path outside it", () => {
  const root = makeTempDir("plan-resume-root-");
  assert.equal(pathInsideRoot(root, "..notes.md"), join(root, "..notes.md"), "a name starting with two dots is still inside");
  assert.equal(pathInsideRoot(root, "docs/p.md"), join(root, "docs/p.md"));
  assert.equal(pathInsideRoot(root, "."), null);
  assert.equal(pathInsideRoot(root, "../x"), null);
  assert.equal(pathInsideRoot(root, fileURLToPath(import.meta.url)), null, "an absolute path outside the root");
});
