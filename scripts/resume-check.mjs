#!/usr/bin/env node
// Validates a devcycle state file against on-disk reality before /devcycle:continue trusts it (#79):
// every named artifact path (spec/plan/checklist) exists, and stage: is a real enum value.
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";

const VALID_STAGES = new Set([
  "scoping", "audit", "diagnosis", "brainstorm", "planning", "execution",
  "branch-review", "on-device", "fast-path", "sweep", "finish", "done",
]);
const NONE = new Set(["none", "<tbd>", ""]);

const args = process.argv.slice(2);
const stateFlag = args.indexOf("--state");
const statePath = stateFlag >= 0 ? args[stateFlag + 1] : ".devcycle/state.md";

let text;
try { text = readFileSync(statePath, "utf8"); }
catch { console.error(`resume-check: cannot read state file: ${statePath}`); process.exit(1); }

const field = (name) => {
  const m = text.match(new RegExp(`^- ${name}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1] : null;
};

const errors = [];
const stage = field("stage");
if (!stage || !VALID_STAGES.has(stage)) errors.push(`stage: "${stage}" is not a valid devcycle stage`);

const root = field("root");
const baseForRel = root && !NONE.has(root) ? root : dirname(statePath);
const resolve = (p) => (isAbsolute(p) ? p : join(baseForRel, p));

for (const name of ["spec", "plan", "checklist"]) {
  const raw = field(name);
  if (raw === null) continue;
  // A field may carry a path plus a trailing "— note"; take the first whitespace-delimited token.
  const value = raw.split(/\s+/)[0];
  if (NONE.has(value) || value.startsWith("none")) continue;
  if (!existsSync(resolve(value)))
    errors.push(`${name}: recorded artifact does not exist on disk: ${value}`);
}

if (errors.length) {
  console.error("resume-check: state file is stale — resolve before continuing:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`resume-check: ok — stage ${stage}, all recorded artifacts present`);
