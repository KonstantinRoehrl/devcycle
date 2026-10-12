#!/usr/bin/env node
// Pre-flight check for a devcycle plan: every "### Task N" block must carry the required
// dispatch fields, the Evidence value must name a valid class, "## Dispatch Map" must list
// every task, every pinned gate command must run the repo's required checks, and a Files block
// that edits a budgeted file must list the size baselines that edit trips and the decisions log
// that holds them. Modeled on wave-disjointness-check.mjs; a brief missing a field makes the
// implementer guess. See references/evidence.md and playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  taskBlocks, parseDispatchMap, filesFieldValue, fieldValue, verificationGate, verificationGateField, conventionCommand,
} from "./task-files.mjs";
import { budgetFixtureGaps, gapRemedy } from "./budget-fixture-check.mjs";
import { isMain } from "./is-main.mjs";

const REQUIRED_FIELDS = ["Files", "Interfaces", "Dependencies", "Evidence", "Quality constraints"];
// The evidence classes references/evidence.md defines; evidence-completeness-check.mjs reads them here too.
export const VALID_EVIDENCE_CLASSES = ["red-green", "green-green", "convention"];

// The required-checks manifest (references/evidence.md § File-backed evidence): substrings every
// whole-gate command must contain. One reader for both holders — this plan-time check and
// evidence-completeness-check.mjs's capture-time one — so the two never disagree on the list.
// Returns null when the manifest is absent, the documented no-op.
export const REQUIRED_CHECKS_PATH = "tests/fixtures/required-gate-checks.json";
export function readRequiredChecks(path) {
  if (!existsSync(path)) return null;
  let checks;
  try {
    checks = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: invalid JSON (${e.message})`);
  }
  if (!Array.isArray(checks) || !checks.every((c) => typeof c === "string"))
    throw new Error(`${path}: must be a JSON array of command substrings`);
  return checks;
}
export const missingRequiredChecks = (command, checks) => checks.filter((c) => !command.includes(c));

// #322: a gate pinned narrower than the manifest is caught here, where it is first written, rather
// than after the implementer has captured it. The header gate covers every test-class task; a
// convention task pins its own command.
function requiredCheckErrors(planText, blocks, repoRoot) {
  let checks;
  try {
    checks = readRequiredChecks(join(repoRoot, REQUIRED_CHECKS_PATH));
  } catch (e) {
    return [e.message];
  }
  if (!checks) return [];
  const pinned = [["the **Verification gate:**", verificationGate(planText)]];
  for (const { num, text } of blocks)
    pinned.push([`Task ${num}: convention command`, conventionCommand(fieldValue(text, "Evidence") ?? "")]);
  return pinned
    .filter(([, cmd]) => cmd)
    .flatMap(([who, cmd]) =>
      missingRequiredChecks(cmd, checks).map(
        (check) =>
          `${who} \`${cmd}\` omits required gate check "${check}" (${REQUIRED_CHECKS_PATH}) — pin the whole gate, ` +
          "which runs every check the manifest lists (references/evidence.md § File-backed evidence)",
      ),
    );
}

// **Files:** is read by task-files.mjs, which owns that grammar for every plan gate. Deciding it
// here too is how this gate came to accept declarations wave-disjointness then called missing.
function readField(block, field) {
  return field === "Files" ? filesFieldValue(block) : fieldValue(block, field);
}

// The header's whole-gate line (playbooks/planning-waves.md § plan header): gateCommand resolves
// every test-class task's gate from it, so a plan without it leaves the capture helper, the evidence
// check and the green gate no command to agree on.
function gateLineErrors(planText) {
  const raw = verificationGateField(planText);
  if (raw === null)
    return ["missing **Verification gate:** line in the plan header — add the repo's whole verification gate as one backtick-quoted command before the first task"];
  if (verificationGate(planText) === null)
    return [`**Verification gate:** must be exactly one backtick-quoted command, got: ${raw || "(empty)"}`];
  return [];
}

// repoRoot is the work tree whose required-checks manifest applies; plan-check passes its own.
export function briefCompletenessLeg(planText, { planPath, repoRoot = process.cwd() }, { includeBudgetFixtures = true } = {}) {
  const errors = [];
  const blocks = taskBlocks(planText);
  if (blocks.length === 0) {
    return { findings: [`no "### Task N" blocks found in ${planPath}`], ok: "", notes: [] };
  }
  errors.push(...gateLineErrors(planText), ...requiredCheckErrors(planText, blocks, repoRoot));

  for (const { num, text: block } of blocks) {
    for (const field of REQUIRED_FIELDS) {
      const val = readField(block, field);
      if (val === null) errors.push(`Task ${num}: missing **${field}:** field`);
      else if (val === "") errors.push(`Task ${num}: **${field}:** field is empty`);
    }
    const evidence = fieldValue(block, "Evidence");
    if (evidence) {
      const evidenceClass = evidence.split(/\s+/)[0];
      if (!VALID_EVIDENCE_CLASSES.includes(evidenceClass)) {
        errors.push(`Task ${num}: **Evidence:** does not name a valid class (${VALID_EVIDENCE_CLASSES.join(" | ")})`);
      } else if (evidenceClass === "convention" && conventionCommand(evidence) === null) {
        errors.push(
          `Task ${num}: **Evidence:** convention must carry its gate command as exactly one code span, ` +
            `convention (\`<cmd>\`), not prose, a procedure or a capture redirect; got: ${evidence.split("\n")[0]} ` +
            "(references/evidence.md § The three evidence classes)",
        );
      }
    }
  }

  // An incomplete Files block is not only a missing field: a brief that mandates doc growth but
  // never lists the baseline fixture that growth trips hands the implementer a validate.mjs
  // failure the brief itself caused. budget-fixture-check.mjs owns which baselines a path sits
  // under -- deciding it here too is the drift duplication-check.mjs exists to stop.
  if (includeBudgetFixtures) {
    try {
      for (const { task, file, fixture } of budgetFixtureGaps(planText)) {
        errors.push(`Task ${task}: **Files:** edits ${file} but omits ${fixture} — ${gapRemedy(fixture)}`);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  const waves = parseDispatchMap(planText);
  if (waves === null) {
    errors.push('missing "## Dispatch Map" section');
  } else {
    const mapped = new Set([...waves.values()].flat());
    for (const { num } of blocks) {
      if (!mapped.has(num)) errors.push(`Task ${num}: not listed in the ## Dispatch Map`);
    }
  }

  return {
    findings: errors,
    ok: `ok -- ${blocks.length} task(s), all required fields present`,
    notes: [],
  };
}

function main() {
  const planPath = process.argv[2];
  if (!planPath) {
    console.error("usage: node scripts/brief-completeness-check.mjs <plan-file>");
    process.exit(1);
  }
  if (!existsSync(planPath)) {
    console.error(`brief-completeness-check: plan file not found: ${planPath}`);
    process.exit(1);
  }

  const { findings, ok } = briefCompletenessLeg(readFileSync(planPath, "utf8"), { planPath });
  if (findings.length > 0) {
    for (const f of findings) console.error(`brief-completeness-check: ${f}`);
    process.exit(1);
  }
  console.log(`brief-completeness-check: ${ok}`);
  process.exit(0);
}

if (isMain(import.meta.url, process.argv[1])) main();
