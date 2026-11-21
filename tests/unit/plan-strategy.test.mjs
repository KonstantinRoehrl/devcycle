import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { THRESHOLDS, PROFILE, taskWeight, cutMetrics, groupCut, chooseStrategy, parseCut } from "../../scripts/plan-strategy.mjs";
import * as planCost from "../../scripts/plan-cost.mjs";

const SCRIPT = new URL("../../scripts/plan-strategy.mjs", import.meta.url).pathname;
const task = (num, wave, { deps = [], files = [`f${num}.mjs`, `t${num}.mjs`, `g${num}.mjs`], produces = 2, ...flags } = {}) =>
  ({ num, wave, deps, files, produces, ...flags });
// Tasks numbered consecutively, `sizes[i]` of them in wave i + 1; each later-wave task depends on the first task of the wave before.
function wideCut(sizes) {
  const cut = [];
  let num = 0;
  let previousFirst = null;
  sizes.forEach((size, i) => {
    const first = num + 1;
    for (let j = 0; j < size; j++) cut.push(task(++num, i + 1, { deps: i === 0 ? [] : [previousFirst] }));
    previousFirst = first;
  });
  return cut;
}

test("a task weighs its files plus its produced interfaces, doubled when code-pinned", () => {
  assert.equal(taskWeight(task(1, 1)), 5);
  assert.equal(taskWeight(task(1, 1, { codePinned: true })), 10);
});

test("cutMetrics reports task count, weight, coupling and width", () => {
  const cut = [
    task(1, 1, { files: ["a"], produces: 1 }), task(2, 1, { files: ["b"], produces: 1 }),
    task(3, 2, { deps: [1], files: ["c"], produces: 0 }), task(4, 2, { files: ["a"], produces: 1 }),
  ];
  assert.deepEqual(cutMetrics(cut), { n: 4, e: 7, coupling: 0.75, width: 2, waves: 2 });
});

test("auto keeps a cut of 12 tasks or fewer inline, and a light cut of up to 25", () => {
  assert.equal(chooseStrategy(wideCut([12])).strategy, "inline");
  const light = Array.from({ length: 20 }, (_, i) => task(i + 1, 1, { files: [`l${i}`], produces: 0 }));
  const r = chooseStrategy(light);
  assert.deepEqual([r.strategy, r.metrics.e], ["inline", 20]);
});

test("auto checkpoints a coupled or narrow cut above the inline range", () => {
  assert.equal(chooseStrategy(wideCut(Array(14).fill(1))).strategy, "checkpointed");
  assert.equal(chooseStrategy(wideCut([3, 3, 3, 3, 3])).strategy, "checkpointed");
});

test("auto groups a wide, loosely coupled cut", () => {
  const r = chooseStrategy(wideCut([9, 6]));
  assert.deepEqual([r.strategy, r.fork, r.groups, r.drafters, r.est], ["grouped", false, 5, 5, 2.63]);
});

test("auto falls back to checkpointed when grouping would need more than ceil(N/3) drafters", () => {
  const r = chooseStrategy(wideCut([10, 4]));
  assert.equal(r.strategy, "checkpointed");
  assert.match(r.reason, /more than ceil\(N\/3\)/);
});

test("auto suggests splitting a cut above 25 tasks", () => {
  assert.equal(chooseStrategy(wideCut([13, 13])).strategy, "split");
});

test("a knob forces its arm, and status-quo keeps per-task drafting from 5 tasks", () => {
  const big = wideCut([3, 3, 3, 3, 3]);
  assert.equal(chooseStrategy(big, "inline").strategy, "inline");
  assert.equal(chooseStrategy(big, "checkpointed").strategy, "checkpointed");
  assert.equal(chooseStrategy(wideCut([2, 2]), "status-quo").strategy, "inline");
  assert.equal(chooseStrategy(wideCut([3, 2]), "status-quo").strategy, "delegated");
  const small = chooseStrategy(wideCut([3]), "grouped");
  assert.deepEqual([small.strategy, small.fork, small.groups], ["grouped", false, 1]);
  assert.deepEqual([chooseStrategy(wideCut([3]), "grouped-fork").strategy, chooseStrategy(wideCut([3]), "grouped-fork").fork], ["grouped", true]);
  const over = chooseStrategy(wideCut([10, 4]), "grouped");
  assert.deepEqual([over.strategy, over.drafters], ["grouped", 6]);
  assert.match(over.reason, /; warning: 6 drafters is more than ceil\(N\/3\) = 5$/);
  assert.doesNotMatch(chooseStrategy(wideCut([3]), "grouped").reason, /warning/);
});

test("a forced grouping warns about a group above the input cap", () => {
  const heavy = [task(1, 1, { files: Array.from({ length: 40 }, (_, j) => `h${j}`) })];
  assert.match(chooseStrategy(heavy, "grouped-fork").reason, /; warning: the group of Task 1 needs 208000 input tokens, above the 150000 cap$/);
});

test("the thresholds are pinned, and a drafter takes at most three tasks even when the input cap would allow more", () => {
  assert.deepEqual(THRESHOLDS, {
    inlineMaxTasks: 12, inlineMaxWeight: 30, splitAboveTasks: 25, couplingMin: 0.5, groupWidthMin: 3,
    maxTasksPerDrafter: 3, maxConcurrent: 4, inputCapTokens: 150000, delegatedFromTasks: 5,
  });
  const light = Array.from({ length: 7 }, (_, i) => task(i + 1, 1, { files: [`l${i}`], produces: 0 }));
  assert.deepEqual(groupCut(light).rounds[0].groups.map((g) => g.tasks), [[1, 2, 3], [4, 5, 6], [7]]);
});

test("est is the projected planning USD, PROFILE is plan-cost's, and a split has no estimate", () => {
  assert.equal(PROFILE, planCost.PROFILE);
  assert.equal(taskWeight, planCost.taskWeight);
  const r = chooseStrategy(wideCut([12]));
  assert.equal(r.est, r.projection.usd);
  assert.equal(r.projection.byRole.coordinator.count, 1);
  const split = chooseStrategy(wideCut([13, 13]));
  assert.deepEqual([split.est, split.projection], [null, null]);
});

test("groupCut packs each wave into groups of at most three tasks, one round per wave", () => {
  const { rounds, drafters } = groupCut(wideCut([9, 6]));
  assert.deepEqual(rounds.map((r) => [r.round, r.groups.map((g) => g.tasks)]), [
    [1, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]],
    [2, [[10, 11, 12], [13, 14, 15]]],
  ]);
  assert.equal(drafters, 5);
  assert.equal(rounds[0].groups[0].est, 124000);
});

test("a group stays within the 150k input cap, so heavy tasks draft alone", () => {
  const heavy = [1, 2, 3].map((n) => task(n, 1, { files: Array.from({ length: 18 }, (_, j) => `h${n}-${j}`) }));
  const { rounds } = groupCut(heavy);
  assert.deepEqual(rounds[0].groups.map((g) => [g.tasks, g.est, g.tier]), [[[1], 120000, "session"], [[2], 120000, "session"], [[3], 120000, "session"]]);
});

test("a group is fast only when every task is small and interface-pinned", () => {
  const tier = (t) => groupCut([t]).rounds[0].groups[0].tier;
  assert.equal(tier(task(1, 1)), "fast");
  assert.equal(tier(task(1, 1, { codePinned: true })), "session");
  assert.equal(tier(task(1, 1, { newAbstraction: true })), "session");
  assert.equal(tier(task(1, 1, { files: ["a", "b", "c", "d", "e", "f"] })), "session");
});

test("at most four groups of a round run at once", () => {
  assert.deepEqual(groupCut(wideCut([13])).rounds[0].batches, [[0, 1, 2, 3], [4]]);
});

test("parseCut accepts a well-formed cut and names every defect", () => {
  assert.deepEqual(parseCut(JSON.stringify(wideCut([2, 1]))).errors, []);
  const bad = parseCut(JSON.stringify([task(1, 1), task(1, 1), task(2, 0), task(3, 1, { deps: [9] }), task(4, 1, { deps: [3] }), { num: 5 }]));
  assert.deepEqual(bad.errors, [
    "task 1 appears twice",
    "task 2: wave must be a positive integer",
    "task 5: needs wave, deps, files and produces",
    "task 3: depends on Task 9, which the cut does not hold",
    "task 4: depends on Task 3, which is not in an earlier wave",
  ]);
  assert.deepEqual(parseCut("not json").errors, ["the cut is not valid JSON"]);
  assert.deepEqual(parseCut("{}").errors, ["the cut must be a JSON array of tasks"]);
});

test("the CLI prints the decision as JSON and refuses a malformed cut", () => {
  const dir = makeTempDir("plan-strategy-");
  const good = writeInto(dir, "cut.json", JSON.stringify(wideCut([9, 6])));
  const ok = spawnSync("node", [SCRIPT, good, "--planningStrategy", "auto"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.strategy, out.fork, out.groups, out.drafters, out.est], ["grouped", false, 5, 5, 2.63]);
  assert.deepEqual([out.projection.dispatches, out.projection.calibrated], [6, false]);
  const bad = spawnSync("node", [SCRIPT, writeInto(dir, "bad.json", "{}")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /plan-strategy: the cut must be a JSON array of tasks/);
});

test("the CLI prices the coordinator on --sessionModel, and falls back with a warning on an id it cannot price", () => {
  const dir = makeTempDir("plan-strategy-");
  const cut = writeInto(dir, "cut.json", JSON.stringify(wideCut([3])));
  const run = (...extra) => {
    const r = spawnSync("node", [SCRIPT, cut, "--planningStrategy", "inline", ...extra], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const base = run();
  assert.deepEqual(base.warnings, []);
  const sonnet = run("--sessionModel", "claude-sonnet-5-5");
  assert.ok(sonnet.est < base.est, `${sonnet.est} vs ${base.est}`);
  assert.deepEqual(sonnet.warnings, []);
  const unknown = run("--sessionModel", "claude-nope-9");
  assert.equal(unknown.est, base.est, "the default session model prices it");
  assert.equal(unknown.warnings.length, 1);
  assert.match(unknown.warnings[0], /claude-nope-9/);
});

test("the CLI prices a host-wrapped --sessionModel id like its bare id, and warns only on an id still unpriced after canonicalizing", () => {
  const dir = makeTempDir("plan-strategy-");
  const cut = writeInto(dir, "cut.json", JSON.stringify(wideCut([3])));
  const run = (...extra) => {
    const r = spawnSync("node", [SCRIPT, cut, "--planningStrategy", "inline", ...extra], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const base = run();
  const bare = run("--sessionModel", "claude-sonnet-5-5");
  assert.ok(bare.est < base.est, "the bare id must price below the default, or the wrapped checks pass vacuously");
  for (const wrapped of ["claude-sonnet-5-5[1m]", "eu.anthropic.claude-sonnet-5-5-v1:0"]) {
    const out = run("--sessionModel", wrapped);
    assert.equal(out.est, bare.est, wrapped);
    assert.equal(out.projection.usd, bare.projection.usd, wrapped);
    assert.deepEqual(out.warnings, [], wrapped);
  }
  const unknown = run("--sessionModel", "claude-nope-9[1m]");
  assert.equal(unknown.est, base.est, "the default session model prices it");
  assert.equal(unknown.projection.usd, base.projection.usd);
  assert.equal(unknown.warnings.length, 1);
  assert.match(unknown.warnings[0], /claude-nope-9\[1m\]/, "names the id as given");
  assert.match(unknown.warnings[0], /claude-nope-9\b(?!\[)/, "names the canonical form when canonicalizing changed it");
});

test("the CLI exits 2 on a usage error and 1 on an unreadable cut", () => {
  const dir = makeTempDir("plan-strategy-");
  const good = writeInto(dir, "cut.json", JSON.stringify(wideCut([3])));
  const noPath = spawnSync("node", [SCRIPT], { encoding: "utf8" });
  assert.equal(noPath.status, 2);
  const badKnob = spawnSync("node", [SCRIPT, good, "--planningStrategy", "nope"], { encoding: "utf8" });
  assert.equal(badKnob.status, 2);
  assert.match(badKnob.stderr, /plan-strategy: unknown planningStrategy "nope"/);
  const missing = spawnSync("node", [SCRIPT, `${dir}/absent.json`], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /plan-strategy: cannot read/);
});
