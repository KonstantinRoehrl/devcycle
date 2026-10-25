// scripts/drive-progress.mjs builds the drive band's data file from scripts/wave-setup.mjs's planProgress:
// the run state the driver holds, and per wave each task's band step, review round and rejection count.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { parseLedgerLine } from "../../scripts/task-ledger.mjs";
import { buildProgress, PROGRESS_REL, removeProgress, writeProgress } from "../../scripts/drive-progress.mjs";
import { planProgress, taskPosition } from "../../scripts/wave-setup.mjs";
import { writeInto } from "./helpers.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RUN = { state: "running", session: 4, model: "claude-opus-5-5", effort: "high", startedAt: "2026-10-25T08:00:00Z",
  waitUntil: null, waitWhat: null, stopDetail: null, outcome: null };
const entry = (task, event, outcome, key = "") =>
  parseLedgerLine(`- [2026-10-25T08:00:00Z] task=${task} event=${event} outcome=${outcome} ref=none${key ? ` key=${key}` : ""}`);
const PLAN = [
  "# Fixture plan", "",
  "### Task 1: first", "", "**Files:**", "- Modify: src/a.txt", "",
  "### Task 2: second", "", "**Files:**", "- Modify: src/b.txt", "",
  "### Task 3: third", "", "**Files:**", "- Modify: src/c.txt", "",
  "## Dispatch Map", "",
  "- Wave 1: Task 1, Task 2 (no dependencies)",
  "- Wave 2: Task 3 (needs Tasks 1+2 committed)", "",
].join("\n");

function makeRoot({ ledgerPlan = "docs/plan.md", plan = PLAN, statePlan = "docs/plan.md", lines = [] } = {}) {
  const root = makeTempDir("devcycle-drive-progress-");
  writeInto(root, "docs/plan.md", plan);
  writeInto(root, ".devcycle/state.md", `# devcycle state\n- stage: execution\n- plan: ${statePlan}\n- run: 0123456789abcdef\n`);
  writeInto(root, ".devcycle/ledger.md", `Plan: \`${ledgerPlan}\`\n\n${lines.map((l) => `- [2026-10-25T08:00:00Z] ${l}\n`).join("")}`);
  return root;
}

test("each wave-setup position reads as its band step, and every other position as needs-user", () => {
  const steps = {
    "not-dispatched": "pending", dispatched: "implementing", "missing-report": "implementing",
    "report-received": "reviewing", "review-round": "reviewing", "missing-findings": "reviewing",
    rejected: "fixing", "intake-bounce": "fixing", accepted: "committing", deferred: "committing", committed: "committed",
    "exhausted-unresolved": "needs-user", "sweep-decision": "needs-user", "sweep-dispatched": "needs-user",
    "user-decision": "needs-user", "retry-cap": "needs-user", blocked: "needs-user", unknown: "needs-user",
  };
  const positions = Object.keys(steps);
  const tasks = positions.map((_, i) => String(i + 1));
  const plan = {
    overview: { waves: 1, tasks: tasks.length, committed: 1, nextWave: 1, perWave: [{ wave: 1, tasks, committed: 1 }] },
    positions: new Map(positions.map((position, i) => [String(i + 1), { position, next: "x" }])),
    entries: new Map(),
  };
  const progress = buildProgress({ run: RUN, plan });
  assert.deepEqual(progress.waves.flatMap((w) => w.tasks.map((t) => t.step)), Object.values(steps));
});

test("a task's round is its latest review round, and its rejections count reviewer and gate rejections and intake bounces, never a missing findings file", () => {
  const seven = [
    entry(7, "dispatched", "model sonnet"), entry(7, "report-received", "complete"),
    entry(7, "review-round", "round 1", "7/review-round/1/0"), entry(7, "review-verdict", "rejected", "7/review-verdict/1/0"),
    entry(7, "report-received", "rejected (intake bounce)", "7/report-received/2/0"),
    entry(7, "review-round", "round 2", "7/review-round/2/0"), entry(7, "review-verdict", "rejected (missing findings file)", "7/review-verdict/2/0"),
    entry(7, "review-round", "round 2", "7/review-round/2/1"), entry(7, "review-verdict", "rejected (green gate: exit 1)", "7/review-verdict/2/1"),
  ];
  const plan = {
    overview: { waves: 2, tasks: 3, committed: 1, nextWave: 2,
      perWave: [{ wave: 1, tasks: ["6"], committed: 1 }, { wave: 2, tasks: ["7", "8"], committed: 0 }] },
    positions: new Map([["6", { position: "committed", next: "done" }], ["7", { position: "rejected", next: "fix" }],
      ["8", { position: "not-dispatched", next: "dispatch-implementer" }]]),
    entries: new Map([["6", [entry(6, "committed", "green gate passed")]], ["7", seven], ["8", []]]),
  };
  const { updatedAt, ...progress } = buildProgress({ run: RUN, plan });
  assert.deepEqual(progress, { v: 1, ...RUN, currentWave: 2, committed: 1, total: 3, waves: [
    { wave: 1, committed: 1, tasks: [{ task: "6", step: "committed", round: 0, rejections: 0 }] },
    { wave: 2, committed: 0, tasks: [{ task: "7", step: "fixing", round: 2, rejections: 3 }, { task: "8", step: "pending", round: 0, rejections: 0 }] },
  ] });
  assert.match(updatedAt, ISO);
});

// The step buildProgress reports for one task whose ledger lines are `entries`, positioned as wave-setup positions them.
const stepOf = (entries) => {
  const plan = {
    overview: { waves: 1, tasks: 1, committed: 0, nextWave: 1, perWave: [{ wave: 1, tasks: ["9"], committed: 0 }] },
    positions: new Map([["9", taskPosition(entries)]]), entries: new Map([["9", entries]]),
  };
  return buildProgress({ run: RUN, plan }).waves[0].tasks[0];
};

test("an implementer dispatched after a rejection or an intake bounce is a fix pass, fixing for its whole run; a first dispatch stays implementing", () => {
  const reviewed = [
    entry(9, "dispatched", "model sonnet"), entry(9, "report-received", "complete"),
    entry(9, "review-round", "round 1", "9/review-round/1/0"), entry(9, "review-verdict", "rejected", "9/review-verdict/1/0"),
  ];
  assert.deepEqual(stepOf([...reviewed, entry(9, "dispatched", "model sonnet", "9/dispatched/2/0")]),
    { task: "9", step: "fixing", round: 1, rejections: 1 });
  assert.deepEqual(stepOf([entry(9, "dispatched", "model sonnet"), entry(9, "report-received", "rejected (intake bounce)", "9/report-received/1/0"),
    entry(9, "dispatched", "model sonnet", "9/dispatched/2/0")]), { task: "9", step: "fixing", round: 0, rejections: 1 });
  assert.deepEqual(stepOf([entry(9, "dispatched", "model sonnet")]), { task: "9", step: "implementing", round: 0, rejections: 0 });
  assert.equal(stepOf([...reviewed, entry(9, "dispatched", "model sonnet", "9/dispatched/2/0"), entry(9, "report-received", "complete", "9/report-received/2/0")]).step, "reviewing");
});

test("with no usable plan the file still carries the run state, with no waves", () => {
  const { updatedAt, ...progress } = buildProgress({ run: { ...RUN, state: "ended", outcome: "complete" }, plan: null });
  assert.deepEqual(progress, { v: 1, ...RUN, state: "ended", outcome: "complete", currentWave: null, committed: 0, total: 0, waves: [] });
  assert.match(updatedAt, ISO);
});

test("writeProgress writes the object and a newline into .devcycle with no temp file left, and removeProgress removes it, present or not", () => {
  const root = makeTempDir("devcycle-drive-progress-");
  try {
    writeInto(root, ".devcycle/state.md", "# devcycle state\n");
    const progress = buildProgress({ run: RUN, plan: null });
    writeProgress(root, progress);
    const path = join(root, ".devcycle", "drive-progress.json");
    assert.equal(join(root, PROGRESS_REL), path);
    assert.equal(existsSync(path), true, "no progress file was written");
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(progress) + "\n");
    assert.deepEqual(readdirSync(join(root, ".devcycle")).sort(), ["drive-progress.json", "state.md"], "a temp file was left behind");
    removeProgress(root);
    assert.equal(existsSync(path), false);
    removeProgress(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planProgress is wave-setup's overview with every Dispatch Map task's position and ledger lines", () => {
  const root = makeRoot({ lines: ["task=1 event=committed outcome=green gate passed ref=abc1234", "task=2 event=dispatched outcome=model sonnet ref=none"] });
  try {
    const plan = planProgress({ root, statePath: join(root, ".devcycle", "state.md") });
    assert.ok(plan, "planProgress returned null for a usable plan and ledger");
    assert.deepEqual(plan.overview, { waves: 2, tasks: 3, committed: 1, nextWave: 1,
      perWave: [{ wave: 1, tasks: ["1", "2"], committed: 1 }, { wave: 2, tasks: ["3"], committed: 0 }] });
    assert.deepEqual([...plan.positions].map(([task, p]) => [task, p.position]), [["1", "committed"], ["2", "dispatched"], ["3", "not-dispatched"]]);
    assert.deepEqual([...plan.entries].map(([task, lines]) => [task, lines.map((l) => l.event)]), [["1", ["committed"]], ["2", ["dispatched"]], ["3", []]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planProgress is null for a ledger another plan wrote, a state naming no plan, or a plan with no Dispatch Map", () => {
  const roots = [
    makeRoot({ ledgerPlan: "docs/other-plan.md" }),
    makeRoot({ statePlan: "none" }),
    makeRoot({ plan: PLAN.slice(0, PLAN.indexOf("## Dispatch Map")) }),
  ];
  try {
    for (const root of roots) assert.equal(planProgress({ root, statePath: join(root, ".devcycle", "state.md") }), null, root);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});
