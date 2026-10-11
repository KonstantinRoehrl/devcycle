#!/usr/bin/env node
// SubagentStop hook — the dispatch depth-sensor. When a subagent finishes during an active cycle it
// appends one `agent-depth` run-record row: the agent's final context depth, model, tool uses and
// duration, read from the one transcript the hook input names, marked `warn` above DEPTH_WARN and
// `breach` above DEPTH_BREACH (a breach also appends a `depth-breach` event). Only a session that
// joined the run records: a parallel session in the same checkout reads the same state.md but never
// appended a `session` row. Observe-only: any error, malformed input, or absent/partial cycle =>
// exit 0 with no stdout. Counts/enums only.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_ID_CHARS, AGENT_TYPE_CHARS, MODEL_CHARS, clean, runContext, sessionJoined } from "./lib/run-context.mjs";
import { transcriptStats } from "../scripts/depth-probe.mjs";
import { isMain } from "../scripts/is-main.mjs";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
export const DEPTH_WARN = 150_000;
export const DEPTH_BREACH = 200_000;

export const depthOf = (tokens) => (tokens > DEPTH_BREACH ? "breach" : tokens > DEPTH_WARN ? "warn" : "ok");

function readInput() {
  const o = JSON.parse(readFileSync(0, "utf8") || "{}");
  return o && typeof o === "object" && !Array.isArray(o) ? o : null;
}

function main() {
  const input = readInput();
  if (!input || input.hook_event_name !== "SubagentStop" || typeof input.agent_transcript_path !== "string") return;
  const context = runContext(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!context) return;
  if (typeof input.session_id !== "string" || !input.session_id) return;
  if (!sessionJoined(context, input.session_id)) return;
  const { run, stage, repoRoot } = context;
  const stats = transcriptStats(input.agent_transcript_path);
  if (!stats) return;

  const depth = depthOf(stats.depth);
  // No --repo: run-record resolves the git toplevel from cwd, so the record lands under the same
  // real-path slug every other writer uses (macOS temp paths are symlinks).
  const append = (args) => spawnSync(process.execPath, [RUN_RECORD, "append", "--run", run, ...args],
    { cwd: repoRoot, encoding: "utf8", timeout: 2000 });
  const agentId = clean(input.agent_id, AGENT_ID_CHARS, 40);
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
