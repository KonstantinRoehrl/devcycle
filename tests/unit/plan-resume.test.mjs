import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { logStep } from "../../scripts/stage-log.mjs";
import { planPosition } from "../../scripts/plan-resume.mjs";
import { writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/plan-resume.mjs", import.meta.url).pathname;
const ASSEMBLE = new URL("../../scripts/plan-assemble.mjs", import.meta.url).pathname;
const RUN = "00000000000000c5";
const WORK = `.devcycle/plan-work/${RUN}`;
const STATE = `# devcycle state\n- stage: planning\n- run: ${RUN}\n`;
const GROUPS = { 1: [1, 2], 2: [3, 4], 3: [5] };
const CUT = [1, 2, 3, 4, 5].map((num) => ({ num, wave: num < 3 ? 1 : num < 5 ? 2 : 3, deps: [], files: [`f${num}.mjs`], produces: 1 }));
const EMPTY = { strategy: null, groupsDone: [], nextGroup: null, drafted: [], missing: [], sections: [], pack: false };
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
    { strategy: "grouped", groupsDone: [2], nextGroup: 1, drafted: [1, 3], missing: [2, 4, 5], sections: ["goal", "header"], pack: true },
  );
});

test("before the cut there is no position, and once nothing is missing there is no next group", () => {
  assert.deepEqual(planPosition({ rows: [], taskFiles: [], cut: null, pack: false }), EMPTY);
  const rows = [{ key: "drafting-plan", data: { strategy: "checkpointed" } }, { key: "plan-draft-1" }, { key: "plan-group-2" }];
  assert.deepEqual(planPosition({ rows, taskFiles: [1], cut: [{ num: 1 }], pack: false }), {
    strategy: "checkpointed", groupsDone: [2], nextGroup: null, drafted: [1], missing: [], sections: [], pack: false,
  });
});

test("interrupting after group 1 and resuming from disk reaches the uninterrupted position and a byte-identical plan", () => {
  const straight = startRun();
  draftGroup(straight, 1, GROUPS[1]);
  const afterGroup1 = position(straight.root);
  assert.deepEqual(afterGroup1, {
    strategy: "checkpointed", groupsDone: [1], nextGroup: 2, drafted: [1, 2], missing: [3, 4, 5], sections: ["header"], pack: true,
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
  assert.deepEqual(position(root), { ...EMPTY, strategy: "inline", nextGroup: 1, missing: [1, 2] });
  writeInto(root, `${WORK}/task-cut.json`, "not json");
  r = resume("--state", state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-resume: .*task-cut\.json: the cut is not valid JSON$/m);
  log({ strategy: "inline", cut: `${WORK}/gone.json` });
  r = resume("--state", state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-resume: no task cut at .*gone\.json$/m);
});
