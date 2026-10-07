#!/usr/bin/env node
// One plan gate: seven legs over one plan file, fail-closed on a missing Dispatch Map, one compact
// line on success. Each leg lives in (and is exported by) the script that still serves it standalone.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { parseDispatchMap } from "./task-files.mjs";
import { codeBlocksLeg } from "./lint-plan-code-blocks.mjs";
import { briefCompletenessLeg } from "./brief-completeness-check.mjs";
import { blastRadiusLeg } from "./blast-radius-check.mjs";
import { contentCouplingLeg } from "./content-coupling-check.mjs";
import { budgetFixturesLeg } from "./budget-fixture-check.mjs";
import { waveDisjointnessLeg } from "./wave-disjointness-check.mjs";
import { authoredClaimsLeg } from "./authored-claims-check.mjs";

const RUN_RECORD = fileURLToPath(new URL("./run-record.mjs", import.meta.url));
const STAGES = new Set(["scoping", "audit", "diagnosis", "brainstorm", "planning", "execution",
  "branch-review", "on-device", "fast-path", "sweep", "finish", "maintain"]);

export const LEGS = {
  codeBlocks: codeBlocksLeg,
  // budgetFixtures is its own leg below; the standalone brief-completeness CLI keeps its join.
  briefCompleteness: (text, ctx) => briefCompletenessLeg(text, ctx, { includeBudgetFixtures: false }),
  blastRadius: blastRadiusLeg,
  contentCoupling: contentCouplingLeg,
  budgetFixtures: budgetFixturesLeg,
  waveDisjointness: waveDisjointnessLeg,
  authoredClaims: authoredClaimsLeg,
};

export function planCheck(planText, { planPath, repoRoot, only }) {
  if (parseDispatchMap(planText) === null)
    return { findings: [{ leg: "dispatchMap", text: 'missing "## Dispatch Map" section — every leg needs it' }], notes: [], legs: [] };
  const legs = only ? [only] : Object.keys(LEGS);
  const findings = [];
  const notes = [];
  for (const leg of legs) {
    const r = LEGS[leg](planText, { planPath, repoRoot });
    for (const text of r.notes ?? []) notes.push({ leg, text });
    for (const text of r.findings) findings.push({ leg, text });
  }
  return { findings, notes, legs };
}

function recordGateRan(repoRoot, failed) {
  const stateFile = join(repoRoot, ".devcycle", "state.md");
  if (!existsSync(stateFile)) return;
  const state = readFileSync(stateFile, "utf8");
  const run = field(state, "run");
  const stage = field(state, "stage");
  if (!/^[0-9a-f]{16}$/.test(run ?? "") || !STAGES.has(stage)) return;
  spawnSync(process.execPath, [RUN_RECORD, "append", "--run", run, "--kind", "event",
    "--event", "gate-ran", "--stage", stage, "--result", failed ? "fail" : "pass"], { cwd: repoRoot, encoding: "utf8" });
}

function die(msg) {
  console.error(`plan-check: ${msg}`);
  process.exit(1);
}

const USAGE = "usage: plan-check.mjs <plan-path> [repo-root] [--only <leg>] [--verbose]";

// A passing run stays compact: each leg's notes collapse to one count line unless --verbose asks
// for them. A failing run always lists them, since a note can explain the finding beside it.
function printNotes(notes, { listAll }) {
  if (listAll) {
    for (const n of notes) console.error(`plan-check: ${n.leg}: ${n.text}`);
    return;
  }
  const counts = new Map();
  for (const n of notes) counts.set(n.leg, (counts.get(n.leg) ?? 0) + 1);
  for (const [leg, n] of counts) console.error(`plan-check: ${leg}: ${n} note(s) — rerun with --verbose to list them`);
}

function main(argv) {
  const positionals = [];
  let only;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--only") only = argv[++i] ?? die("--only needs a leg name");
    else if (argv[i] === "--verbose") verbose = true;
    else if (argv[i].startsWith("--")) die(`unknown flag "${argv[i]}" — ${USAGE}`);
    else positionals.push(argv[i]);
  }
  const [planPath, repoRoot = process.cwd()] = positionals;
  if (!planPath) die(USAGE);
  if (only && !(only in LEGS)) die(`unknown leg "${only}" — one of ${Object.keys(LEGS).join(", ")}`);
  if (!existsSync(planPath) || !statSync(planPath).isFile()) die(`plan not found: ${planPath}`);
  const { findings, notes, legs } = planCheck(readFileSync(planPath, "utf8"), { planPath, repoRoot, only });
  printNotes(notes, { listAll: verbose || findings.length > 0 });
  for (const f of findings) console.error(`plan-check: ${f.leg}: ${f.text}`);
  try { recordGateRan(repoRoot, findings.length > 0); } catch { /* recording is best-effort */ }
  if (findings.length) process.exit(1);
  console.log(`plan-check: ok — ${legs.length} leg(s): ${legs.join(", ")}`);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
