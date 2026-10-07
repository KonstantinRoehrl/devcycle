// The active run a hook acts for, read from disk: the state file above `start`, the run it names
// (run-scope.mjs owns that rule), the repo root, and whether a session joined the run. Shared by the
// two hook-side run-record writers, hooks/dispatch-sensor.mjs and hooks/mod-sink.mjs, with the
// sanitizer both apply to hook-supplied strings.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { findStateFile } from "./find-state-file.mjs";
import { activeRun } from "./run-scope.mjs";
import { gitToplevel, hashSession, recordPath } from "../../scripts/run-record.mjs";

// The characters outside the run-record schema's patterns for an agent id, an agent type, a model.
export const AGENT_ID_CHARS = /[^0-9a-z]/g;
export const AGENT_TYPE_CHARS = /[^A-Za-z0-9:_.-]/g;
export const MODEL_CHARS = /[^A-Za-z0-9:_.[\]-]/g;

// Hook input is model-adjacent text: drop everything outside the schema's charset (control
// characters included) and cap length. run-record rejects a row that misses its schema pattern,
// so a substitute character the charset lacks would lose the whole row.
export const clean = (s, disallowed, max) => String(s ?? "").replace(disallowed, "").slice(0, max);

export function runContext(start) {
  const stateFile = findStateFile(start);
  if (!stateFile) return null;
  const scope = activeRun(readFileSync(stateFile, "utf8"));
  return scope ? { ...scope, stateFile, repoRoot: dirname(dirname(stateFile)) } : null;
}

// Any of the run's session rows counts, not only the latest: cycle.md and every /devcycle:continue
// append one, and a /clear mints a fresh id, so an earlier id is either gone or still finishing
// this cycle's own agents. A session that never joined matches none of them either way.
export function joinedRun(runFile, sessionId) {
  const hash = hashSession(sessionId);
  return readFileSync(runFile, "utf8").split("\n").some((line) => {
    if (!line.includes(hash)) return false;
    const row = JSON.parse(line);
    return row.kind === "session" && row.sessionHash === hash;
  });
}

export function sessionJoined(context, sessionId) {
  return joinedRun(recordPath(gitToplevel(context.repoRoot), context.run), sessionId);
}
