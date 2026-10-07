#!/usr/bin/env node
// SubagentStop hook — the dispatch depth-sensor. When a subagent finishes during an active cycle it
// appends one `agent-depth` run-record row: the agent's final context depth, model, tool uses and
// duration, read from the one transcript the hook input names, marked `warn` above DEPTH_WARN and
// `breach` above DEPTH_BREACH (a breach also appends a `depth-breach` event). Observe-only: any
// error, malformed input, or absent/partial cycle => exit 0 with no stdout. Counts/enums only.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findStateFile } from "./lib/find-state-file.mjs";
import { field } from "../scripts/md-field.mjs";
import { transcriptStats } from "../scripts/depth-probe.mjs";
import { isMain } from "../scripts/is-main.mjs";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
export const DEPTH_WARN = 150_000;
export const DEPTH_BREACH = 200_000;
const STAGES = new Set(["scoping", "audit", "diagnosis", "brainstorm", "planning", "execution",
  "branch-review", "on-device", "fast-path", "sweep", "finish", "maintain"]);

export const depthOf = (tokens) => (tokens > DEPTH_BREACH ? "breach" : tokens > DEPTH_WARN ? "warn" : "ok");

// Hook input is model-adjacent text: drop everything outside the schema's charset (control
// characters included) and cap length. run-record rejects a row that misses its schema pattern,
// so a substitute character the charset lacks would lose the whole row.
const clean = (s, disallowed, max) => String(s ?? "").replace(disallowed, "").slice(0, max);

function readInput() {
  const o = JSON.parse(readFileSync(0, "utf8") || "{}");
  return o && typeof o === "object" && !Array.isArray(o) ? o : null;
}

function main() {
  const input = readInput();
  if (!input || input.hook_event_name !== "SubagentStop" || typeof input.agent_transcript_path !== "string") return;
  const stateFile = findStateFile(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!stateFile) return;
  const state = readFileSync(stateFile, "utf8");
  const run = field(state, "run");
  const stage = field(state, "stage");
  if (!/^[0-9a-f]{16}$/.test(run ?? "") || !STAGES.has(stage)) return;
  const stats = transcriptStats(input.agent_transcript_path);
  if (!stats) return;

  const repoRoot = dirname(dirname(stateFile));
  const depth = depthOf(stats.depth);
  // No --repo: run-record resolves the git toplevel from cwd, so the record lands under the same
  // real-path slug every other writer uses (macOS temp paths are symlinks).
  const append = (args) => spawnSync(process.execPath, [RUN_RECORD, "append", "--run", run, ...args],
    { cwd: repoRoot, encoding: "utf8", timeout: 2000 });
  const agentId = clean(input.agent_id, /[^0-9a-z]/g, 40);
  const w = append(["--kind", "agent-depth", "--stage", stage,
    "--agentType", clean(input.agent_type, /[^A-Za-z0-9:_.-]/g, 80) || "unknown",
    ...(agentId ? ["--agentId", agentId] : []),
    "--model", clean(stats.model, /[^A-Za-z0-9:_.[\]-]/g, 80) || "unknown",
    "--tokens", String(stats.depth), "--toolUses", String(stats.toolUses), "--durationMs", String(stats.durationMs),
    "--depth", depth]);
  if (w.status !== 0 || depth !== "breach") return;
  append(["--kind", "event", "--event", "depth-breach", "--stage", stage]);
}

if (isMain(import.meta.url, process.argv[1])) {
  try { main(); } catch { /* SubagentStop is observe-only here: any failure is a silent no-op */ }
  process.exit(0);
}
