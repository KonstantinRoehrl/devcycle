#!/usr/bin/env node
// PostToolUse(Bash) hook — the workload commit-sensor (issue #139). After a coordinator commit it
// (re)writes the run's `workload` record itself, so collection never depends on an agent remembering
// the finish-stage step. It computes nothing: it re-derives run id, base sha, requestKind and plan
// counts from .devcycle/state.md and shells out to run-record.mjs, whose `workload` subcommand
// derives diffStats from git. Any error, malformed input, subagent origin, or absent/partial cycle =>
// exit 0 with no stdout (PostToolUse cannot block; that is the canonical no-op). Counts/enums only.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findStateFile } from "./lib/find-state-file.mjs";

const RUN_RECORD = fileURLToPath(new URL("../scripts/run-record.mjs", import.meta.url));
// Every post-planning, commit-bearing stage. A HEAD-advancing coordinator commit can land in any
// of these — branch-review (carry-over fixes), on-device (a verification fix), or finish — not only
// during execution. Pre-implementation stages (scoping/audit/diagnosis/brainstorm/planning) stay
// excluded so no workload is recorded before there is implementation work. Safe to fire in more
// stages: the diff is always base...HEAD, doctor's workload join is last-wins, and the cursor
// (lastHead+lastStage) still suppresses a redundant write at the same HEAD within a stage.
const COMMIT_STAGES = new Set([
  "execution", "fast-path", "sweep", "branch-review", "on-device", "finish",
]);

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

// The integration branches a topic branch may be cut from, in the order references/branch.md
// § Committing lists them. That file owns the list; this is its runtime spelling, which prose
// cannot hand a hook.
const INTEGRATION_BRANCHES = ["dev", "develop", "development", "integration"];

// The base to measure against when the branch line carries no `(cut from <base> at <sha>)`
// annotation. references/branch.md § "Deriving a branch's file set" → Base owns the rule this
// implements — the candidate set, the ancestry selection, and how each candidate is spelled; this
// is its runtime spelling, which prose cannot hand a hook. Sensor-local and not that file's:
// null — a no-op — when no candidate resolves, when HEAD is on a candidate branch itself, or when
// the nearest merge-base is HEAD (nothing landed yet, the same phantom-zero-diff guard the
// annotated path applies).
function deriveBase(repoRoot) {
  const git = (...args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  const remoteHead = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  const named = remoteHead.status === 0 ? remoteHead.stdout.trim().replace(/^origin\//, "") : "";
  // main/master trails the reported default rather than replacing it, so the fallback stays
  // reachable when `symbolic-ref` succeeds but names a branch this clone cannot resolve. The
  // order is the candidate set's enumeration only; it no longer decides which candidate wins.
  const candidates = [...new Set([...INTEGRATION_BRANCHES, ...(named ? [named] : []), "main", "master"])];

  const current = git("rev-parse", "--abbrev-ref", "HEAD");
  if (current.status !== 0) return null;
  const branch = current.stdout.trim();
  if (candidates.includes(branch)) return null;

  let nearest = null;
  for (const name of candidates) {
    const ref = [`refs/heads/${name}`, `refs/remotes/origin/${name}`]
      .find((r) => git("rev-parse", "--verify", "--quiet", r).status === 0);
    if (!ref) continue;
    const mergeBase = git("merge-base", ref, "HEAD");
    if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) continue;
    const base = mergeBase.stdout.trim();
    // Every candidate's merge-base is an ancestor of HEAD, so "nearer to HEAD" is exactly
    // "descends from the other": the incumbent loses when it is an ancestor of the challenger.
    // `--is-ancestor` also holds for two equal shas, so the `!==` keeps a tie with the earlier
    // candidate — the same sha either way, and deterministic in which candidate produced it.
    // Two bases on unrelated branches of the DAG are incomparable in both directions; the
    // incumbent keeps the slot, which is the candidate list's own order.
    if (nearest === null
      || (base !== nearest && git("merge-base", "--is-ancestor", nearest, base).status === 0)) {
      nearest = base;
    }
  }
  if (nearest === null) return null;
  const head = git("rev-parse", "HEAD");
  return head.status === 0 && head.stdout.trim() === nearest ? null : nearest;
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
  if (!st.run || !st.kind || st.kind === "audit" || !COMMIT_STAGES.has(st.stage)) return;
  const base = st.base ?? deriveBase(repoRoot);
  if (!base) return;

  const head = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return;
  const sha = head.stdout.trim();
  // Forbid a phantom zero-diff record when HEAD is still at the base commit (stage entered, no
  // commit yet — GC3). The pipeline records `base` ABBREVIATED (a 7-char sha in state.md), so a
  // raw `sha === st.base` never matches; normalize `base` to its full sha first. Fail-safe: an
  // unresolvable/garbage base (rev-parse non-zero) no-ops like every other unrecognized input.
  const baseFull = spawnSync("git", ["-C", repoRoot, "rev-parse", `${base}^{commit}`], { encoding: "utf8" });
  if (baseFull.status !== 0) return;
  if (sha === baseFull.stdout.trim()) return;

  const cursorPath = join(repoRoot, ".devcycle", "workload-cursor.json");
  let cursor = {};
  try { cursor = JSON.parse(readFileSync(cursorPath, "utf8")); } catch { /* first write */ }
  if (cursor.lastHead === sha && cursor.lastStage === st.stage) return;

  const w = spawnSync(process.execPath, [RUN_RECORD, "workload",
    "--run", st.run, "--base", base, "--requestKind", st.kind,
    "--planned-task-count", st.planned, "--wave-count", st.waves],
    { cwd: repoRoot, encoding: "utf8" });
  if (w.status !== 0) return;

  try {
    writeFileSync(cursorPath, JSON.stringify({ lastHead: sha, lastStage: st.stage }));
  } catch { /* cursor is best-effort */ }
}

try { main(); } catch { /* PostToolUse cannot block; any failure is a silent no-op */ }
process.exit(0);
