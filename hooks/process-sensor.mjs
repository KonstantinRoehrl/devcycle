#!/usr/bin/env node
// PostToolUse, Stop and SubagentStop hook — feeds scripts/process-registry.mjs for sessions joined to
// the run. Ids come from the launching tool's response, because Stop's background_tasks never lists a
// Monitor. A task stopped with TaskStop gets no SubagentStop, so its PostToolUse retires it; Stop then
// reconciles what ended by itself, and is idempotent because it fires once per wake-up. SubagentStop
// retires only itself: its array lists the stopping subagent as running. Observe-only: any error,
// malformed input or absent cycle exits 0 with no stdout. Most Bash calls end at the shape check, which
// is why everything past it, and its git spawn, is imported lazily.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const TASK_ID = /^[0-9A-Za-z_-]{1,64}$/;

function launchOf({ tool_name: tool, tool_response: response }, now) {
  if (tool === "Agent" && response?.status === "async_launched") return { id: response.agentId, kind: "subagent" };
  if (tool === "Bash") return { id: response?.backgroundTaskId, kind: "shell" };
  if (tool !== "Monitor") return null;
  const expires = !response?.persistent && Number.isFinite(response?.timeoutMs);
  return { id: response?.taskId, kind: "monitor", ...(expires ? { expiresAt: new Date(now + response.timeoutMs).toISOString() } : {}) };
}

// What this input asks of the registry, read from its shape alone, or null for nothing.
function actionOf(input, now) {
  const event = input.hook_event_name;
  if (event === "Stop") return Array.isArray(input.background_tasks) ? { reconcile: input.background_tasks } : null;
  if (event === "SubagentStop") return TASK_ID.test(input.agent_id ?? "") ? { retire: input.agent_id, endedBy: "finished" } : null;
  if (event !== "PostToolUse") return null;
  if (input.tool_name === "TaskStop") return TASK_ID.test(input.tool_input?.task_id ?? "") ? { retire: input.tool_input.task_id, endedBy: "taskstop" } : null;
  const launch = launchOf(input, now);
  return launch && TASK_ID.test(launch.id ?? "") ? { launch } : null;
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const nowMs = Date.now();
  const action = actionOf(input, nowMs);
  if (!action || typeof input.session_id !== "string" || !input.session_id) return;
  const { runContext, sessionJoined } = await import("./lib/run-context.mjs");
  const context = runContext(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!context) return;
  const devcycleDir = dirname(context.stateFile);
  const { stopPaths } = await import("../scripts/stop-files.mjs");
  if (!action.launch && !existsSync(stopPaths(devcycleDir).processes)) return;
  if (!sessionJoined(context, input.session_id)) return;
  const [{ hashSession }, { now }, registry] = await Promise.all([
    import("../scripts/run-record.mjs"), import("../scripts/stamp.mjs"), import("../scripts/process-registry.mjs"),
  ]);
  const session = hashSession(input.session_id);
  if (action.launch) registry.recordProcess(devcycleDir, { ...action.launch, session, run: context.run, stage: context.stage, startedAt: now() });
  else if (action.retire) registry.retireProcess(devcycleDir, action.retire, { endedAt: now(), endedBy: action.endedBy });
  else registry.reconcileSnapshot(devcycleDir, { session, run: context.run, tasks: action.reconcile, now: nowMs });
}

try { await main(); } catch { /* observe-only: any failure is a silent no-op */ }
process.exit(0);
