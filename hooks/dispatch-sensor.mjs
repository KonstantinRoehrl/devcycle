#!/usr/bin/env node
// SubagentStop hook — the dispatch depth-sensor. It first decides a hold: an implementer stopping
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
import { transcriptStats } from "../scripts/depth-probe.mjs";
import { holdStop, markEnded, markStopped } from "../scripts/dispatch-health.mjs";
import { isMain } from "../scripts/is-main.mjs";
import { retireProcess } from "../scripts/process-registry.mjs";
import { now } from "../scripts/stamp.mjs";
import { stopPaths, stopWindowOpen } from "../scripts/stop-files.mjs";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
export const DEPTH_WARN = 150_000;
export const DEPTH_BREACH = 200_000;
const TASK_ID = /^[0-9A-Za-z_-]{1,64}$/;

export const depthOf = (tokens) => (tokens > DEPTH_BREACH ? "breach" : tokens > DEPTH_WARN ? "warn" : "ok");

function readInput() {
  const o = JSON.parse(readFileSync(0, "utf8") || "{}");
  return o && typeof o === "object" && !Array.isArray(o) ? o : null;
}

function main() {
  const input = readInput();
  if (!input || input.hook_event_name !== "SubagentStop") return;
  const context = runContext(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!context) return;
  if (typeof input.session_id !== "string" || !input.session_id) return;
  if (!sessionJoined(context, input.session_id)) return;
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
  if (w.status !== 0 || depth !== "breach") return;
  append(["--kind", "event", "--event", "depth-breach", "--stage", stage]);
}

if (isMain(import.meta.url, process.argv[1])) {
  try { main(); } catch { /* SubagentStop is observe-only here: any failure is a silent no-op */ }
  process.exit(0);
}
