#!/usr/bin/env node
// PostToolUse(Bash) hook: tells the coordinator of a joined session about process groups that look
// leaked (scripts/leftover-processes.mjs owns the signature, #395). Main thread only: a subagent told
// about a sibling's leak can neither judge nor relay it. Each group is reported once per run, from a
// small .devcycle file whose modification time is also the throttle. A leak must be 60 seconds old to
// count, so a 30-second throttle loses almost nothing, and no shape check excludes most Bash calls the
// way process-sensor's does: everything past the throttle, and its git and ps spawns, loads lazily.
// Observe-only: any error, malformed input or missing ps exits 0 with no stdout.
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findStateFile } from "./lib/find-state-file.mjs";

const THROTTLE_MS = 30_000;
const REPORTED_FILE = "leftovers-reported.json";

function throttled(path, nowMs) {
  return existsSync(path) && nowMs - statSync(path).mtimeMs < THROTTLE_MS;
}
function stamp(path, nowMs) {
  if (existsSync(path)) utimesSync(path, new Date(nowMs), new Date(nowMs));
  else writeFileSync(path, "{}\n");
}
// The groups already reported for this run; another run's list, or an unreadable file, is none.
function reportedFor(path, run) {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    return saved.run === run && Array.isArray(saved.reported) ? saved.reported : [];
  } catch {
    return [];
  }
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (input.agent_type || typeof input.session_id !== "string" || !input.session_id) return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const stateFile = findStateFile(cwd);
  if (!stateFile) return;
  const path = join(dirname(stateFile), REPORTED_FILE);
  const nowMs = Date.now();
  if (throttled(path, nowMs)) return;
  stamp(path, nowMs);
  const { runContext, sessionJoined } = await import("./lib/run-context.mjs");
  const context = runContext(cwd);
  if (!context || !sessionJoined(context, input.session_id)) return;
  const [{ formatReport, scanLeftovers }, { atomicWrite }] = await Promise.all([
    import("../scripts/leftover-processes.mjs"), import("../scripts/atomic-write.mjs"),
  ]);
  const reported = reportedFor(path, context.run);
  const fresh = scanLeftovers().filter((group) => !reported.includes(group.pgid));
  atomicWrite(path, `${JSON.stringify({ run: context.run, reported: [...reported, ...fresh.map((group) => group.pgid)] })}\n`);
  if (!fresh.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: formatReport(fresh) },
  }));
}

try { await main(); } catch { /* observe-only: any failure is a silent no-op */ }
process.exit(0);
