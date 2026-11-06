#!/usr/bin/env node
// Pre-flight check for a devcycle plan: every "### Task N" block must carry the required
// dispatch fields, the Evidence value must name a valid class, a red-green task that creates a
// non-test source file must carry a stub step, "## Dispatch Map" must list every task, every
// pinned gate command must run the repo's required checks, and a Files block that edits a budgeted file must list the size baselines that edit trips and the decisions log
// that holds them, and a git command a step prescribes that the dispatch guard denies an
// implementer is reported as a note, never a failure. Modeled on wave-disjointness-check.mjs; a
// brief missing a field makes the implementer guess. See references/evidence.md and playbooks/planning-waves.md.
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  taskBlocks, parseDispatchMap, filesFieldValue, fieldValue, verificationGate, verificationGateField, conventionCommand,
  createdFiles, isTestPath, lineFences,
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

// #276: a brief that prescribes a git command the dispatch guard denies costs the implementer a
// round of rewrites. The guard itself is the classifier, resolved beside this script so the
// installed plugin's own hook answers, never a second allowlist that drifts from it. The guarded
// origins share one allowlist, so the implementer's verdict covers them all. Report-only:
// most hits on real plans quote a denied spelling rather than prescribe it (docs/decisions/README.md).
const GUARD_HOOK = fileURLToPath(new URL("../hooks/block-destructive-git.mjs", import.meta.url));
const GUARDED_ORIGIN = "devcycle:implementer";
const SHELL_FENCE_INFO = new Set(["bash", "sh", "zsh", "shell", "console"]);
const CODE_SPAN_RE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const GIT_WORD_RE = /\bgit\b/;
const EVIDENCE_LINE_RE = /^\*\*Evidence:\*\*/;

// Every inline code span, and every line of a shell fence, that names git. Other fences hold test
// code whose git runs through execFileSync, which a Bash hook never sees. The task's convention
// command is skipped on its **Evidence:** line only, where the capture helper runs it as its own
// child process; a step that has the implementer type it is still scanned.
function prescribedGitCommands(block) {
  const convention = conventionCommand(fieldValue(block, "Evidence") ?? "");
  const found = [];
  const fences = lineFences(block);
  for (const [i, line] of block.split("\n").entries()) {
    const fence = fences[i];
    if (fence) {
      if (i !== fence.open && i !== fence.close && SHELL_FENCE_INFO.has(fence.info)) {
        const command = line.trim().replace(/^\$\s+/, "");
        if (command && !command.startsWith("#")) found.push(command);
      }
      continue;
    }
    const runByCapture = EVIDENCE_LINE_RE.test(line) ? convention : null;
    for (const span of line.matchAll(CODE_SPAN_RE)) {
      const command = span[2].trim();
      if (command !== runByCapture) found.push(command);
    }
  }
  return [...new Set(found)].filter((command) => GIT_WORD_RE.test(command));
}

function guardDenial(command, { repoRoot, hookPath = GUARD_HOOK }) {
  const input = JSON.stringify({ agent_type: GUARDED_ORIGIN, cwd: repoRoot, tool_input: { command } });
  const r = spawnSync(process.execPath, [hookPath], { input, encoding: "utf8", cwd: repoRoot, timeout: 10_000 });
  if (r.error) return { denied: false, error: r.error.message };
  if (r.status !== 0) return { denied: false, error: `exit ${r.status}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n")[0]}` : ""}` };
  const out = r.stdout.trim();
  if (!out) return { denied: false };
  let decision;
  try {
    decision = JSON.parse(out)?.hookSpecificOutput;
  } catch {
    return { denied: false, error: `unparsable hook output: ${out.slice(0, 80)}` };
  }
  if (decision?.permissionDecision !== "deny") return { denied: false };
  // The hook echoes the command after its reason; the note already names it.
  return { denied: true, reason: String(decision.permissionDecisionReason ?? "").replace(/ command: [\s\S]*$/, "") };
}

export function guardDenialNotes(blocks, { repoRoot, hookPath = GUARD_HOOK }) {
  const verdicts = new Map();
  const notes = [];
  for (const { num, text } of blocks) {
    for (const command of prescribedGitCommands(text)) {
      if (!verdicts.has(command)) verdicts.set(command, guardDenial(command, { repoRoot, hookPath }));
      const verdict = verdicts.get(command);
      if (verdict.error) {
        notes.push(`Task ${num}: the guard leg could not classify \`${command}\` (${verdict.error}) — check it against hooks/block-destructive-git.mjs by hand`);
      } else if (verdict.denied) {
        notes.push(
          `Task ${num}: prescribes \`${command}\`, which the dispatch guard denies an implementer — ${verdict.reason} ` +
            "Rewrite it as a command a guarded dispatch may run (playbooks/executing-waves.md step 2)",
        );
      }
    }
  }
  return notes;
}

// #321: a red-green task that creates its module under test needs a stub step, or its red is a
// missing-module error that passes vacuously once the file exists (references/evidence.md § The
// three evidence classes). Code extensions only: a created doc, fixture or config never runs, and a
// `.d.ts` declaration file has no runtime to stub.
const SOURCE_EXTENSIONS = new Set([".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py",
  ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".sh"]);
const DECLARATION_FILE_RE = /\.d\.[mc]?ts$/i;
const STUB_RE = /\bstub/i;

function stubErrors(num, block) {
  if ((fieldValue(block, "Evidence") ?? "").split(/\s+/)[0] !== "red-green") return [];
  const files = filesFieldValue(block);
  if (!files) return [];
  const created = [...createdFiles(files)].filter((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) && !DECLARATION_FILE_RE.test(path) && !isTestPath(path));
  if (created.length === 0 || STUB_RE.test(block.replace(files, ""))) return [];
  return [
    `Task ${num}: **Evidence:** red-green creates ${created[0]} but no step writes a stub for it — add a step before the ` +
      "failing test that writes a minimal stub, so the red is an assertion failure rather than a missing module " +
      "(references/evidence.md § The three evidence classes)",
  ];
}

// repoRoot is the work tree whose required-checks manifest applies; plan-check passes its own.
export function briefCompletenessLeg(planText, { planPath, repoRoot = process.cwd() }, { includeBudgetFixtures = true } = {}) {
  const errors = [];
  const blocks = taskBlocks(planText);
  if (blocks.length === 0) {
    return { findings: [`no "### Task N" blocks found in ${planPath}`], ok: "", notes: [] };
  }
  errors.push(...gateLineErrors(planText), ...requiredCheckErrors(planText, blocks, repoRoot));

  // The stub and guard legs read only a task's own brief; the other legs keep the whole-block read.
  const ownBriefs = taskBlocks(planText, { stopAtPlanSection: true });
  for (const [index, { num, text: block }] of blocks.entries()) {
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
    errors.push(...stubErrors(num, ownBriefs[index].text));
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
    notes: guardDenialNotes(ownBriefs, { repoRoot }),
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

  const { findings, ok, notes } = briefCompletenessLeg(readFileSync(planPath, "utf8"), { planPath });
  for (const n of notes) console.error(`brief-completeness-check: note: ${n}`);
  if (findings.length > 0) {
    for (const f of findings) console.error(`brief-completeness-check: ${f}`);
    process.exit(1);
  }
  console.log(`brief-completeness-check: ${ok}`);
  process.exit(0);
}

if (isMain(import.meta.url, process.argv[1])) main();
