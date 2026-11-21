// The planning cost model (spec §7). It prices the dispatches a planning strategy makes (the
// coordinator's draft and merge segments, each drafter and each edge checker) from a fitted
// per-role profile, and spends nothing: a projection is arithmetic over a task cut, never a run.
// scripts/plan-strategy.mjs projects each decision with it; scripts/plan-bench.mjs takes its
// per-task rates from it.
import { CACHE_WRITE_5M_MULTIPLIER, cacheReadDollars, priceFor } from "./pricing.mjs";

// Input-token model of one drafter: a shared prefix and the pack, plus a base and a per-weight
// share for each task it drafts.
export const PROFILE = Object.freeze({
  sharedPrefixTokens: 20000,
  packTokens: 8000,
  taskBaseTokens: 12000,
  tokensPerWeight: 4000,
});

// The per-role medians of `cost-model-fit.mjs --runs .devcycle/plan-bench/passes`, printed on
// 2026-11-20. F is the fresh prefix, t the turns, r the tool-result tokens, o the output tokens and
// n the dispatches the median is over.
export const ROLE_PARAMS = Object.freeze({
  drafter: Object.freeze({ F: 17303, t: 30.5, r: 26177, o: 36901, n: 14 }),
  checker: Object.freeze({ F: 19235, t: 9, r: 31331, o: 6367, n: 5 }),
});

// USD per planned task (assumption: #442's 0.32.x figures, upper ends) until cost-model-fit
// calibrates them: status-quo $4.4-5.3 planning, inline $0.4-1.4, execution $2.5 (the observed Phase 1 medium baseline, about $5.5 for about 2 tasks).
// The grouped, grouped-fork and checkpointed planning rates are assumptions until a pass calibrates them.
export const PLANNING_RATES = Object.freeze({ "status-quo": 5.3, inline: 1.4, grouped: 3, "grouped-fork": 2.5, checkpointed: 1.4 });
export const EXECUTION_RATE = 2.5;

// A pass entry is { id, errorPct }: the projection's error against what that benchmark pass spent.
export const CALIBRATION = Object.freeze({ passes: Object.freeze([]), maxErrorPct: 35 });

// The session model prices the coordinator and every fork drafter; the fast tier prices a drafter
// that references/model-routing.md § Planning dispatches routes to it, and every edge checker.
export const PLANNING_MODELS = Object.freeze({ session: "claude-opus-5-5", fast: "claude-haiku-5-5" });

// One edge-checker dispatch checks this many consumer/producer pairs (references/delegated-planning.md § Edge checker).
export const CHECKER_PAIRS_PER_DISPATCH = 8;

// A drafter is fast only when every task is small and its interfaces are pinned.
const FAST_TIER_MAX_FILES = 5;

export const taskWeight = (task) => (task.files.length + task.produces) * (task.codePinned ? 2 : 1);

export const taskTokens = (task) => PROFILE.taskBaseTokens + PROFILE.tokensPerWeight * taskWeight(task);

export const draftTier = (tasks) =>
  tasks.every((task) => !task.codePinned && !task.newAbstraction && task.files.length <= FAST_TIER_MAX_FILES) ? "fast" : "session";

export function isCalibrated(calibration = CALIBRATION) {
  return calibration.passes.filter((pass) => Math.abs(pass.errorPct) <= calibration.maxErrorPct).length >= 2;
}

// F is the fresh prefix, S the shared pack, R the tool results and O the output: each is written
// to the cache once, then T turns re-read the prefix, the pack and, on average, half of R and O.
export function dispatchCost({ F, S, R, O, T }, price) {
  return (
    (price.in * CACHE_WRITE_5M_MULTIPLIER * (F + S + R + O) +
      cacheReadDollars(T * (F + S + (R + O) / 2), price) +
      price.out * O) /
    1e6
  );
}

const cents = (n) => Math.round(n * 100) / 100;

const draftSegment = (tasks, model) => {
  const { r, o, t } = ROLE_PARAMS.drafter;
  const sum = tasks.reduce((total, task) => total + taskTokens(task), 0);
  const O = Math.round((sum * o) / (r + o));
  return { F: PROFILE.sharedPrefixTokens, S: PROFILE.packTokens, R: sum - O, O, T: t * tasks.length, model };
};

const mergeSegment = (tasks, model) => {
  const { r, o } = ROLE_PARAMS.drafter;
  const R = tasks.reduce((total, task) => total + Math.round((taskTokens(task) * o) / (r + o)), 0);
  return { F: PROFILE.sharedPrefixTokens, S: PROFILE.packTokens, R, O: 0, T: tasks.length, model };
};

const checkerSegment = (model) => {
  const { F, r, o, t } = ROLE_PARAMS.checker;
  return { F, S: 0, R: r, O: o, T: t, model };
};

export function projectPlanning(choice, cut, models = PLANNING_MODELS) {
  const { strategy, fork, rounds } = choice;
  const byNum = new Map(cut.map((task) => [task.num, task]));
  const draftersOf = (groups) =>
    groups.map((tasks) => draftSegment(tasks, fork ? models.session : models[draftTier(tasks)]));
  const segments = [];
  const add = (role, list) => segments.push(...list.map((segment) => ({ ...segment, role })));
  if (strategy === "inline") {
    add("coordinator", [draftSegment(cut, models.session)]);
  } else if (strategy === "checkpointed") {
    const waves = [...new Set(cut.map((task) => task.wave))].sort((a, b) => a - b);
    add("coordinator", waves.map((wave) => draftSegment(cut.filter((task) => task.wave === wave), models.session)));
  } else if (strategy === "grouped" || strategy === "delegated") {
    const groups = strategy === "delegated"
      ? cut.map((task) => [task])
      : rounds.flatMap((round) => round.groups.map((group) => group.tasks.map((num) => byNum.get(num)).filter(Boolean)));
    add("drafter", draftersOf(groups));
    add("coordinator", [mergeSegment(cut, models.session)]);
    const pairs = cut.reduce((total, task) => total + task.deps.length, 0);
    add("checker", Array.from({ length: Math.ceil(pairs / CHECKER_PAIRS_PER_DISPATCH) }, () => checkerSegment(models.fast)));
  } else {
    return null;
  }
  const byRole = {};
  for (const role of ["coordinator", "drafter", "checker"]) {
    const own = segments.filter((segment) => segment.role === role);
    byRole[role] = {
      count: own.length,
      tokens: own.reduce((total, { F, S, R, O }) => total + F + S + R + O, 0),
      usd: cents(own.reduce((total, segment) => total + dispatchCost(segment, priceFor(segment.model)), 0)),
    };
  }
  return {
    dispatches: byRole.drafter.count + byRole.checker.count,
    tokens: segments.reduce((total, { F, S, R, O }) => total + F + S + R + O, 0),
    usd: cents(segments.reduce((total, segment) => total + dispatchCost(segment, priceFor(segment.model)), 0)),
    calibrated: isCalibrated(),
    byRole,
  };
}
