#!/usr/bin/env node
// Planning telemetry: one `plan-stats` run-record row per finished plan — sizes, how much of the
// plan is code fences, task and wave counts, and what the planning subagents cost. The pure
// planStats() derives the numbers; the CLI reads the run's own records, appends the row, and
// prints it so the planning stage can quote it.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { field } from "./md-field.mjs";
import { eachRecord } from "./jsonl.mjs";
import { parseDispatchMap, lineFences } from "./task-files.mjs";
import { gitToplevel, recordPath } from "./run-record.mjs";

const RUN_RECORD = fileURLToPath(new URL("./run-record.mjs", import.meta.url));
const STRATEGIES = ["inline", "delegated"];
const USAGE = "usage: plan-stats.mjs --state <state.md> --plan <path> --spec <path> --strategy inline|delegated";

// Bytes inside code fences, the fence lines themselves included. Pairing is task-files.mjs's
// fencedBlocks: a ``` or ~~~ fence closes only on its own character, at least as long.
function fencedBytes(planText) {
  const owners = lineFences(planText);
  return planText.split(/(?<=\n)/).reduce((bytes, line, i) => bytes + (owners[i] ? Buffer.byteLength(line) : 0), 0);
}

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
  const subagentsRan = strategy === "delegated" || rows.some((r) => r.kind === "agent-depth" && r.stage === "planning");
  const reviews = rows.filter((r) => r.kind === "event" && r.event === "spec-review");
  return {
    specBytes: Buffer.byteLength(specText),
    planBytes,
    fenceShare: planBytes === 0 ? 0 : Math.round((fencedBytes(planText) / planBytes) * 1000) / 1000,
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

function die(msg) {
  console.error(`plan-stats: ${msg}`);
  process.exit(1);
}

function readText(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return die(`cannot read ${what}: ${path}`);
  }
}

function main(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, { "--state": "value", "--plan": "value", "--spec": "value", "--strategy": "value" },
      { requireValues: "nonEmpty" }));
  } catch (e) {
    die(`${e.message} — ${USAGE}`);
  }
  for (const name of ["--state", "--plan", "--spec", "--strategy"]) if (!flags[name]) die(`${name} is required — ${USAGE}`);
  const strategy = flags["--strategy"];
  if (!STRATEGIES.includes(strategy)) die(`strategy must be inline or delegated, got "${strategy}"`);
  const runId = field(readText(flags["--state"], "state file"), "run");
  if (!/^[0-9a-f]{16}$/.test(runId ?? "")) die(`no run id in ${flags["--state"]}`);
  const planText = readText(flags["--plan"], "plan");
  const specText = readText(flags["--spec"], "spec");

  const toplevel = gitToplevel(process.cwd());
  const rows = [];
  eachRecord(recordPath(toplevel, runId), (row) => { rows.push(row); });
  const stats = planStats({ planText, specText, rows, strategy });

  const appended = spawnSync(process.execPath, [RUN_RECORD, "append", "--run", runId, "--repo", toplevel,
    "--kind", "plan-stats", "--stage", "planning",
    ...Object.entries(stats).flatMap(([k, v]) => [`--${k}`, String(v)])], { encoding: "utf8" });
  if (appended.status !== 0) die(`run-record append failed: ${(appended.stderr || "").trim().split("\n")[0]}`);
  console.log(JSON.stringify(stats));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
