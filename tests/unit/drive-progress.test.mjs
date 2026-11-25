// scripts/drive-progress.mjs builds the drive band's data file from scripts/wave-setup.mjs's planProgress:
// the run state the driver holds, and per wave each task's band step, review round and rejection count.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { parseLedgerLine } from "../../scripts/task-ledger.mjs";
import { buildProgress, PROGRESS_REL, removeProgress, routingLabel, writeProgress } from "../../scripts/drive-progress.mjs";
import { windowFor } from "../../scripts/depth-bands.mjs";
import { planProgress, taskPosition } from "../../scripts/wave-setup.mjs";
import { writeInto } from "./helpers.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RUN = { state: "running", session: 4, model: "claude-opus-5-5", effort: "high", startedAt: "2026-10-25T08:00:00Z",
  waitUntil: null, waitWhat: null, stopDetail: null, outcome: null };
const { session: _session, model: _model, effort: _effort, ...RUN_HEAD } = RUN;
const FALLBACK_DRIVER = { model: "claude-opus-5-5", effort: "high", watcher: false };
const windowOf = (model) => windowFor(model).window;
const entry = (task, event, outcome, key = "") =>
  parseLedgerLine(`- [2026-10-25T08:00:00Z] task=${task} event=${event} outcome=${outcome} ref=none${key ? ` key=${key}` : ""}`);
const UNPARSEABLE = "rejected (unparseable findings file: no verdict line)";
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

test("a task's round is its latest review round, and its rejections count reviewer and gate rejections and intake bounces, never a findings file with no verdict", () => {
  for (const noVerdict of ["rejected (missing findings file)", UNPARSEABLE]) {
    const seven = [
      entry(7, "dispatched", "model sonnet"), entry(7, "report-received", "complete"),
      entry(7, "review-round", "round 1", "7/review-round/1/0"), entry(7, "review-verdict", "rejected", "7/review-verdict/1/0"),
      entry(7, "report-received", "rejected (intake bounce)", "7/report-received/2/0"),
      entry(7, "review-round", "round 2", "7/review-round/2/0"), entry(7, "review-verdict", noVerdict, "7/review-verdict/2/0"),
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
    assert.deepEqual(progress, { v: 2, ...RUN_HEAD, driver: FALLBACK_DRIVER, session: null, currentWave: 2, committed: 1, total: 3, waves: [
      { wave: 1, committed: 1, tasks: [{ task: "6", step: "committed", round: 0, rejections: 0 }] },
      { wave: 2, committed: 0, tasks: [{ task: "7", step: "fixing", round: 2, rejections: 3 }, { task: "8", step: "pending", round: 0, rejections: 0 }] },
    ] }, noVerdict);
    assert.match(updatedAt, ISO);
  }
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
  assert.deepEqual(progress, { v: 2, ...RUN_HEAD, driver: FALLBACK_DRIVER, session: null, state: "ended", outcome: "complete", currentWave: null, committed: 0, total: 0, waves: [] });
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

test("a dispatch that ended without its output shows its role's step until it is redispatched; past the cap it waits on a person", () => {
  const dispatched = entry(5, "dispatched", "model x", "5/dispatched/0/0");
  const dead = (role, retry) => entry(5, "dispatch-ended", `without output (${role})`, `5/dispatch-ended/0/${retry}`);
  assert.equal(stepOf([dispatched, dead("implementer", 0)]).step, "implementing");
  assert.equal(stepOf([dispatched, dead("reviewer", 0)]).step, "reviewing");
  assert.equal(stepOf([dispatched, dead("implementer", 0), dead("implementer", 1)]).step, "needs-user");
});

test("a task the heartbeat measured carries its health; the rest are unchanged", () => {
  const root = makeRoot({ lines: ["task=1 event=dispatched outcome=model x ref=none key=1/dispatched/0/0"] });
  const health = new Map([["1", { state: "quiet", elapsedMs: 900_000, toolUses: 4, sinceActivityMs: 880_000 }]]);
  const p = buildProgress({ run: RUN, plan: planProgress({ root, statePath: join(root, ".devcycle/state.md") }), health });
  const [one, two] = p.waves[0].tasks;
  assert.deepEqual(one.health, { state: "quiet", elapsedMs: 900_000, toolUses: 4, sinceActivityMs: 880_000 });
  assert.equal("health" in two, false);
});

test("routingLabel maps each ledger routing outcome to its band label and drops every other form", () => {
  const cases = [
    ["model fast:claude-haiku-5-5 (auto: lines=40, files=2)", "fast"],
    ["model fast (auto: lines=40, files=2)", "fast"],
    ["model model fast:claude-haiku-5-5 (auto: lines=40, files=2)", "fast"],
    ["model session (auto: escalated on deps=Tasks 1+3)", "esc deps=Tasks 1+3"],
    ["model session (auto: escalated on lines=520, files=7)", "esc lines=520, files=7"],
    ["model session (auto)", "session"],
    ["model session (auto: no file list)", "session"],
    ["model claude-sonnet-5-5 (pinned)", "pinned"],
    ["model claude-sonnet-5-5 (pinned, clamped from claude-opus-5-5)", "pinned, clamped"],
    ["model claude-sonnet-5-5 (pooled: rung 2/3)", "pool 2/3"],
    ["model claude-sonnet-5-5 (pooled: rung 2/3, clamped from claude-opus-5-5)", "pool 2/3 + clamped"],
    ["model session (ceiling: claude-foo-9 unranked)", "ceiling"],
    ["model session (ceiling: no rung at or below claude-opus-5-5)", "ceiling"],
    ["model session (escalated, unreachable and unranked)", null],
    ["model claude-opus-5-5 (escalated, session unreachable: explicit override)", null],
    ["model sonnet", null], ["model x", null], ["round 2", null], ["implementer retry 1", null],
    ["", null], [null, null], [undefined, null],
  ];
  for (const [outcome, label] of cases) assert.equal(routingLabel(outcome), label, String(outcome));
});

test("v2 carries the driver session and the live driven session as their own tiers, a window only where windowFor knows one", () => {
  const p = buildProgress({ run: RUN, plan: null, tiers: {
    driver: { watcher: true, model: "claude-opus-5-5", effort: "xhigh", tokens: 230_100 },
    session: { startedAt: "2026-10-25T08:10:00Z", model: "claude-sonnet-5-5", tokens: 182_400 },
  } });
  assert.equal(p.v, 2);
  for (const gone of ["model", "effort"]) assert.equal(gone in p, false, `v2's head has no ${gone}: the tiers carry it`);
  assert.deepEqual(p.driver, { model: "claude-opus-5-5", effort: "xhigh", tokens: 230_100, window: windowOf("claude-opus-5-5"), watcher: true });
  assert.deepEqual(p.session, { n: 4, startedAt: "2026-10-25T08:10:00Z", model: "claude-sonnet-5-5", effort: "high", tokens: 182_400, window: windowOf("claude-sonnet-5-5") });
  const assumed = buildProgress({ run: RUN, plan: null, tiers: { driver: { watcher: true, model: "gpt-x", tokens: 5000 } } });
  assert.deepEqual(assumed.driver, { model: "gpt-x", tokens: 5000, window: 1_000_000, windowAssumed: true, watcher: true });
  const unknown = buildProgress({ run: RUN, plan: null, tiers: { driver: { watcher: true, model: "claude-sonnet-3-5", tokens: 5000 } } });
  assert.deepEqual(unknown.driver, { model: "claude-sonnet-3-5", tokens: 5000, watcher: true });
  const bare = buildProgress({ run: RUN, plan: null, tiers: { driver: { watcher: true, model: "claude-opus-5-5", effort: null, tokens: null } } });
  assert.deepEqual(bare.driver, { model: "claude-opus-5-5", watcher: true });
});

test("with no watcher the driver row is the drive row's model and effort, and a default effort is left out", () => {
  const none = buildProgress({ run: RUN, plan: null });
  assert.deepEqual([none.driver, none.session], [FALLBACK_DRIVER, null]);
  const dflt = buildProgress({ run: { ...RUN, effort: "default" }, plan: null, tiers: { driver: null, session: { startedAt: "2026-10-25T08:10:00Z" } } });
  assert.deepEqual(dflt.driver, { model: "claude-opus-5-5", watcher: false });
  assert.deepEqual(dflt.session, { n: 4, startedAt: "2026-10-25T08:10:00Z", model: "claude-opus-5-5" });
});

test("a running or quiet dispatch carries its model, effort, depth and the routing of its role's latest line; any other health carries none", () => {
  const root = makeRoot({ lines: [
    "task=1 event=dispatched outcome=model fast:claude-haiku-5-5 (auto: lines=40, files=2) ref=none",
    "task=2 event=dispatched outcome=model session (auto) ref=none",
    "task=2 event=report-received outcome=complete ref=none",
    "task=2 event=review-round outcome=model session (auto: escalated on lines=520, files=7) ref=none key=2/review-round/1/0",
  ] });
  const plan = planProgress({ root, statePath: join(root, ".devcycle/state.md") });
  const live = (state, role, over = {}) => ({ state, elapsedMs: 180_000, toolUses: 9, sinceActivityMs: 4000, role,
    model: "claude-sonnet-5-5", effort: "high", tokens: 36_000, ...over });
  const [one, two] = buildProgress({ run: RUN, plan, health: new Map([["1", live("running", "implementer")], ["2", live("quiet", "reviewer")]]) }).waves[0].tasks;
  assert.deepEqual(one.health, { state: "running", elapsedMs: 180_000, toolUses: 9, sinceActivityMs: 4000 });
  assert.deepEqual(one.dispatch, { role: "implementer", model: "claude-sonnet-5-5", effort: "high", tokens: 36_000, window: windowOf("claude-sonnet-5-5"), routing: "fast" });
  assert.equal(two.dispatch.routing, "esc lines=520, files=7");
  const unrouted = buildProgress({ run: RUN, plan, health: new Map([["2", live("running", "implementer", { model: null, effort: null, tokens: null })]]) }).waves[0].tasks[1];
  assert.deepEqual(unrouted.dispatch, { role: "implementer", routing: "session" });
  for (const state of ["ended-with-output", "ended-without-output", "unbound"]) {
    const t = buildProgress({ run: RUN, plan, health: new Map([["1", live(state, "implementer")]]) }).waves[0].tasks[0];
    assert.equal("dispatch" in t, false, state);
    assert.equal(t.health.state, state);
  }
});

test("a reviewer whose latest review-round line carries no routing decision draws no routing, even after one that did", () => {
  const root = makeRoot({ lines: [
    "task=1 event=dispatched outcome=model session (auto) ref=none",
    "task=1 event=report-received outcome=complete ref=none",
    "task=1 event=review-round outcome=model fast (auto: lines=10, files=1) ref=none key=1/review-round/1/0",
    "task=1 event=review-verdict outcome=rejected ref=none key=1/review-verdict/1/0",
    "task=1 event=review-round outcome=round 2 ref=none key=1/review-round/2/0",
  ] });
  const plan = planProgress({ root, statePath: join(root, ".devcycle/state.md") });
  const health = new Map([["1", { state: "running", elapsedMs: 1000, toolUses: 1, sinceActivityMs: 0, role: "reviewer", model: "claude-sonnet-5-5" }]]);
  const [one] = buildProgress({ run: RUN, plan, health }).waves[0].tasks;
  assert.deepEqual(one.dispatch, { role: "reviewer", model: "claude-sonnet-5-5" });
});
