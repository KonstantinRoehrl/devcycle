#!/usr/bin/env node
// SubagentStop and Stop hook — the dispatch depth-sensor. On Stop it only holds the live driver's own
// session in its turn while a dispatch it started still works (holdDrivenTurn). On SubagentStop it first decides a hold: an implementer stopping
// before its owed report is told to carry on (`decision: block`), bounded by scripts/dispatch-health.mjs.
// On a stop it releases during an active cycle it appends one `agent-depth` run-record row (the agent's
// final context depth, model, tool uses and duration, read from the one transcript the hook input names,
// marked `warn` above DEPTH_WARN and `breach` above DEPTH_BREACH; a breach also appends a `depth-breach`
// event), marks the agent's dispatch record ended and retires it in .devcycle/processes.jsonl. Only a
// session that joined the run records: a parallel session in the same checkout reads the same state.md
// but never appended a `session` row. Any error is observe-only: it, malformed input, or an
// absent/partial cycle => exit 0 with no stdout. Counts/enums only.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_ID_CHARS, AGENT_TYPE_CHARS, MODEL_CHARS, clean, runContext, sessionJoined } from "./lib/run-context.mjs";
import { transcriptReads, transcriptStats } from "../scripts/depth-probe.mjs";
import { priceTranscript } from "../scripts/dispatch-cost.mjs";
import { holdStop, holdTurnEnd, markEnded, markStopped } from "../scripts/dispatch-health.mjs";
import { holdsDriveToken } from "../scripts/drive-lock.mjs";
import { isMain } from "../scripts/is-main.mjs";
import { eachRecord } from "../scripts/jsonl.mjs";
import { retireProcess } from "../scripts/process-registry.mjs";
import { gitToplevel, recordPath } from "../scripts/run-record.mjs";
import { now } from "../scripts/stamp.mjs";
import { stopPaths, stopWindowOpen } from "../scripts/stop-files.mjs";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
export const DEPTH_WARN = 150_000;
export const DEPTH_BREACH = 200_000;
const TASK_ID = /^[0-9A-Za-z_-]{1,64}$/;

export const depthOf = (tokens) => (tokens > DEPTH_BREACH ? "breach" : tokens > DEPTH_WARN ? "warn" : "ok");

// The planning role a dispatch description names: the `plan-<role>: ` prefix and nothing else.
const ROLE_PREFIX = /^plan-(spike|research|drafter|checker|repair): /;
export const roleOf = (description) => (typeof description === "string" ? ROLE_PREFIX.exec(description)?.[1] ?? null : null);
// A fork records `model: "inherit"` in its sidecar: it took its parent's model rather than being given one.
export const namesModel = (sidecar) => typeof sidecar.model === "string" && sidecar.model !== "" && sidecar.model !== "inherit";
// A checker dispatch's "plan-checker: round <n>" tag: the n-th re-check of one plan, so doctor counts rounds, not agents.
const ROUND_TAG = /^plan-checker: round (\d+)\b/;
export const roundOf = (description) => (typeof description === "string" ? Number(ROUND_TAG.exec(description)?.[1] ?? NaN) || null : null);

// `unpriced-model:<id>` is the longest measurement; the id is cleaned to MODEL_CHARS and 80 characters first.
const MEASUREMENT_MAX = 120;
const COST_COUNTS = ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "turns", "sourcePrints"];

// What an agent spent since its earlier agent-cost rows of this run: its transcript is cumulative,
// so a resumed agent's later stop must not count the first stop's turns again. A null usd on either
// side makes the difference unknowable; a count is clamped because a transcript can only shrink by
// being rewritten, and a row's schema forbids negatives. A count the totals do not carry is not
// measured, and an earlier row written before a count existed contributes nothing to it. `reads` is
// a delta per path: a path whose estimate did not grow is dropped.
export function costDelta(totals, earlier) {
  const delta = { continuationOf: earlier.length };
  for (const key of COST_COUNTS.filter((k) => k in totals))
    delta[key] = Math.max(0, totals[key] - earlier.reduce((sum, row) => sum + (row[key] ?? 0), 0));
  if (totals.reads) {
    delta.reads = {};
    for (const [path, tokens] of Object.entries(totals.reads)) {
      const grown = tokens - earlier.reduce((sum, row) => sum + (row.reads?.[path] ?? 0), 0);
      if (grown > 0) delta.reads[path] = grown;
    }
  }
  delta.usd = totals.usd === null || earlier.some((row) => row.usd === null)
    ? null
    : Math.max(0, totals.usd - earlier.reduce((sum, row) => sum + row.usd, 0));
  return delta;
}

// The agent's sidecar sits beside its transcript. Missing or unreadable is "unknown", never a fault.
function readSidecar(transcriptPath) {
  try { return JSON.parse(readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8")) ?? {}; } catch { return {}; }
}

function earlierCostRows(repoRoot, run, agentId) {
  const rows = [];
  eachRecord(recordPath(gitToplevel(repoRoot), run), (r) => {
    if (r.kind === "agent-cost" && r.agentId === agentId) rows.push(r);
  });
  return rows;
}

function readInput() {
  const o = JSON.parse(readFileSync(0, "utf8") || "{}");
  return o && typeof o === "object" && !Array.isArray(o) ? o : null;
}

// Stop: only the live driver's own session is held, while a dispatch it started is still working and
// no stop window is open (scripts/dispatch-health.mjs holdTurnEnd). A walked session waiting on a
// notification is correct, so it is never held.
function holdDrivenTurn(input, context) {
  if (!holdsDriveToken(context.repoRoot, context.stateFile, process.env.DEVCYCLE_DRIVE_TOKEN)) return;
  if (stopWindowOpen(dirname(context.stateFile), readFileSync(context.stateFile, "utf8")) !== false) return;
  const held = holdTurnEnd({ root: context.repoRoot, sessionId: input.session_id });
  if (held.hold) process.stdout.write(JSON.stringify({ decision: "block", reason: held.reason }) + "\n");
}

function main() {
  const input = readInput();
  if (!input || (input.hook_event_name !== "SubagentStop" && input.hook_event_name !== "Stop")) return;
  const context = runContext(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!context) return;
  if (typeof input.session_id !== "string" || !input.session_id) return;
  if (!sessionJoined(context, input.session_id)) return;
  if (input.hook_event_name === "Stop") return holdDrivenTurn(input, context);
  const { run, stage, repoRoot } = context;
  const devcycleDir = dirname(context.stateFile);
  const agentId = clean(input.agent_id, AGENT_ID_CHARS, 40);
  // Without a transcript there is nothing to hold, mark or measure, but the registry still retires the agent.
  const transcriptPath = typeof input.agent_transcript_path === "string" ? input.agent_transcript_path : null;
  const markInput = { root: repoRoot, sessionId: input.session_id, transcriptPath, agentId: agentId || null };
  // null when the state file cannot be read: then nothing is held and the record is left alone, as before.
  let stopWindow = null;
  try { stopWindow = stopWindowOpen(devcycleDir, readFileSync(context.stateFile, "utf8")); } catch { /* observe-only */ }
  // A held stop is not an end, so nothing below runs for it; scripts/dispatch-health.mjs decides the hold.
  let held = null;
  try {
    if (transcriptPath) held = holdStop({ ...markInput, backgroundTasks: Array.isArray(input.background_tasks) ? input.background_tasks : [], stopWindow: stopWindow !== false });
  } catch { /* observe-only */ }
  if (held?.hold) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: held.reason }) + "\n");
    return;
  }
  // The dispatch record learns its agent stopped (scripts/dispatch-health.mjs reads it as ended, or,
  // during a /devcycle:stop, as neither in flight nor dead); a failure here never costs the depth row.
  try {
    if (transcriptPath && stopWindow !== null) (stopWindow ? markStopped : markEnded)(markInput);
  } catch { /* observe-only */ }
  // The one SubagentStop handler retires the agent in /devcycle:stop's registry, on a stop it released.
  try {
    if (TASK_ID.test(input.agent_id ?? "") && existsSync(stopPaths(devcycleDir).processes))
      retireProcess(devcycleDir, input.agent_id, { endedAt: now(), endedBy: "finished" });
  } catch { /* observe-only */ }
  const stats = transcriptPath && transcriptStats(transcriptPath);
  if (!stats) return;

  const depth = depthOf(stats.depth);
  // No --repo: run-record resolves the git toplevel from cwd, so the record lands under the same
  // real-path slug every other writer uses (macOS temp paths are symlinks).
  const append = (args) => spawnSync(process.execPath, [RUN_RECORD, "append", "--run", run, ...args],
    { cwd: repoRoot, encoding: "utf8", timeout: 2000 });
  const w = append(["--kind", "agent-depth", "--stage", stage,
    "--agentType", clean(input.agent_type, AGENT_TYPE_CHARS, 80) || "unknown",
    ...(agentId ? ["--agentId", agentId] : []),
    "--model", clean(stats.model, MODEL_CHARS, 80) || "unknown",
    "--tokens", String(stats.depth), "--toolUses", String(stats.toolUses), "--durationMs", String(stats.durationMs),
    "--depth", depth]);
  if (w.status === 0 && depth === "breach") append(["--kind", "event", "--event", "depth-breach", "--stage", stage]);

  // The agent's spend, a delta over its earlier rows of this run. Without an agentId there is no key
  // to take that delta against, so no row is written rather than one that would double-count.
  try {
    if (!agentId) return;
    const sidecar = readSidecar(transcriptPath);
    const earlier = earlierCostRows(repoRoot, run, agentId);
    // A SendMessage repair makes no new dispatch, so it carries the drafter's original description: a resumed drafter is repairing.
    const named = roleOf(sidecar.description);
    const role = named === "drafter" && earlier.length > 0 ? "repair" : named;
    const round = role === "checker" ? roundOf(sidecar.description) : null;
    const priced = priceTranscript(transcriptPath);
    // A planning dispatch also records what it read; `reads` is written even when empty, so its
    // presence says the row was measured.
    const cost = costDelta(role ? { ...priced, ...transcriptReads(transcriptPath) } : priced, earlier);
    // A null usd says why: the transcript's own measurement, or, when only an earlier row was unpriced, that.
    const measurement = cost.usd === null ? clean(priced.usd === null ? priced.measurement : "earlier-row-unpriced", MODEL_CHARS, MEASUREMENT_MAX) : "";
    append(["--kind", "agent-cost", "--stage", stage,
      "--agentType", clean(input.agent_type, AGENT_TYPE_CHARS, 80) || "unknown",
      "--agentId", agentId,
      "--model", clean(stats.model, MODEL_CHARS, 80) || "unknown",
      ...(round !== null ? ["--round", String(round)] : []),
      ...(role ? ["--role", role, "--sourcePrints", String(cost.sourcePrints), "--reads", JSON.stringify(cost.reads)] : []),
      "--explicitModel", String(namesModel(sidecar)),
      "--inputTokens", String(cost.inputTokens), "--cacheWriteTokens", String(cost.cacheWriteTokens),
      "--cacheReadTokens", String(cost.cacheReadTokens), "--outputTokens", String(cost.outputTokens),
      "--usd", String(cost.usd), ...(measurement ? ["--measurement", measurement] : []), "--turns", String(cost.turns), "--continuationOf", String(cost.continuationOf)]);
  } catch { /* observe-only */ }
}

if (isMain(import.meta.url, process.argv[1])) {
  try { main(); } catch { /* both events are observe-only here: any failure is a silent no-op */ }
  process.exit(0);
}
