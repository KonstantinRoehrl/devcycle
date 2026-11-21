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
import { PLANNING_MODELS, PROFILE, draftTier, projectPlanning, taskTokens, taskWeight } from "./plan-cost.mjs";
import { canonicalModelId } from "./depth-bands.mjs";
import { parseModelId, priceFor } from "./pricing.mjs";

export { PROFILE, taskWeight };

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

export const KNOBS = Object.freeze(["auto", "inline", "checkpointed", "grouped", "grouped-fork", "status-quo"]);

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

function closeGroup(tasks) {
  return {
    tasks: tasks.map((task) => task.num),
    est: groupBaseTokens() + tasks.reduce((sum, task) => sum + taskTokens(task), 0),
    tier: draftTier(tasks),
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

// A forced grouping skips the auto path's guards, so it reports what the auto path would have refused.
function capWarnings(grouping, n) {
  const warnings = [];
  const ceiling = Math.ceil(n / THRESHOLDS.maxTasksPerDrafter);
  if (grouping.drafters > ceiling) warnings.push(`${grouping.drafters} drafters is more than ceil(N/3) = ${ceiling}`);
  for (const round of grouping.rounds) {
    for (const group of round.groups) {
      if (group.est > THRESHOLDS.inputCapTokens) {
        const label = group.tasks.map((num) => `Task ${num}`).join(", ");
        warnings.push(`the group of ${label} needs ${group.est} input tokens, above the ${THRESHOLDS.inputCapTokens} cap`);
      }
    }
  }
  return warnings.map((warning) => `; warning: ${warning}`).join("");
}

export function chooseStrategy(cut, knob = "auto", models = PLANNING_MODELS) {
  if (!KNOBS.includes(knob)) throw new RangeError(`unknown planningStrategy "${knob}", expected one of ${KNOBS.join(", ")}`);
  const metrics = cutMetrics(cut);
  const decide = (strategy, reason, { fork = false, grouping } = {}) => {
    const rounds = grouping ? grouping.rounds : [];
    const projection = projectPlanning({ strategy, fork, rounds }, cut, models);
    return {
      strategy,
      fork,
      groups: grouping ? grouping.rounds.reduce((sum, round) => sum + round.groups.length, 0) : 0,
      drafters: grouping ? grouping.drafters : 0,
      est: projection ? projection.usd : null,
      projection,
      metrics,
      reason,
      rounds,
    };
  };
  if (knob === "inline") return decide("inline", "the planningStrategy knob forces inline drafting");
  if (knob === "checkpointed") return decide("checkpointed", "the planningStrategy knob forces checkpointed drafting");
  if (knob === "grouped" || knob === "grouped-fork") {
    const grouping = groupCut(cut);
    const reason = `the planningStrategy knob forces grouped drafting${knob === "grouped-fork" ? " with fork drafters" : ""}`;
    return decide("grouped", reason + capWarnings(grouping, metrics.n), { fork: knob === "grouped-fork", grouping });
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

const USAGE = "usage: plan-strategy.mjs <task-cut.json> [--planningStrategy <value>] [--sessionModel <model id>]";

function usage(message) {
  if (message) console.error(`plan-strategy: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function main(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, { "--planningStrategy": "value", "--sessionModel": "value" }, { allowPositionals: true, requireValues: "nonEmpty" });
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
  // The session model prices the coordinator and fork drafters. A dated snapshot the table does not hold
  // falls back to its undated id (the grammar's owner is pricing.mjs), and an id neither form prices keeps
  // the default and says so, because a guessed price would be presented as a measured one. An omitted flag
  // says so too: the default is Opus, so a Sonnet session would otherwise be silently overpriced.
  const warnings = [];
  const models = { ...PLANNING_MODELS };
  const sessionModel = flags["--sessionModel"];
  if (sessionModel === undefined) {
    warnings.push(`no --sessionModel given; priced the session as ${PLANNING_MODELS.session}`);
  } else {
    const canonical = canonicalModelId(sessionModel);
    const parsed = parseModelId(canonical);
    const undated = parsed && /-\d{8}$/.test(canonical) ? `claude-${parsed.family}-${parsed.version.join("-")}` : null;
    const priced = [canonical, undated].find((id) => id && priceFor(id));
    if (priced) models.session = priced;
    else {
      const named = canonical === sessionModel ? sessionModel : `${sessionModel} (${canonical})`;
      warnings.push(`--sessionModel ${named} has no price in scripts/pricing.mjs; priced the session as ${PLANNING_MODELS.session}`);
    }
  }
  const { strategy, fork, groups, drafters, est, projection, reason, metrics, rounds } = chooseStrategy(cut, knob, models);
  console.log(JSON.stringify({ strategy, fork, groups, drafters, est, projection, reason, metrics, rounds, warnings }, null, 2));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
