#!/usr/bin/env node
// PreToolUse hook on every tool: while /devcycle:stop is stopping a cycle, a session joined to that
// cycle may call nothing but what the stop itself needs, so a running turn or subagent halts at its
// next tool call. A request binds only the sessions it lists and only until STOP_TTL_MS, so a dead stop
// command or a session started later is never blocked. Once finalize has removed the request, the
// state file's `stopped:` row keeps the listed sessions' subagents halted; the main thread is free, so
// /devcycle:continue works in the same session. Deny shape and fail-open follow
// hooks/block-destructive-git.mjs: malformed input or any error is an allow, because a broken guard
// must never brick a session. run-record.mjs loads only once a request or row is in reach.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { field } from "../scripts/md-field-core.mjs";
import { isLiveRequest, isStopCycleCommand, readStopRecord, readStopRequest, stopPaths } from "../scripts/stop-files.mjs";
import { findStateFile } from "./lib/find-state-file.mjs";

const DURING_STOP = "/devcycle:stop is stopping this cycle. End your turn now and call no further tool: the stop command saves the cycle's position, and /devcycle:continue resumes it.";
const AFTER_STOP = "This cycle was stopped with /devcycle:stop. End now and call no further tool: /devcycle:continue resumes the cycle and dispatches this work again if it is still needed.";

const isExempt = ({ tool_name: tool, tool_input: args }) =>
  tool === "TaskStop"
  || (tool === "ToolSearch" && args?.query === "select:TaskStop")
  || (tool === "Bash" && isStopCycleCommand(args?.command));

const listed = (holder) => (Array.isArray(holder?.sessions) ? holder.sessions : []);

function bindingStop(input, devcycleDir, stateFile) {
  const request = readStopRequest(devcycleDir);
  const live = isLiveRequest(request);
  const afterStop = Boolean(input.agent_id) && field(readFileSync(stateFile, "utf8"), "stopped") !== null;
  return { live, sessions: [...(live ? listed(request) : []), ...(afterStop ? listed(readStopRecord(devcycleDir)) : [])] };
}

// A short O_APPEND write lands whole, and taking the file lock would spawn `ps` on every denial. A
// failed line never turns the denial into an allow.
function acknowledge(devcycleDir, input, session, at) {
  try {
    appendFileSync(stopPaths(devcycleDir).ack, JSON.stringify({ at, session, agent: input.agent_id ?? null, tool: input.tool_name ?? null }) + "\n");
  } catch { /* the denial still stands */ }
}

async function denialReason(input) {
  if (typeof input.session_id !== "string" || !input.session_id || isExempt(input)) return null;
  const stateFile = findStateFile(typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd());
  if (!stateFile) return null;
  const devcycleDir = dirname(stateFile);
  const { live, sessions } = bindingStop(input, devcycleDir, stateFile);
  if (!sessions.length) return null;
  const [{ hashSession }, { now }] = await Promise.all([import("../scripts/run-record.mjs"), import("../scripts/stamp.mjs")]);
  const session = hashSession(input.session_id);
  if (!sessions.includes(session)) return null;
  acknowledge(devcycleDir, input, session, now());
  return live ? DURING_STOP : AFTER_STOP;
}

try {
  const reason = await denialReason(JSON.parse(readFileSync(0, "utf8") || "{}"));
  if (reason)
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }));
} catch { /* fail open: no output is an allow */ }
process.exit(0);
