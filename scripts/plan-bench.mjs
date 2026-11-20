#!/usr/bin/env node
// The planning replay benchmark (spec §9.9): replays a gitignored corpus of specs through headless
// planning, once per planningStrategy arm, and scores each replay against rubric P1-P12. This file
// owns the manifest and answer-file shapes, the spend estimate, the budget refusal and the go-ahead
// token; scripts/plan-bench-pass.mjs runs a pass and scripts/plan-bench-score.mjs scores one.
// Nothing here spends money: only `run`, given a go-ahead token that matches the printed estimate,
// launches a session, and never from a driven (unattended) session. PLAN_BENCH_STUB_ONLY=1 makes `run`
// refuse the real `claude` and demand --claude <stub>; the tests set it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import agentCli from "../workflows/lib/agent-cli.js";
import { gitToplevel } from "./run-record.mjs";
import { claudeProjectsDir } from "./depth-probe.mjs";
import { readPluginList } from "./drive-surface.mjs";
import { runPass, specSource } from "./plan-bench-pass.mjs";
import { resultsMarkdown, scorePass } from "./plan-bench-score.mjs";

const { spawnSpec } = agentCli;

export const ARMS = ["status-quo", "inline"];
export const SIZES = ["small", "medium", "large"];
// A manifest entry's planned task count when it names none, by size.
export const DEFAULT_TASKS = { small: 3, medium: 7, large: 12 };
// USD per planned task (assumption: #442's 0.32.x figures, upper ends) until cost-model-fit
// calibrates them: status-quo $4.4-5.3 planning, inline $0.4-1.4, execution $2.5 (the observed Phase 1 medium baseline, about $5.5 for about 2 tasks).
export const RATES = { planning: { "status-quo": 5.3, inline: 1.4 }, execution: 2.5 };
// The default stays at the user's target: a small, a medium and a large entry at default sizes estimates
// $182.40 (the estimate takes the upper ends of #442's rates on purpose), so such a pass needs a smaller
// corpus or an explicit --budget above the target, which is the user's call.
export const DEFAULT_BUDGET = 150;
// Seconds one headless leg may run before it is killed and its replay recorded as an error.
export const DEFAULT_LEG_TIMEOUT_SECONDS = 7200;
export const BENCH_DIR = ".devcycle/plan-bench";
// Every gate the benchmark cannot answer from an entry's answer file gets this standing reply: it matches
// any question and, being `standing`, answers every gate of the replay, not just the first.
export const DEFAULT_ANSWERS = [
  { match: "[\\s\\S]", standing: true, reply: "Confirm: enter planning against the approved spec as a feature. For any other question, take the option you recommend." },
];

const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{7,40}$/;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/**
 * @param {unknown} obj the parsed manifest file
 * @returns {{entries: {id: string, size: string, repoPath: string, baseSha: string, specPath: string, tasks: number, execute: boolean}[], errors: string[]}}
 */
export function validateManifest(obj) {
  const errors = [];
  if (!isObject(obj) || !Array.isArray(obj.entries)) return { entries: [], errors: ["manifest: expected an object with an entries array"] };
  const seen = new Set();
  const entries = [];
  obj.entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!isObject(e)) return errors.push(`${at}: expected an object`);
    const before = errors.length;
    if (!(typeof e.id === "string" && ID.test(e.id))) errors.push(`${at}.id: expected lowercase letters, digits and dashes`);
    else if (seen.has(e.id)) errors.push(`${at}.id: duplicate id ${e.id}`);
    if (!SIZES.includes(e.size)) errors.push(`${at}.size: expected one of ${SIZES.join(", ")}`);
    for (const key of ["repoPath", "specPath"]) if (!nonEmpty(e[key])) errors.push(`${at}.${key}: expected a non-empty string`);
    if (!(typeof e.baseSha === "string" && SHA.test(e.baseSha))) errors.push(`${at}.baseSha: expected a 7-40 character hex sha`);
    if (e.tasks !== undefined && !(Number.isInteger(e.tasks) && e.tasks > 0)) errors.push(`${at}.tasks: expected a positive integer`);
    if (e.execute !== undefined && typeof e.execute !== "boolean") errors.push(`${at}.execute: expected true or false`);
    if (errors.length > before) return;
    seen.add(e.id);
    entries.push({
      id: e.id, size: e.size, repoPath: e.repoPath, baseSha: e.baseSha, specPath: e.specPath,
      tasks: e.tasks ?? DEFAULT_TASKS[e.size], execute: e.execute ?? e.size === "medium",
    });
  });
  return { entries, errors };
}

/**
 * @param {unknown} obj the parsed answer file, or undefined when the entry has none
 * @returns {{prompt: string|null, answers: {match: string, reply: string}[], errors: string[]}}
 */
export function validateAnswers(obj) {
  if (obj === undefined) return { prompt: null, answers: DEFAULT_ANSWERS, errors: [] };
  if (!isObject(obj) || !Array.isArray(obj.answers)) return { prompt: null, answers: [], errors: ["answers: expected an object with an answers array"] };
  const errors = [];
  if (obj.prompt !== undefined && !nonEmpty(obj.prompt)) errors.push("answers.prompt: expected a non-empty string");
  obj.answers.forEach((a, i) => {
    if (!isObject(a) || !nonEmpty(a.match) || !nonEmpty(a.reply)) return errors.push(`answers[${i}]: expected {match, reply} strings`);
    try { new RegExp(a.match, "i"); } catch { errors.push(`answers[${i}].match: not a valid regular expression`); }
  });
  return { prompt: obj.prompt ?? null, answers: obj.answers.map(({ match, reply }) => ({ match, reply })), errors };
}

const cents = (n) => Math.round(n * 100) / 100;

/**
 * @param {{entries: {id: string, tasks: number, execute: boolean}[], arms: string[], rates?: typeof RATES}} input
 * @returns {{rows: {id: string, arm: string, tasks: number, planningUsd: number, executionUsd: number, usd: number}[], totalUsd: number}}
 */
export function estimatePass({ entries, arms, rates = RATES }) {
  const rows = [];
  for (const e of entries)
    for (const arm of arms) {
      const planningUsd = cents(e.tasks * rates.planning[arm]);
      const executionUsd = e.execute ? cents(e.tasks * rates.execution) : 0;
      rows.push({ id: e.id, arm, tasks: e.tasks, planningUsd, executionUsd, usd: cents(planningUsd + executionUsd) });
    }
  return { rows, totalUsd: cents(rows.reduce((n, r) => n + r.usd, 0)) };
}

/**
 * The token `run` demands: it changes whenever the manifest, an answer file, the arms, the pass id,
 * the budget or the estimate changes, so a go-ahead covers exactly the pass whose estimate was shown.
 * @param {{manifestText: string, answersTexts: string[], arms: string[], passId: string, budget: number, totalUsd: number}} input
 * @returns {string} 12 lowercase hex characters
 */
export function goAheadToken({ manifestText, answersTexts, arms, passId, budget, totalUsd }) {
  const h = createHash("sha256");
  for (const part of [manifestText, ...answersTexts, arms.join(","), passId, String(budget), String(totalUsd)]) h.update(part).update("\0");
  return h.digest("hex").slice(0, 12);
}

/**
 * The knob values a replay session runs with: the arm under test, a pinned implementer model, and
 * everything else fixed so arms differ only in planningStrategy.
 * @param {string} arm one of ARMS
 * @param {{implementerModel: string}} opts
 * @returns {Record<string, string|boolean>} each value typed as .claude-plugin/plugin.json declares its knob
 */
export function benchKnobs(arm, { implementerModel }) {
  return {
    profile: "standard", gitPolicy: "local-commits-only", docTrackingPolicy: "all-local", reviewDepth: "single",
    crossModelReview: false, onDeviceGate: "auto-ok", implementerModel, handoffNotification: "off",
    executionMode: "manual", subagentBudget: "warn", planningStrategy: arm,
  };
}

/**
 * The --settings object for a replay session: every enabled plugin but superpowers turned off (the
 * installed devcycle included, so only the --plugin-dir checkout loads), and the knobs stored under
 * `devcycle@inline`, the id a --plugin-dir checkout loads as (docs/platform-notes.md § (h), § (r)).
 * @param {{plugins: {id: string, enabled: boolean, projectEnabled: boolean}[], knobs: Record<string, string>}} input
 */
export function benchSettings({ plugins, knobs }) {
  const off = plugins.filter((p) => (p.enabled || p.projectEnabled) && p.id.split("@")[0] !== "superpowers");
  return {
    enabledPlugins: Object.fromEntries(off.map((p) => [p.id, false])),
    pluginConfigs: { "devcycle@inline": { options: { ...knobs } } },
  };
}

export class PlanBenchError extends Error {}

const gitOk = (args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;

/**
 * What would make a pass die after money is spent: a pass directory that already holds a run, and per
 * entry a repoPath that is no git repository, a baseSha its repo does not have, a spec file that is not
 * there. Checked before the estimate prints a go-ahead token, so nothing is paid for an unrunnable pass.
 * @param {{entries: {id: string, repoPath: string, baseSha: string, specPath: string}[], passDir: string}} input
 * @returns {string[]} one message per problem, empty when the pass can start
 */
export function preflight({ entries, passDir }) {
  const problems = [];
  if (existsSync(passDir) && readdirSync(passDir).length > 0) problems.push(`pass directory ${passDir} already holds a run; pick a new --pass id`);
  for (const e of entries) {
    if (!gitOk(["-C", e.repoPath, "rev-parse", "--git-dir"])) {
      problems.push(`${e.id}: repoPath ${e.repoPath} is not a git repository`);
      continue;
    }
    if (!gitOk(["-C", e.repoPath, "cat-file", "-e", `${e.baseSha}^{commit}`])) problems.push(`${e.id}: baseSha ${e.baseSha.slice(0, 7)} does not exist in ${e.repoPath}`);
    const spec = specSource(e);
    if (!existsSync(spec)) problems.push(`${e.id}: spec file ${e.specPath} not found (looked at ${spec})`);
  }
  return problems;
}

const passDirOf = (root, passId) => join(root, BENCH_DIR, "passes", passId);

// Prints the preflight problems and returns true when the pass cannot start.
function refusedByPreflight(common, root) {
  const problems = preflight({ entries: common.entries, passDir: passDirOf(root, common.passId) });
  for (const p of problems) console.error(`plan-bench: ${p}`);
  return problems.length > 0;
}

const KNOWN_FLAGS = {
  "--manifest": "value", "--arms": "value", "--entries": "value", "--budget": "value", "--pass": "value",
};

/** The flags every subcommand shares, read and checked. */
export function readCommon(flags, root) {
  const manifestPath = requireValue(flags, "--manifest") ?? join(root, BENCH_DIR, "manifest.json");
  let manifestText;
  try { manifestText = readFileSync(manifestPath, "utf8"); } catch { throw new PlanBenchError(`no manifest at ${manifestPath}`); }
  let parsed;
  try { parsed = JSON.parse(manifestText); } catch { throw new PlanBenchError(`${manifestPath} is not JSON`); }
  const { entries, errors } = validateManifest(parsed);
  if (errors.length) throw new PlanBenchError(errors.join("\n"));
  const arms = (requireValue(flags, "--arms", "a comma-separated arm list") ?? ARMS.join(",")).split(",");
  const badArm = arms.find((a) => !ARMS.includes(a));
  if (badArm) throw new PlanBenchError(`unknown arm ${badArm}; expected ${ARMS.join(", ")}`);
  const only = requireValue(flags, "--entries", "a comma-separated id list")?.split(",");
  const unknown = only?.find((id) => !entries.some((e) => e.id === id));
  if (unknown) throw new PlanBenchError(`no manifest entry ${unknown}`);
  const budgetText = requireValue(flags, "--budget", "a dollar amount") ?? String(DEFAULT_BUDGET);
  const budget = Number(budgetText);
  if (!(budget > 0)) throw new PlanBenchError(`--budget ${budgetText}: expected a positive dollar amount`);
  const passId = requireValue(flags, "--pass", "a pass id") ?? "1";
  if (!ID.test(passId)) throw new PlanBenchError(`--pass ${passId}: expected lowercase letters, digits and dashes`);
  const chosen = only ? entries.filter((e) => only.includes(e.id)) : entries;
  const answersTexts = chosen.map((e) => {
    try { return readFileSync(join(root, BENCH_DIR, "answers", `${e.id}.json`), "utf8"); } catch { return ""; }
  });
  const answers = chosen.map((e, i) => {
    let obj;
    try { obj = answersTexts[i] === "" ? undefined : JSON.parse(answersTexts[i]); } catch { throw new PlanBenchError(`answers/${e.id}.json is not JSON`); }
    const parsedAnswers = validateAnswers(obj);
    if (parsedAnswers.errors.length) throw new PlanBenchError(parsedAnswers.errors.map((m) => `answers/${e.id}.json: ${m}`).join("\n"));
    return parsedAnswers;
  });
  return { manifestText, entries: chosen, arms, budget, passId, answersTexts, answers };
}

/** The estimate block every spending subcommand prints first. */
export function estimateLines(common) {
  const { rows, totalUsd } = estimatePass(common);
  const token = goAheadToken({ ...common, totalUsd });
  const lines = ["| Entry | Arm | Tasks | Planning $ | Execution $ | Total $ |", "| --- | --- | --- | --- | --- | --- |"];
  for (const r of rows) lines.push(`| ${r.id} | ${r.arm} | ${r.tasks} | ${r.planningUsd.toFixed(2)} | ${r.executionUsd.toFixed(2)} | ${r.usd.toFixed(2)} |`);
  lines.push("", `estimate: $${totalUsd.toFixed(2)} for pass ${common.passId} (budget $${common.budget.toFixed(2)})`);
  const within = totalUsd <= common.budget;
  if (within) lines.push(`go-ahead: ${token}`);
  else
    lines.push(
      `refused: the estimate exceeds --budget $${common.budget.toFixed(2)}`,
      "next: either shrink the corpus (fewer --entries, a smaller `size` or `tasks` in the manifest), or rerun with an explicit --budget above the estimate, which is the user's decision to make",
    );
  return { lines, token, within, totalUsd };
}

function estimate(argv, root) {
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  const common = readCommon(flags, root);
  if (refusedByPreflight(common, root)) return 2;
  const { lines, within } = estimateLines(common);
  console.log(lines.join("\n"));
  return within ? 0 : 2;
}

export const SESSION_MODEL = "claude-opus-5-5";
export const IMPLEMENTER_MODEL = "claude-sonnet-5-5";

const RUN_FLAGS = {
  ...KNOWN_FLAGS, "--go-ahead": "value", "--plugin-dir": "value", "--model": "value", "--implementer-model": "value", "--claude": "value",
  "--leg-timeout": "value",
};

// The paid subcommand. Order is the consent contract: a pass that cannot start is refused, the estimate prints
// next, a pass over budget is refused, a pass whose go-ahead token does not match the printed estimate is refused, and with
// PLAN_BENCH_STUB_ONLY set the real `claude` is never launched. A driven session never gets this far: spec §9.9, unattended
// execution never launches a paid pass on its own.
function run(argv, root) {
  if (process.env.DEVCYCLE_DRIVE_TOKEN) throw new PlanBenchError("run never starts inside a driven session: a paid pass needs the user's go-ahead in an interactive session (estimate is still allowed)");
  const { flags } = parseFlags(argv, RUN_FLAGS);
  const legTimeoutText = requireValue(flags, "--leg-timeout", "a number of seconds") ?? String(DEFAULT_LEG_TIMEOUT_SECONDS);
  const legTimeoutSeconds = Number(legTimeoutText);
  if (!(legTimeoutSeconds > 0)) throw new PlanBenchError(`--leg-timeout ${legTimeoutText}: expected a positive number of seconds`);
  const common = readCommon(flags, root);
  if (refusedByPreflight(common, root)) return 2;
  const { lines, token, within } = estimateLines(common);
  console.log(lines.join("\n"));
  if (!within) return 2;
  if (requireValue(flags, "--go-ahead", "the go-ahead token the estimate printed") !== token) {
    console.log("no go-ahead: show the user this estimate, and rerun with --go-ahead <token> only once they approve this pass");
    return 3;
  }
  const claude = requireValue(flags, "--claude", "a claude binary") ?? "claude";
  if (process.env.PLAN_BENCH_STUB_ONLY && !("--claude" in flags)) throw new PlanBenchError("refusing to launch the real claude: PLAN_BENCH_STUB_ONLY is set; pass --claude <stub>");
  const list = readPluginList({ bin: claude, cwd: root });
  if (!list.ok) throw new PlanBenchError("cannot read `claude plugin list --json`, so the arm cannot be forced: the installed devcycle would load beside the checkout under test (docs/platform-notes.md § (r)); fix the claude install or --claude and rerun");
  const implementerModel = requireValue(flags, "--implementer-model", "a model id") ?? IMPLEMENTER_MODEL;
  const passDir = passDirOf(root, common.passId);
  const outcomes = runPass(common, {
    passDir,
    pluginDir: requireValue(flags, "--plugin-dir") ?? root,
    model: requireValue(flags, "--model", "a model id") ?? SESSION_MODEL,
    settingsFor: (arm) => benchSettings({ plugins: list.plugins, knobs: benchKnobs(arm, { implementerModel }) }),
    projectsRoot: claudeProjectsDir(),
    spawn: (args, { cwd, env }) => {
      const spec = spawnSpec(claude, args, env);
      const r = spawnSync(spec.file, spec.args, {
        cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30, windowsHide: true,
        timeout: legTimeoutSeconds * 1000, killSignal: "SIGKILL", ...spec.options,
      });
      if (r.error?.code === "ETIMEDOUT") throw Object.assign(new Error(`a leg ran past --leg-timeout ${legTimeoutSeconds} seconds and was killed`), { killed: true });
      if (r.error) throw new Error(`claude did not run: ${r.error.message}`);
      return r.stdout ?? "";
    },
  });
  for (const o of outcomes) console.log(`${o.id} ${o.arm}: ${o.outcome}, $${o.usd.toFixed(2)}, ${o.legs.length} legs${o.question ? ` — unanswered: ${o.question.slice(0, 200)}` : ""}${o.error ? ` — error: ${o.error.slice(0, 200)}` : ""}`);
  console.log(`pass ${common.passId}: ${passDir}`);
  if (outcomes.length) console.log("\n" + resultsMarkdown(scorePass(passDir)));
  return 0;
}

// Re-scores a finished pass from what it collected; launches nothing.
function score(argv, root) {
  const { flags } = parseFlags(argv, { "--pass": "value" });
  const passId = requireValue(flags, "--pass", "a pass id") ?? "1";
  const passDir = passDirOf(root, passId);
  if (!existsSync(passDir)) throw new PlanBenchError(`no pass ${passId} at ${passDir}`);
  console.log(resultsMarkdown(scorePass(passDir)));
  return 0;
}

// Subcommand name to handler (argv, root) → exit code.
export const SUBCOMMANDS = { estimate, run, score };

const USAGE = "usage: plan-bench.mjs <estimate|run|score> [--manifest <path>] [--arms status-quo,inline] [--entries <id,…>] [--budget <usd>] [--pass <id>] " +
  "[run: --go-ahead <token> --plugin-dir <checkout> --model <id> --implementer-model <id> --claude <bin> --leg-timeout <seconds>]";

export function main(argv, root = gitToplevel(process.cwd())) {
  const [sub, ...rest] = argv;
  const handler = SUBCOMMANDS[sub];
  if (!handler) {
    console.error(USAGE);
    return 1;
  }
  try {
    return handler(rest, root);
  } catch (err) {
    console.error(`plan-bench: ${err.message}`);
    return 1;
  }
}

if (isMain(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
