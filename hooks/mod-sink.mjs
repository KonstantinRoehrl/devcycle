#!/usr/bin/env node
// The hooks module's Node side. hooks/devcycle-mod.mjs runs without Node, so it spawns this file for
// the two things that need it — whether this session joined the active run, and appending one
// agent-trace run-record row per finished subagent turn:
//   node hooks/mod-sink.mjs check-joined --run <id> --session <id> --cwd <dir>   prints joined | not-joined
//   node hooks/mod-sink.mjs append    stdin: {"run","session","cwd","record"}
// The row's stage is the state file's stage now, at the subagent's stop, as agent-depth's is.
// Observe-only, like the sensors: malformed input or any failure is a silent no-op, exit 0.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../scripts/cli-flags.mjs";
import { isMain } from "../scripts/is-main.mjs";
import { AGENT_ID_CHARS, AGENT_TYPE_CHARS, MODEL_CHARS, clean, runContext, sessionJoined } from "./lib/run-context.mjs";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
const COUNTS = ["steps", "peakDepth", "toolResultChars", "warned", "refused"];
const FLAGS = ["background", "fork", "windowAssumed", "isAborted"];
const BANDS = new Set(["ok", "over-budget", "hard-stop"]);
const REASONS = new Set(["answer", "aborted", "refusal", "error"]);

// The run this session joined, or null: the state file above `cwd` names `run` as its active run,
// and the run record carries a session row for `session`.
function joinedContext(run, session, cwd) {
  if (typeof run !== "string" || typeof session !== "string" || !session || typeof cwd !== "string" || !cwd) return null;
  const context = runContext(cwd);
  return context && context.run === run && sessionJoined(context, session) ? context : null;
}

// run-record's literal null for a nullable field the record left empty, or cleaned to nothing.
const orNull = (s, chars, max) => (s === null || s === undefined ? "null" : clean(s, chars, max) || "null");

function traceArgs(stage, record) {
  if (!record || typeof record !== "object") return null;
  const agentId = clean(record.agentId, AGENT_ID_CHARS, 40);
  if (!agentId || !REASONS.has(record.reason)) return null;
  if (COUNTS.some((k) => !Number.isInteger(record[k]) || record[k] < 0)) return null;
  return ["--kind", "agent-trace", "--stage", stage, "--agentId", agentId,
    "--agentType", orNull(record.agentType, AGENT_TYPE_CHARS, 80),
    "--requestedModel", orNull(record.requestedModel, MODEL_CHARS, 80),
    "--resolvedModel", orNull(record.resolvedModel, MODEL_CHARS, 80),
    "--parentAgentId", orNull(record.parentAgentId, AGENT_ID_CHARS, 40),
    ...FLAGS.flatMap((k) => [`--${k}`, String(record[k] === true)]),
    ...COUNTS.flatMap((k) => [`--${k}`, String(record[k])]),
    "--window", Number.isInteger(record.window) && record.window > 0 ? String(record.window) : "null",
    "--peakBand", BANDS.has(record.peakBand) ? record.peakBand : "null",
    "--reason", record.reason];
}

function append(envelope) {
  const context = joinedContext(envelope?.run, envelope?.session, envelope?.cwd);
  if (!context) return;
  const args = traceArgs(context.stage, envelope.record);
  if (!args) return;
  // No --repo: run-record resolves the git toplevel from cwd, so the row lands under the same
  // real-path slug every other writer uses.
  spawnSync(process.execPath, [RUN_RECORD, "append", "--run", context.run, ...args],
    { cwd: context.repoRoot, encoding: "utf8", timeout: 2000 });
}

function checkJoined(argv) {
  let joined = false;
  try {
    const { flags } = parseFlags(argv, { "--run": "value", "--session": "value", "--cwd": "value" });
    joined = joinedContext(flags["--run"], flags["--session"], flags["--cwd"]) !== null;
  } catch { /* an unreadable answer is not-joined */ }
  process.stdout.write(joined ? "joined\n" : "not-joined\n");
}

function main([mode, ...rest]) {
  if (mode === "check-joined") checkJoined(rest);
  else if (mode === "append") append(JSON.parse(readFileSync(0, "utf8") || "null"));
}

if (isMain(import.meta.url, process.argv[1])) {
  try { main(process.argv.slice(2)); } catch { /* observe-only: any failure is a silent no-op */ }
  process.exit(0);
}
