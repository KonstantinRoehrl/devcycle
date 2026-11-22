import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROFILE, ROLE_PARAMS, PLANNING_RATES, EXECUTION_RATE, CALIBRATION, PLANNING_MODELS, CHECKER_PAIRS_PER_DISPATCH,
  taskWeight, taskTokens, draftTier, isCalibrated, dispatchCost, projectPlanning,
} from "../../scripts/plan-cost.mjs";

const task = (num, wave, { deps = [], files = [`f${num}.mjs`, `t${num}.mjs`, `g${num}.mjs`], produces = 2, ...flags } = {}) =>
  ({ num, wave, deps, files, produces, ...flags });
// Weights 3, 2 and 2, so 24000, 20000 and 20000 task tokens; Task 3 consumes Task 1.
const cut = [
  task(1, 1, { files: ["a", "b"], produces: 1 }),
  task(2, 1, { files: ["c"], produces: 1 }),
  task(3, 2, { deps: [1], files: ["d", "e"], produces: 0 }),
];
const oneRound = { round: 1, groups: [{ tasks: [1, 2], est: 0, tier: "fast" }, { tasks: [3], est: 0, tier: "fast" }], batches: [[0, 1]] };

test("the profile, the fitted role parameters, the rates and the calibration record are pinned", () => {
  assert.deepEqual(PROFILE, { sharedPrefixTokens: 20000, packTokens: 8000, taskBaseTokens: 12000, tokensPerWeight: 4000 });
  assert.deepEqual(ROLE_PARAMS, {
    drafter: { F: 17303, t: 30.5, r: 26177, o: 36901, n: 14 },
    checker: { F: 19235, t: 9, r: 31331, o: 6367, n: 5 },
  });
  assert.deepEqual(PLANNING_RATES, { "status-quo": 1.34, inline: 0.97, grouped: 1.11, checkpointed: 1.4 });
  assert.equal(EXECUTION_RATE, 2.5);
  assert.deepEqual(CALIBRATION, { passes: [], maxErrorPct: 35 });
  assert.deepEqual(PLANNING_MODELS, { session: "claude-opus-5-5", fast: "claude-haiku-5-5" });
  assert.equal(CHECKER_PAIRS_PER_DISPATCH, 8);
});

test("a task weighs its files plus its produced interfaces, doubled when code-pinned, and costs tokens by weight", () => {
  assert.equal(taskWeight(task(1, 1)), 5);
  assert.equal(taskWeight(task(1, 1, { codePinned: true })), 10);
  assert.equal(taskTokens(task(1, 1)), 32000);
});

test("a drafter is fast only when every task is small and interface-pinned", () => {
  assert.equal(draftTier([task(1, 1), task(2, 1)]), "fast");
  assert.equal(draftTier([task(1, 1), task(2, 1, { codePinned: true })]), "session");
  assert.equal(draftTier([task(1, 1, { newAbstraction: true })]), "session");
  assert.equal(draftTier([task(1, 1, { files: ["a", "b", "c", "d", "e", "f"] })]), "session");
});

test("calibration takes two passes within the error bound", () => {
  assert.equal(isCalibrated(), false);
  assert.equal(isCalibrated({ passes: [{ id: "a", errorPct: 12 }], maxErrorPct: 35 }), false);
  assert.equal(isCalibrated({ passes: [{ id: "a", errorPct: -35 }, { id: "b", errorPct: 34.9 }], maxErrorPct: 35 }), true);
  assert.equal(isCalibrated({ passes: [{ id: "a", errorPct: 10 }, { id: "b", errorPct: 36 }], maxErrorPct: 35 }), false);
});

test("one dispatch costs its cache writes, its linear re-reads and its output", () => {
  const shape = { F: 20000, S: 8000, R: 10000, O: 2000, T: 10 };
  assert.equal(dispatchCost(shape, { in: 4, out: 20, cacheRead: 0.2 }), 0.308);
  // No listed cache-read price: it reads at 0.1x input.
  assert.equal(dispatchCost(shape, { in: 0.1, out: 0.5 }), 0.0094);
});

test("inline is one coordinator segment, checkpointed one per wave", () => {
  assert.deepEqual(projectPlanning({ strategy: "inline", fork: false, rounds: [] }, cut), {
    dispatches: 0, tokens: 92000, usd: 2.31, calibrated: false,
    byRole: { coordinator: { count: 1, tokens: 92000, usd: 2.31 }, drafter: { count: 0, tokens: 0, usd: 0 }, checker: { count: 0, tokens: 0, usd: 0 } },
  });
  const checkpointed = projectPlanning({ strategy: "checkpointed", fork: false, rounds: [] }, cut);
  assert.deepEqual([checkpointed.byRole.coordinator.count, checkpointed.tokens, checkpointed.usd], [2, 120000, 2.19]);
});

test("grouped prices a drafter per group on its tier, a merge segment and one checker per 8 pairs", () => {
  const grouped = projectPlanning({ strategy: "grouped", fork: false, rounds: [oneRound] }, cut);
  assert.deepEqual(grouped, {
    dispatches: 3, tokens: 242373, usd: 0.44, calibrated: false,
    byRole: {
      coordinator: { count: 1, tokens: 65440, usd: 0.36 },
      drafter: { count: 2, tokens: 120000, usd: 0.08 },
      checker: { count: 1, tokens: 56933, usd: 0.01 },
    },
  });
  // The fork arm is gone: a `fork` flag in the choice changes nothing, the drafters stay on the fast tier.
  const forkFlag = projectPlanning({ strategy: "grouped", fork: true, rounds: [oneRound] }, cut);
  assert.deepEqual(forkFlag, grouped);
  const delegated = projectPlanning({ strategy: "delegated", fork: false, rounds: [] }, cut);
  assert.deepEqual([delegated.byRole.drafter.count, delegated.dispatches], [3, 4]);
});

test("a cheaper session model prices the coordinator lower and dispatches the same", () => {
  const choice = { strategy: "grouped", fork: false, rounds: [oneRound] };
  const sonnet = projectPlanning(choice, cut, { ...PLANNING_MODELS, session: "claude-sonnet-5-5" });
  const opus = projectPlanning(choice, cut);
  assert.ok(sonnet.byRole.coordinator.usd < opus.byRole.coordinator.usd, `${sonnet.byRole.coordinator.usd} vs ${opus.byRole.coordinator.usd}`);
  assert.equal(sonnet.dispatches, opus.dispatches);
  assert.equal(sonnet.byRole.drafter.usd, opus.byRole.drafter.usd, "a fast-tier drafter does not follow the session model");
});

test("a split has no projection", () => {
  assert.equal(projectPlanning({ strategy: "split", fork: false, rounds: [] }, cut), null);
});
