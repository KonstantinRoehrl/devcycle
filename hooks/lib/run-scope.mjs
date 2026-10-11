// Which state file names an active devcycle run: a 16-hex `run:` and a stage from the run record's
// stage enum. Node-free, so the hooks module applies the same rule in-process that
// hooks/dispatch-sensor.mjs and hooks/mod-sink.mjs apply on disk.
import { field } from "../../scripts/md-field-core.mjs";

export const STAGES = new Set(["scoping", "audit", "diagnosis", "brainstorm", "planning", "execution",
  "branch-review", "on-device", "fast-path", "sweep", "finish", "maintain"]);
export const RUN_ID = /^[0-9a-f]{16}$/;

export function activeRun(stateText) {
  const run = field(stateText, "run");
  const stage = field(stateText, "stage");
  return RUN_ID.test(run ?? "") && STAGES.has(stage) ? { run, stage } : null;
}
