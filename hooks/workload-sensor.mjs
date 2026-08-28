#!/usr/bin/env node
// PostToolUse(Bash) hook — the workload commit-sensor (issue #139). After a coordinator commit it
// (re)writes the run's `workload` record itself, so collection never depends on an agent remembering
// the finish-stage step. It computes nothing: it re-derives run id, base sha, requestKind and plan
// counts from .devcycle/state.md and shells out to run-record.mjs, whose `workload` subcommand
// derives diffStats from git. Any error, malformed input, subagent origin, or absent/partial cycle =>
// exit 0 with no stdout (PostToolUse cannot block; that is the canonical no-op). Counts/enums only.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
const ACTIVE_STAGES = new Set(["execution", "fast-path", "sweep"]);

// Returns the parsed stdin object, or `null` as a distinct sentinel for "unreadable" — a JSON
// parse failure or a parse result that isn't a plain object (array, string, number, null). `null`
// is never confused with a genuine empty `{}` input: a parse failure must not silently discard
// `agent_type`/`agent_id` and let the call fall through the subagent-origin guard below (round-1
// finding — malformed stdin from a subagent bypassed QC2 because `{}` reads as "no agent_type").
function readInput() {
  try {
    const parsed = JSON.parse(readFileSync(0, "utf8") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

// Bounded walk from `start` upward for a dir holding .devcycle/state.md. No git spawn: the idle
// path (a Bash call outside any cycle — the common case) must stay near-free (QC2).
function findStateFile(start) {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const p = join(dir, ".devcycle", "state.md");
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function field(text, name) {
  const m = text.match(new RegExp(`^- ${name}:\\s*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

function parseState(text) {
  const branch = field(text, "branch") ?? "";
  const baseMatch = branch.match(/\(cut from .+ at ([0-9a-f]{7,40})\)/);
  const counts = field(text, "plan-counts") ?? "";
  const planned = counts.match(/planned=(\d+)/);
  const waves = counts.match(/waves=(\d+)/);
  return {
    stage: field(text, "stage"), kind: field(text, "kind"), run: field(text, "run"),
    base: baseMatch ? baseMatch[1] : null,
    planned: planned ? planned[1] : "0", waves: waves ? waves[1] : "0",
  };
}

function main() {
  const input = readInput();
  // Unreadable stdin (malformed JSON, or a parsed shape that isn't a plain object) must stop here,
  // before any state read or git spawn — falling through with a stand-in `{}` would silently
  // discard agent_type/agent_id and defeat the subagent-origin guard just below (QC1/QC2, round 1).
  if (!input) return;
  // Commits are the coordinator's, on the main thread; a subagent Bash call never moves the cycle's
  // HEAD. Skipping subagent-origin calls keeps the sensor near-free for the bulk of Bash calls and
  // mirrors block-main-thread-browser.mjs's origin read (agent_type present => inside a subagent).
  if (input.agent_type || input.agent_id) return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const stateFile = findStateFile(cwd);
  if (!stateFile) return;
  const repoRoot = dirname(dirname(stateFile));
  const st = parseState(readFileSync(stateFile, "utf8"));
  if (!st.run || !st.base || !st.kind || st.kind === "audit" || !ACTIVE_STAGES.has(st.stage)) return;

  const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return;
  const sha = head.stdout.trim();
  if (sha === st.base) return;

  const cursorPath = join(repoRoot, ".devcycle", "workload-cursor.json");
  let cursor = {};
  try { cursor = JSON.parse(readFileSync(cursorPath, "utf8")); } catch { /* first write */ }
  if (cursor.lastHead === sha && cursor.lastStage === st.stage) return;

  const w = spawnSync(process.execPath, [RUN_RECORD, "workload",
    "--run", st.run, "--base", st.base, "--requestKind", st.kind,
    "--planned-task-count", st.planned, "--wave-count", st.waves],
    { cwd: repoRoot, encoding: "utf8" });
  if (w.status !== 0) return;

  try {
    writeFileSync(cursorPath, JSON.stringify({ lastHead: sha, lastStage: st.stage }));
  } catch { /* cursor is best-effort */ }
}

try { main(); } catch { /* PostToolUse cannot block; any failure is a silent no-op */ }
process.exit(0);
