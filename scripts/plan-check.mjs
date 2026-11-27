#!/usr/bin/env node
// One plan gate: ten legs over one plan file, fail-closed on a missing Dispatch Map, one compact
// line on success. `--draft` gates one drafted task file with the per-task legs instead. Each leg lives in (and is exported by) the script that still serves it standalone.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { field } from "./md-field.mjs";
import { parseDispatchMap } from "./task-files.mjs";
import { codeBlocksLeg } from "./lint-plan-code-blocks.mjs";
import { briefCompletenessLeg } from "./brief-completeness-check.mjs";
import { blastRadiusLeg } from "./blast-radius-check.mjs";
import { contentCouplingLeg } from "./content-coupling-check.mjs";
import { gateRulesLeg } from "./gate-rules-check.mjs";
import { waveDisjointnessLeg } from "./wave-disjointness-check.mjs";
import { authoredClaimsLeg } from "./authored-claims-check.mjs";
import { briefFactsLeg } from "./brief-facts-check.mjs";
import { proportionLeg } from "./proportion-check.mjs";
import { crossTaskLeg } from "./cross-task-check.mjs";

const RUN_RECORD = fileURLToPath(new URL("./run-record.mjs", import.meta.url));
const STAGES = new Set(["scoping", "audit", "diagnosis", "brainstorm", "planning", "execution",
  "branch-review", "on-device", "fast-path", "sweep", "finish", "maintain"]);

export const LEGS = {
  codeBlocks: codeBlocksLeg,
  // gateRules is its own leg below; the standalone brief-completeness CLI keeps its join.
  briefCompleteness: (text, ctx) => briefCompletenessLeg(text, ctx, { includeGateRules: false }),
  blastRadius: blastRadiusLeg,
  contentCoupling: contentCouplingLeg,
  gateRules: gateRulesLeg,
  waveDisjointness: waveDisjointnessLeg,
  authoredClaims: authoredClaimsLeg,
  briefFacts: briefFactsLeg,
  proportion: proportionLeg,
  crossTask: crossTaskLeg,
};

// The legs that read one task's own brief, the ones `--draft` runs on a task file before the plan exists.
export const DRAFT_LEGS = Object.freeze(["codeBlocks", "briefCompleteness", "gateRules", "authoredClaims", "briefFacts"]);

// What each leg checks, in LEGS order: `plan-check --help` prints it, so the playbook need only say
// "run it; fix or override".
export const LEG_HELP = Object.freeze({
  codeBlocks: "pasted JS/mjs code blocks parse.",
  briefCompleteness: "every task carries Files / Interfaces / Dependencies / a valid Evidence class / Quality constraints, a `red-green` task pins its failing test code in a fenced block and mentions a stub when it creates a non-test source file, and a `**Detail:**` line reads `code-pinned — <reason>` (or the older `interface-pinned — <reason>`, `red-green` only); outside `--draft`, the header carries one `**Verification gate:**` code span, pinned gates run every required-checks manifest entry, and the Dispatch Map lists every task. It also notes, never failing, each prescribed git command the dispatch guard denies.",
  blastRadius: "every JS/TS/Python file naming a changed file's basename (a non-code file's `<parent>/<basename>`), test or not, sits in some Files block, each finding opening with the task that declares the changed file; an extensionless import of a changed code file, and a test named after a referencer an override cleared, are notes, never findings.",
  contentCoupling: "no same-wave task's brief names a file another same-wave task edits.",
  gateRules: "each task's Files meet the repo's own `tests/fixtures/gate-rules.json`: every file a `require` rule names is listed, a `requireOneOf` rule finds another listed file matching one of its globs, and a required file that matches a rule pulls that rule in too. With no rules file it passes with a note; a malformed one is a finding.",
  waveDisjointness: "no two same-wave tasks list the same file.",
  authoredClaims: "every load-bearing plan-authored claim (a file or section target, a count, \"X already does Y\") carries `(verified: <cmd>)` or `(assumption)`.",
  briefFacts: "every path a brief cites resolves and every cited line is within its file; under `--draft`, a path a sibling task file creates or the draft's own Consumes (Task N) line names counts as created. It also notes, never failing, a call-shaped span nothing defines.",
  proportion: "plan bytes stay within 5× the spec's and non-test code fences within 20% of the plan (a note above either; a red-green task's failing-test fences are exempt), and above 8× or 30% it fails unless a `- Proportion override: <reason>` line says why. With no spec (`--spec`, else the state file's `spec:`) it is not measured.",
  crossTask: "every code span a `- Consumes (Task N):` line pins appears in a Produces line of Task N; no task brief carries a placeholder or a \"similar to Task N\" back-reference outside a code span; a definition two tasks pin with differing text is a note.",
});

const OVERRIDE_FORMS = [
  "- Blast-radius override: <changed-file> [→ <referencer>[, <referencer>…]] — <reason>",
  "- Content-coupling override: Task B → <file> (Task A) — <reason>",
  "- Gate-rule override: <trigger-file | required-file | rule-id> — <reason>",
  "- Citation override: <path> — <reason>",
  "- Proportion override: <reason>",
];

export function helpText() {
  return [
    USAGE,
    "",
    ...Object.keys(LEGS).map((leg) => `${leg}: ${LEG_HELP[leg]}`),
    `--draft: the path is one drafted task file; runs ${DRAFT_LEGS.join(", ")} and records nothing.`,
    "",
    "Overrides (each needs a reason):",
    ...OVERRIDE_FORMS,
  ].join("\n");
}

export function planCheck(planText, { planPath, repoRoot, only, specText, draft = false }) {
  if (!draft && parseDispatchMap(planText) === null)
    return { findings: [{ leg: "dispatchMap", text: 'missing "## Dispatch Map" section — every leg needs it' }], notes: [], legs: [] };
  const legs = only ? [only] : draft ? [...DRAFT_LEGS] : Object.keys(LEGS);
  const findings = [];
  const notes = [];
  for (const leg of legs) {
    // A leg that throws (e.g. a dangling symlink under the repo root) fails as that leg's finding,
    // so the other legs still report and the gate-ran record is still written.
    let r;
    try {
      r = LEGS[leg](planText, { planPath, repoRoot, specText, draft });
    } catch (err) {
      r = { findings: [`crashed — ${err.message}`] };
    }
    for (const text of r.notes ?? []) notes.push({ leg, text });
    for (const text of r.findings) findings.push({ leg, text });
  }
  return { findings, notes, legs };
}

// The first 12 hex of the plan text's sha256: doctor's P9 reads two gate runs on one digest as a re-run.
export const planDigest = (planText) => createHash("sha256").update(planText).digest("hex").slice(0, 12);

// failedLegs is the sorted, unique names of the legs that reported a finding; it is empty on a pass.
function recordGateRan(repoRoot, failedLegs, digest) {
  const stateFile = join(repoRoot, ".devcycle", "state.md");
  if (!existsSync(stateFile)) return;
  const state = readFileSync(stateFile, "utf8");
  const run = field(state, "run");
  const stage = field(state, "stage");
  if (!/^[0-9a-f]{16}$/.test(run ?? "") || !STAGES.has(stage)) return;
  spawnSync(process.execPath, [RUN_RECORD, "append", "--run", run, "--kind", "event",
    "--event", "gate-ran", "--stage", stage, "--result", failedLegs.length ? "fail" : "pass", "--planDigest", digest,
    ...(failedLegs.length ? ["--legs", failedLegs.join(",")] : [])], { cwd: repoRoot, encoding: "utf8" });
}

function die(msg) {
  console.error(`plan-check: ${msg}`);
  process.exit(1);
}

const USAGE = "usage: plan-check.mjs <plan-path> [repo-root] [--draft] [--spec <path>] [--only <leg>] [--verbose] [--help]";

// The spec the proportion leg measures against: the first token of the state file's `spec:` field, when
// it names a file under the repo root.
function stateSpecPath(repoRoot) {
  const stateFile = join(repoRoot, ".devcycle", "state.md");
  if (!existsSync(stateFile)) return null;
  const token = (field(readFileSync(stateFile, "utf8"), "spec") ?? "").split(/\s+/)[0];
  const path = join(repoRoot, token);
  return token && token !== "none" && existsSync(path) && statSync(path).isFile() ? path : null;
}

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
  let parsed;
  try {
    parsed = parseFlags(argv, { "--draft": "none", "--spec": "value", "--only": "value", "--verbose": "none", "--help": "none" },
      { allowPositionals: true, requireValues: "nonEmpty" });
  } catch (e) {
    die(`${e.message} — ${USAGE}`);
  }
  const { flags, positionals } = parsed;
  if (flags["--help"] === true) return void console.log(helpText());
  const only = flags["--only"];
  const draft = flags["--draft"] === true;
  const verbose = flags["--verbose"] === true;
  const [planPath, repoRoot = process.cwd()] = positionals;
  if (!planPath) die(USAGE);
  if (only && !(only in LEGS)) die(`unknown leg "${only}" — one of ${Object.keys(LEGS).join(", ")}`);
  if (draft && only && !DRAFT_LEGS.includes(only)) die(`--draft runs only ${DRAFT_LEGS.join(", ")}`);
  if (!existsSync(planPath) || !statSync(planPath).isFile()) die(`plan not found: ${planPath}`);
  const specFlag = flags["--spec"];
  if (specFlag && (!existsSync(specFlag) || !statSync(specFlag).isFile())) die(`spec not found: ${specFlag}`);
  const specPath = specFlag ?? stateSpecPath(repoRoot);
  const specText = specPath ? readFileSync(specPath, "utf8") : null;
  const planText = readFileSync(planPath, "utf8");
  const { findings, notes, legs } = planCheck(planText, { planPath, repoRoot, only, specText, draft });
  printNotes(notes, { listAll: verbose || findings.length > 0 });
  for (const f of findings) console.error(`plan-check: ${f.leg}: ${f.text}`);
  // A draft is a work file, not the gate of record: only the assembled plan's run is recorded.
  if (!draft) try { recordGateRan(repoRoot, [...new Set(findings.map((f) => f.leg))].sort(), planDigest(planText)); } catch { /* recording is best-effort */ }
  if (findings.length) process.exit(1);
  console.log(`plan-check: ok — ${draft ? "draft, " : ""}${legs.length} leg(s): ${legs.join(", ")}`);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
