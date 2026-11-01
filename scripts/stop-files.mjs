// Where a /devcycle:stop keeps its files, and the rules that read them. Every function takes the
// cycle's `.devcycle` directory, so several cycles in one checkout never share a stop. It imports only
// the filesystem and the field parser, because hooks/stop-guard.mjs loads it on every tool call.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { field } from "./md-field-core.mjs";

// A dead stop command must not wedge the repo: past this age a request binds nobody.
export const STOP_TTL_MS = 600_000;

export const stopPaths = (devcycleDir) => ({
  request: join(devcycleDir, "stop-request"),
  ack: join(devcycleDir, "stop-ack"),
  record: join(devcycleDir, "stop.json"),
  processes: join(devcycleDir, "processes.jsonl"),
  history: join(devcycleDir, "stop-history"),
});

function readObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readStopRequest(devcycleDir) {
  return readObject(stopPaths(devcycleDir).request);
}

export function readStopRecord(devcycleDir) {
  return readObject(stopPaths(devcycleDir).record);
}

export const isLiveRequest = (request, now = Date.now()) => {
  const requestedAt = Date.parse(request?.requestedAt);
  return Number.isFinite(requestedAt) && now - requestedAt < STOP_TTL_MS;
};

export function stopWindowOpen(devcycleDir, stateText, now = Date.now()) {
  return isLiveRequest(readStopRequest(devcycleDir), now) || field(stateText, "stopped") !== null;
}

const SHELL_METACHARACTER = /[;&|$`<>\n\r]/;
const SCRIPT = String.raw`scripts/stop-cycle\.mjs`;
const STOP_CYCLE_CALL = new RegExp(
  String.raw`^(?:rtk\s+)?node\s+(?:"(?:[^"]*/)?${SCRIPT}"|'(?:[^']*/)?${SCRIPT}'|(?:[^\s"']*/)?${SCRIPT})(?:\s|$)`,
);

// The guard's one Bash exemption, so it reads as one plain invocation or not at all: anything that
// could chain a second command behind the script is refused.
export function isStopCycleCommand(command) {
  if (typeof command !== "string" || SHELL_METACHARACTER.test(command)) return false;
  return STOP_CYCLE_CALL.test(command.trim());
}
