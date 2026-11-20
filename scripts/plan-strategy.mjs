#!/usr/bin/env node
// The planning-strategy decision table (spec §8) and the grouped-drafter packing (§9.4). The
// coordinator writes its task cut as a JSON array, runs this script on it, and logs the result as
// stage-log key `drafting-plan`. THRESHOLDS and PROFILE are initial values: the planning benchmark
// tunes them, and the figures it settles on move here with a docs/decisions/README.md entry.
//
// A cut task is { num, wave, deps: number[], files: string[], produces: number, codePinned?,
// newAbstraction? }. `produces` counts the interfaces the task produces.
import { readFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";
import { parseFlags } from "./cli-flags.mjs";

export const THRESHOLDS = Object.freeze({
  inlineMaxTasks: 12,
  inlineMaxWeight: 30,
  splitAboveTasks: 25,
  couplingMin: 0.5,
  groupWidthMin: 3,
  maxTasksPerDrafter: 3,
  maxConcurrent: 4,
  inputCapTokens: 150000,
  delegatedFromTasks: 5,
});

// Input-token model of one drafter: a shared prefix and the pack, plus a base and a per-weight
// share for each task it drafts.
export const PROFILE = Object.freeze({
  sharedPrefixTokens: 20000,
  packTokens: 8000,
  taskBaseTokens: 12000,
  tokensPerWeight: 4000,
});

// A group drafts on the fast tier only when every task is small and its interfaces are pinned.
const FAST_TIER_MAX_FILES = 5;

export const KNOBS = Object.freeze(["auto", "inline", "checkpointed", "grouped", "grouped-fork", "status-quo"]);

export const taskWeight = (task) => (task.files.length + task.produces) * (task.codePinned ? 2 : 1);

const taskTokens = (task) => PROFILE.taskBaseTokens + PROFILE.tokensPerWeight * taskWeight(task);
const groupBaseTokens = () => PROFILE.sharedPrefixTokens + PROFILE.packTokens;

export function cutMetrics(cut) {
  const fileOwners = new Map();
  for (const task of cut) for (const file of new Set(task.files)) fileOwners.set(file, (fileOwners.get(file) ?? 0) + 1);
  const coupled = cut.filter(
    (task) => task.deps.length > 0 || task.files.some((file) => fileOwners.get(file) > 1),
  ).length;
  const perWave = new Map();
  for (const task of cut) perWave.set(task.wave, (perWave.get(task.wave) ?? 0) + 1);
  return {
    n: cut.length,
    e: cut.reduce((sum, task) => sum + taskWeight(task), 0),
    coupling: cut.length === 0 ? 0 : coupled / cut.length,
    width: Math.max(0, ...perWave.values()),
    waves: perWave.size,
  };
}

const isFastGroup = (tasks) =>
  tasks.every((task) => !task.codePinned && !task.newAbstraction && task.files.length <= FAST_TIER_MAX_FILES);

function closeGroup(tasks) {
  return {
    tasks: tasks.map((task) => task.num),
    est: groupBaseTokens() + tasks.reduce((sum, task) => sum + taskTokens(task), 0),
    tier: isFastGroup(tasks) ? "fast" : "session",
  };
}

export function groupCut(cut) {
  const waves = [...new Set(cut.map((task) => task.wave))].sort((a, b) => a - b);
  const rounds = waves.map((wave, i) => {
    const tasks = cut.filter((task) => task.wave === wave).sort((a, b) => a.num - b.num);
    const groups = [];
    let open = [];
    let openTokens = groupBaseTokens();
    for (const task of tasks) {
      const withTask = openTokens + taskTokens(task);
      if (open.length > 0 && (open.length + 1 > THRESHOLDS.maxTasksPerDrafter || withTask > THRESHOLDS.inputCapTokens)) {
        groups.push(closeGroup(open));
        open = [];
        openTokens = groupBaseTokens();
      }
      open.push(task);
      openTokens += taskTokens(task);
    }
    if (open.length > 0) groups.push(closeGroup(open));
    const indexes = groups.map((_, index) => index);
    const batches = [];
    for (let at = 0; at < indexes.length; at += THRESHOLDS.maxConcurrent) batches.push(indexes.slice(at, at + THRESHOLDS.maxConcurrent));
    return { round: i + 1, groups, batches };
  });
  return { rounds, drafters: rounds.reduce((sum, round) => sum + round.groups.length, 0) };
}

export function chooseStrategy(cut, knob = "auto") {
  if (!KNOBS.includes(knob)) throw new RangeError(`unknown planningStrategy "${knob}", expected one of ${KNOBS.join(", ")}`);
  const metrics = cutMetrics(cut);
  const decide = (strategy, reason, { fork = false, grouping } = {}) => ({
    strategy,
    fork,
    groups: grouping ? grouping.rounds.reduce((sum, round) => sum + round.groups.length, 0) : 0,
    drafters: grouping ? grouping.drafters : 0,
    est: metrics.e,
    metrics,
    reason,
    rounds: grouping ? grouping.rounds : [],
  });
  if (knob === "inline") return decide("inline", "the planningStrategy knob forces inline drafting");
  if (knob === "checkpointed") return decide("checkpointed", "the planningStrategy knob forces checkpointed drafting");
  if (knob === "grouped" || knob === "grouped-fork") {
    return decide("grouped", `the planningStrategy knob forces grouped drafting${knob === "grouped-fork" ? " with fork drafters" : ""}`, {
      fork: knob === "grouped-fork",
      grouping: groupCut(cut),
    });
  }
  if (knob === "status-quo") {
    return metrics.n >= THRESHOLDS.delegatedFromTasks
      ? decide("delegated", `status-quo drafts each task of a ${metrics.n}-task cut in its own drafter`)
      : decide("inline", `status-quo drafts a cut under ${THRESHOLDS.delegatedFromTasks} tasks inline`);
  }
  if (metrics.n > THRESHOLDS.splitAboveTasks) {
    return decide("split", `${metrics.n} tasks is above ${THRESHOLDS.splitAboveTasks}; suggest splitting the spec`);
  }
  if (metrics.n <= THRESHOLDS.inlineMaxTasks || metrics.e <= THRESHOLDS.inlineMaxWeight) {
    return decide("inline", `${metrics.n} tasks of weight ${metrics.e} fit one inline pass`);
  }
  if (metrics.coupling >= THRESHOLDS.couplingMin || metrics.width < THRESHOLDS.groupWidthMin) {
    return decide("checkpointed", `coupling ${metrics.coupling.toFixed(2)} and width ${metrics.width} leave too little to draft in parallel`);
  }
  const grouping = groupCut(cut);
  if (grouping.drafters > Math.ceil(metrics.n / THRESHOLDS.maxTasksPerDrafter)) {
    return decide("checkpointed", `grouping would need ${grouping.drafters} drafters, more than ceil(N/3) = ${Math.ceil(metrics.n / THRESHOLDS.maxTasksPerDrafter)}`);
  }
  return decide("grouped", `coupling ${metrics.coupling.toFixed(2)} and width ${metrics.width} allow ${grouping.drafters} grouped drafters`, { grouping });
}

export function parseCut(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { cut: [], errors: ["the cut is not valid JSON"] };
  }
  if (!Array.isArray(parsed)) return { cut: [], errors: ["the cut must be a JSON array of tasks"] };
  const errors = [];
  const kept = [];
  const seen = new Set();
  parsed.forEach((entry, i) => {
    if (entry === null || typeof entry !== "object" || !Number.isInteger(entry.num)) {
      errors.push(`entry ${i + 1}: needs an integer num`);
      return;
    }
    const label = `task ${entry.num}`;
    if (seen.has(entry.num)) {
      errors.push(`${label} appears twice`);
      return;
    }
    seen.add(entry.num);
    const complete =
      entry.wave !== undefined &&
      Array.isArray(entry.deps) && entry.deps.every(Number.isInteger) &&
      Array.isArray(entry.files) && entry.files.every((file) => typeof file === "string") &&
      Number.isFinite(entry.produces);
    if (!complete) {
      errors.push(`${label}: needs wave, deps, files and produces`);
      return;
    }
    if (!Number.isInteger(entry.wave) || entry.wave < 1) {
      errors.push(`${label}: wave must be a positive integer`);
      return;
    }
    kept.push(entry);
  });
  const waveOf = new Map(kept.map((task) => [task.num, task.wave]));
  for (const task of kept) {
    for (const dep of task.deps) {
      if (!waveOf.has(dep)) errors.push(`task ${task.num}: depends on Task ${dep}, which the cut does not hold`);
      else if (waveOf.get(dep) >= task.wave) errors.push(`task ${task.num}: depends on Task ${dep}, which is not in an earlier wave`);
    }
  }
  return { cut: kept, errors };
}

const USAGE = "usage: plan-strategy.mjs <task-cut.json> [--planningStrategy <value>]";

function usage(message) {
  if (message) console.error(`plan-strategy: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, { "--planningStrategy": "value" }, { allowPositionals: true, requireValues: "nonEmpty" });
  } catch (e) {
    usage(e.message);
  }
  const { flags, positionals } = parsed;
  if (positionals.length !== 1) usage();
  const knob = flags["--planningStrategy"] ?? "auto";
  if (!KNOBS.includes(knob)) usage(`unknown planningStrategy "${knob}", expected one of ${KNOBS.join(", ")}`);
  let text;
  try {
    text = readFileSync(positionals[0], "utf8");
  } catch (e) {
    console.error(`plan-strategy: cannot read ${positionals[0]}: ${e.code ?? e.message}`);
    process.exit(1);
  }
  const { cut, errors } = parseCut(text);
  if (errors.length) {
    for (const error of errors) console.error(`plan-strategy: ${error}`);
    process.exit(1);
  }
  const { strategy, fork, groups, drafters, est, reason, metrics, rounds } = chooseStrategy(cut, knob);
  console.log(JSON.stringify({ strategy, fork, groups, drafters, est, reason, metrics, rounds }, null, 2));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
