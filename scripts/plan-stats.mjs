#!/usr/bin/env node
// Planning telemetry: one `plan-stats` run-record row per finished plan — sizes, how much of the
// plan is code fences, task and wave counts, and what the planning subagents cost. The pure
// planStats() derives the numbers; the CLI reads the run's own records, appends the row, and
// prints it so the planning stage can quote it. The row also records the planning estimate and the
// coordinator's depth at handoff, and the CLI prints the handoff `planning:` line, which sets that
// estimate beside this run's actual planning dollars.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { field } from "./md-field.mjs";
import { eachRecord } from "./jsonl.mjs";
import { fenceShare, nonTestFenceShare, parseDispatchMap } from "./task-files.mjs";
import { gitToplevel, hashSession, recordPath } from "./run-record.mjs";
import { readStage } from "./stage-log.mjs";
import { findTranscriptFiles, resolveDepth, resolveTranscript } from "./depth-probe.mjs";
import { groupFilesBySession, readRunRecords, summarizeSessionGroup } from "./doctor.mjs";
import { sumKnown } from "./doctor-planning.mjs";

const RUN_RECORD = fileURLToPath(new URL("./run-record.mjs", import.meta.url));
const STRATEGIES = ["inline", "delegated", "grouped", "checkpointed"];
const USAGE = "usage: plan-stats.mjs --state <state.md> --plan <path> --spec <path> --strategy inline|delegated|grouped|checkpointed";
const SPENT_USAGE = "usage: plan-stats.mjs spent --state <state.md>";

// The plan template puts "## Dispatch Map" last, and a plan may quote the heading earlier, so the
// last heading is the map. Null when the plan has none.
function lastDispatchMap(planText) {
  const headings = [...planText.matchAll(/^## Dispatch Map\s*$/gm)];
  if (!headings.length) return null;
  return parseDispatchMap(planText.slice(headings.at(-1).index));
}

export function planStats({ planText, specText, rows, strategy }) {
  const planBytes = Buffer.byteLength(planText);
  const map = lastDispatchMap(planText);
  const planning = rows.filter((r) => r.kind === "agent-cost" && r.stage === "planning");
  // Planning subagents ran when the plan is delegated or any planning agent-depth row exists; with no
  // cost row to price them their dollars are unmeasurable, which is null and never 0.
  const subagentsRan = strategy === "delegated" || strategy === "grouped" || rows.some((r) => r.kind === "agent-depth" && r.stage === "planning");
  const reviews = rows.filter((r) => r.kind === "event" && r.event === "spec-review");
  return {
    specBytes: Buffer.byteLength(specText),
    planBytes,
    fenceShare: fenceShare(planText),
    nonTestFenceShare: nonTestFenceShare(planText),
    tasks: map ? new Set([...map.values()].flat()).size : (planText.match(/^### Task \d+:/gm) ?? []).length,
    waves: map ? map.size : 0,
    drafters: new Set(planning.filter((r) => r.role === "drafter").map((r) => r.agentId)).size,
    subagentUsd: planning.some((r) => typeof r.usd !== "number") || (planning.length === 0 && subagentsRan)
      ? null
      : Math.round(planning.reduce((sum, r) => sum + r.usd, 0) * 1e6) / 1e6,
    specReview: reviews.at(-1)?.result ?? null,
    strategy,
  };
}

// The estimate for the whole planning stage: what the stage logged when it chose how to draft (the
// remaining cost) plus the spend it logged at the cut, so it compares with planningActual, which
// holds both. A row without a numeric spent (an older run) is the estimate alone; no est is null.
export function planningEstimate(stageRows) {
  const { est, spent } = stageRows.find((r) => r.key === "drafting-plan")?.data ?? {};
  if (typeof est !== "number") return null;
  return typeof spent === "number" ? Math.round((est + spent) * 1e6) / 1e6 : est;
}

// The coordinator's context depth at handoff, as a percent of its window to one decimal. Null when
// the session or its transcript cannot be found: a missing figure never fails the handoff.
export function coordinatorDepth(env, cwd) {
  try {
    const { fraction } = resolveDepth(env, cwd);
    return typeof fraction === "number" ? Math.round(fraction * 1000) / 10 : null;
  } catch {
    return null;
  }
}

// This run's planning-stage dollars: the planning cost of every transcript, subagents included, that
// belongs to a session of the run. Unrounded; null when nothing is known or anything cannot be read.
export function planningActual(env, cwd, sessionHashes) {
  try {
    const files = findTranscriptFiles(dirname(resolveTranscript(env, cwd))) ?? [];
    const runRecords = readRunRecords(env.DEVCYCLE_RUNS_DIR);
    const planning = [...groupFilesBySession(files)]
      .filter(([key]) => sessionHashes.includes(hashSession(key)))
      .map(([key, group]) => summarizeSessionGroup(key, group, [{}], { all: true }, runRecords)[0]?.costByStage?.planning);
    return sumKnown(planning);
  } catch {
    return null;
  }
}

const dollars = (v) => (v === null ? "?" : `$${v.toFixed(2)}`);

export function planningLine({ strategy, drafters, estUsd, actualUsd }) {
  return `planning: strategy=${strategy} drafters=${drafters} est=${dollars(estUsd)} actual=${dollars(actualUsd)}`;
}

function die(msg, code = 1) {
  console.error(`plan-stats: ${msg}`);
  process.exit(code);
}

const usageError = (msg) => die(msg, 2);

function readText(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return die(`cannot read ${what}: ${path}`);
  }
}

// The run id of a state file and the run's own records, which name its sessions.
function runOf(statePath, cwd) {
  const runId = field(readText(statePath, "state file"), "run");
  if (!/^[0-9a-f]{16}$/.test(runId ?? "")) die(`no run id in ${statePath}`);
  const toplevel = gitToplevel(cwd);
  const rows = [];
  eachRecord(recordPath(toplevel, runId), (row) => { rows.push(row); });
  return { runId, toplevel, rows };
}

const sessionHashesOf = (rows) => rows.filter((r) => r.kind === "session").map((r) => r.sessionHash);

// `spent`: the planning dollars spent so far, which the cut logs beside its estimate.
function spent(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, { "--state": "value" }, { requireValues: "nonEmpty" }));
  } catch (e) {
    usageError(`${e.message} — ${SPENT_USAGE}`);
  }
  if (!flags["--state"]) usageError(`--state is required — ${SPENT_USAGE}`);
  const cwd = process.cwd();
  const { rows } = runOf(flags["--state"], cwd);
  const usd = planningActual(process.env, cwd, sessionHashesOf(rows));
  console.log(usd === null ? "null" : usd.toFixed(2));
}

function main(argv) {
  if (argv[0] === "spent") return spent(argv.slice(1));
  let flags;
  try {
    ({ flags } = parseFlags(argv, { "--state": "value", "--plan": "value", "--spec": "value", "--strategy": "value" },
      { requireValues: "nonEmpty" }));
  } catch (e) {
    die(`${e.message} — ${USAGE}`);
  }
  for (const name of ["--state", "--plan", "--spec", "--strategy"]) if (!flags[name]) die(`${name} is required — ${USAGE}`);
  const strategy = flags["--strategy"];
  if (!STRATEGIES.includes(strategy)) die(`strategy must be one of ${STRATEGIES.join(", ")}, got "${strategy}"`);
  const cwd = process.cwd();
  const { runId, toplevel, rows } = runOf(flags["--state"], cwd);
  const planText = readText(flags["--plan"], "plan");
  const specText = readText(flags["--spec"], "spec");
  const estUsd = planningEstimate(readStage(dirname(flags["--state"]), { run: runId, stage: "planning" }));
  const stats = { ...planStats({ planText, specText, rows, strategy }), estUsd, coordinatorDepthPct: coordinatorDepth(process.env, cwd) };
  const actualUsd = planningActual(process.env, cwd, sessionHashesOf(rows));

  const appended = spawnSync(process.execPath, [RUN_RECORD, "append", "--run", runId, "--repo", toplevel,
    "--kind", "plan-stats", "--stage", "planning",
    ...Object.entries(stats).flatMap(([k, v]) => [`--${k}`, String(v)])], { encoding: "utf8" });
  if (appended.status !== 0) die(`run-record append failed: ${(appended.stderr || "").trim().split("\n")[0]}`);
  console.log(JSON.stringify(stats));
  console.log(planningLine({ strategy, drafters: stats.drafters, estUsd, actualUsd }));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
