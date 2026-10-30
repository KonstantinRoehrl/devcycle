#!/usr/bin/env node
// Flags an evidence report's `cmd:` value when it looks like a narrow subset of the whole
// verification gate rather than the gate itself — see references/evidence.md, "capturing
// fewer commands than the gate runs in either file is a declared deviation".
//
// Scope limit, stated rather than implied: this script does not know any repo's "whole
// gate" command — no such registry exists yet — so it cannot catch every partial-gate case.
// It only catches the narrow-selector pattern named below: a `cmd:` that names a single test
// file by path, or that carries a test-runner flag which filters down to named tests. A
// human still has to judge cases this can't see, such as the concurrent-wave
// whole-tree-capture case (a scoped diff standing in for a full run across a shared
// checkout).
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { proseLines } from "./authored-claims-check.mjs";
import { VALID_EVIDENCE_CLASSES, REQUIRED_CHECKS_PATH, readRequiredChecks, missingRequiredChecks } from "./brief-completeness-check.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { TEST_FILE_SUFFIXES } from "./task-files.mjs";
import { taskGate, workTreeRoot } from "./task-ledger.mjs";

// The evidence contract's version (references/evidence.md's `<!-- evidence-contract-version: N -->`
// marker is the doc-side twin of this constant).
export const CONTRACT_VERSION = 2;
// The version that introduced the `# devcycle-cmd:` capture header: a capture without one predates
// that version, so the header-missing error names it rather than the current one.
const HEADER_SINCE_VERSION = 1;

const USAGE =
  "usage: node scripts/evidence-completeness-check.mjs <report-file> [--task <id>] [--ledger <path>] [--required-checks <path>]";
let flags, positionals;
try {
  ({ flags, positionals } = parseFlags(
    process.argv.slice(2),
    { "--task": "value", "--ledger": "value", "--required-checks": "value" },
    { allowPositionals: true },
  ));
} catch (err) {
  console.error(`evidence-completeness-check: ${err.message} — ${USAGE}`);
  process.exit(1);
}
const [reportPath] = positionals;
const { "--required-checks": requiredChecksArg, "--task": taskArg, "--ledger": ledgerArg } = flags;

if (!reportPath) {
  console.error(`evidence-completeness-check: ${USAGE}`);
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(`evidence-completeness-check: ${reportPath}: no such file`);
  process.exit(1);
}

const text = readFileSync(reportPath, "utf8");

// A report authored in markdown often wraps the class and cmd tokens in backticks for
// styling; that's cosmetic, not a different command, so every extracted token strips it
// before comparison or file resolution.
const stripBackticks = (s) => s.replace(/^`+/, "").replace(/`+$/, "").trim();

// The report shape references/evidence.md pins: "- Evidence: <class> | cmd: <exact command>".
const EVIDENCE_LINE_RE = /^-\s*Evidence:\s*(.*?)\s*\|\s*cmd:\s*(.*)$/m;
// A `- Evidence:` line without the `| cmd:` suffix is a distinct defect from no line at
// all — distinguishing them tells the author whether to add a line or add the suffix.
const EVIDENCE_PRESENT_RE = /^-\s*Evidence:/m;
const match = text.match(EVIDENCE_LINE_RE);
if (!match) {
  if (EVIDENCE_PRESENT_RE.test(text)) {
    console.error(
      `evidence-completeness-check: \`- Evidence:\` line present but missing the \`| cmd:\` suffix in ${reportPath}`
    );
  } else {
    console.error(`evidence-completeness-check: no \`- Evidence:\` line found in ${reportPath}`);
  }
  process.exit(1);
}

const classPhrase = stripBackticks(match[1]);
const cmd = stripBackticks(match[2]);
if (cmd === "") {
  console.error(`evidence-completeness-check: cmd is empty in ${reportPath}`);
  process.exit(1);
}
// An unknown class would skip every class-gated check below, so the capture helper's `<class>`
// placeholder copied verbatim must not pass as a class of its own.
if (!VALID_EVIDENCE_CLASSES.includes(classPhrase.split(/[\s(]/)[0])) {
  console.error(
    `evidence-completeness-check: - Evidence: names no evidence class (${VALID_EVIDENCE_CLASSES.join(" | ")}), got "${classPhrase}" — ` +
      "write the task's class from its plan (references/evidence.md § The three evidence classes)",
  );
  process.exit(1);
}

// #282/#337: the task's gate, read through the one resolver the capture helper uses. The ledger sits
// at the work-tree root, wherever in the checkout the check runs; outside a git checkout the cwd stands
// in. A run with no --task, or a cycle planned without a gate, has no gate to compare against.
function defaultLedgerPath() {
  try {
    return join(workTreeRoot(), ".devcycle/ledger.md");
  } catch {
    return resolve(".devcycle/ledger.md");
  }
}
const gate = taskArg ? taskGate(ledgerArg ? resolve(ledgerArg) : defaultLedgerPath(), taskArg) : null;
if (taskArg && !gate)
  console.log(
    `evidence-completeness-check: notice — no gate command resolves for task ${taskArg} (no plan in the ledger, or no gate for this task in it); the gate comparison is skipped`,
  );
// A convention task's report may declare the plan's whole Verification gate instead of its own
// parenthetical (references/evidence.md § The three evidence classes).
const cmdIsGate = Boolean(gate) && [gate.cmd, gate.planGate].includes(cmd);

// The narrow-selector heuristic is invocation-aware (references/evidence.md §File-backed
// evidence): the cmd is split on the shell operators that separate sub-commands, the
// test-runner invocation(s) are identified, and the heuristic is applied ONLY to those.
// A non-test sub-command (rg, grep, rm, cd, echo…) contributes no test tokens or selector
// flags, so its flags (e.g. ripgrep's `-t`) and paths (e.g. `rm -rf tests/tmp`) never read
// as test selectors.
function splitSubcommands(cmdStr) {
  return cmdStr
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A sub-command is a test-runner invocation when it runs Node's test runner (`--test`) or
// its binary is a known test runner. Node without `--test` (e.g. `node scripts/validate.mjs`)
// is a plain script, not a test runner.
const TEST_RUNNER_BINS = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "ava", "tap"]);

// A runner is often invoked behind a launcher or wrapper prefix — `python -m pytest`,
// `poetry run pytest`, `npx vitest`, `time pytest`, `FOO=1 pytest`. Strip that prefix from
// the front so the command token underneath (whose basename decides) is identified. A prefix
// that leaves a non-runner token with no `--test` is still not a test-runner invocation, so
// `rg -t md …` (ripgrep) is never turned into one.
const ENV_ASSIGN_RE = /^[A-Za-z_]\w*=/;
const PKG_RUNNERS = new Set(["yarn", "pnpm", "bun"]);
const PKG_RUN_SUBCMDS = new Set(["exec", "dlx", "run"]);
const PY_RUN_MANAGERS = new Set(["poetry", "pdm", "pipenv", "rye"]);
function stripLauncherPrefix(toks) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (ENV_ASSIGN_RE.test(t)) { i++; continue; } // leading VAR=val assignments (repeatable)
    if (t === "env") {
      i++; // env + any following VAR=val assignments or `-u VAR`
      while (i < toks.length) {
        if (ENV_ASSIGN_RE.test(toks[i])) { i++; continue; }
        if (toks[i] === "-u" && i + 1 < toks.length) { i += 2; continue; }
        break;
      }
      continue;
    }
    if (t === "time") { i++; continue; }
    if (t === "npx" || t === "bunx") {
      i++; // skip the launcher and its own leading flags (e.g. `-y`)
      while (i < toks.length && toks[i].startsWith("-")) i++;
      continue;
    }
    if (PKG_RUNNERS.has(t)) {
      i++;
      if (i < toks.length && PKG_RUN_SUBCMDS.has(toks[i])) i++;
      continue;
    }
    if (PY_RUN_MANAGERS.has(t)) {
      if (i + 1 < toks.length && toks[i + 1] === "run") { i += 2; continue; }
      break;
    }
    if (t === "python" || t === "python3") {
      // `python -m pytest` — the module after `-m` is the command token.
      if (i + 1 < toks.length && toks[i + 1] === "-m") i += 2;
      break;
    }
    break;
  }
  return toks.slice(i);
}
function isTestRunnerInvocation(sub) {
  const toks = sub.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  if (toks.includes("--test")) return true;
  const stripped = stripLauncherPrefix(toks);
  if (stripped.length === 0) return false;
  const bin = stripped[0].split("/").pop();
  return TEST_RUNNER_BINS.has(bin);
}

// A test-runner flag that filters down to named tests, and (below) the flags that consume
// their following token as a value — so a `--flag value` value is never read as a positional
// test path. `--test` is deliberately NOT a value flag: it is a boolean whose following
// token is the positional test path/glob/dir.
const SELECTOR_FLAGS = new Set(["-t", "--grep", "-g", "--filter", "-k", "--test-name-pattern"]);
const VALUE_FLAGS = new Set([
  ...SELECTOR_FLAGS,
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
  "--reporter",
  "--test-reporter",
  "--test-reporter-destination",
]);

// The positional (non-flag, non-flag-value) tokens of a single sub-command.
function positionalTokens(sub) {
  const toks = sub.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (VALUE_FLAGS.has(t)) {
      i++; // skip the flag's value token
      continue;
    }
    if (t.startsWith("-")) continue; // other flags (booleans) are not positionals
    out.push(t);
  }
  return out;
}

// A whitespace-delimited positional naming a single test file — e.g. `tests/unit/foo.test.mjs` —
// selects one file's tests, not the gate's whole suite. A glob token such as
// `tests/unit/*.test.mjs` still ends in one of these suffixes but selects every file the
// glob matches, so tokens carrying a glob character are exempt.
const GLOB_CHARS = /[*?[\]]/;
function narrowTestFileToken(sub) {
  return positionalTokens(sub).find(
    (tok) => !GLOB_CHARS.test(tok) && TEST_FILE_SUFFIXES.some((suf) => tok.endsWith(suf))
  );
}

// A name-filter selector flag on a test-runner invocation makes it narrow regardless of a
// glob — a `--grep`/`-t` etc. filters to name-matched tests, so it is a partial-gate capture.
// A selector is recognized in every surface form: space-separated (`-k foo`), equals-form
// (`--grep=foo`), and the attached short form (`-kfoo`). Every token is examined — a bare
// selector flag as the final token, its value elided, is still a selector signal.
const SHORT_SELECTOR_FLAGS = new Set(["-t", "-g", "-k"]);
function narrowSelectorFlag(sub) {
  const tokens = sub.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (SELECTOR_FLAGS.has(tok)) return tok; // space-separated or bare trailing form
    const eq = tok.indexOf("=");
    if (eq > 0 && SELECTOR_FLAGS.has(tok.slice(0, eq))) return tok.slice(0, eq); // equals-form
    if (tok.length > 2 && SHORT_SELECTOR_FLAGS.has(tok.slice(0, 2))) return tok.slice(0, 2); // attached short form
  }
  return undefined;
}

// A test-runner invocation that runs the whole suite — a glob-bearing test token or a bare
// test directory positional — is a broad run. A single-file token is narrow only when NO
// broad run exists across the test-runner invocation(s).
const TEST_DIR_RE = /(^|\/)tests?(\/[\w./-]*)?\/?$/;
// TEST_DIR_RE alone also matches a single test FILE under a tests/ path (its character
// class permits the dots and the file's own suffix) — that's a narrow selector, not a
// broad run, and is already the narrowTestFileToken/glob case's job to classify. A token
// is only "a bare test directory" for this guard's purpose when it doesn't itself end in
// one of the suffixes that mark a single test file.
const isTestDirToken = (t) => TEST_DIR_RE.test(t) && !TEST_FILE_SUFFIXES.some((s) => t.endsWith(s));
function hasBroadTestRun(sub) {
  return positionalTokens(sub).some(
    (t) =>
      (GLOB_CHARS.test(t) &&
        TEST_FILE_SUFFIXES.some(
          (s) => t.replace(GLOB_CHARS, "").endsWith(s) || t.endsWith(s.replace(/\*/g, ""))
        )) ||
      isTestDirToken(t)
  );
}

// Evaluate the narrow-selector heuristic against the test-runner invocation(s) only.
// A selector flag on any test-runner invocation is narrow (even alongside a glob); a lone
// single-file token is narrow only when no invocation runs the whole suite.
function narrowSelectorHit(cmdStr) {
  const invocations = splitSubcommands(cmdStr).filter(isTestRunnerInvocation);
  for (const inv of invocations) {
    const flag = narrowSelectorFlag(inv);
    if (flag) return { flag };
  }
  if (invocations.some(hasBroadTestRun)) return undefined;
  for (const inv of invocations) {
    const file = narrowTestFileToken(inv);
    if (file) return { file };
  }
  return undefined;
}

// A declared narrowing escape hatch (Global Constraints: "a `- Narrowing:` declaration
// with no `— <reason>` is a hard error, matching the existing blast-radius-override
// grammar") — a concurrent-wave whole-suite red belongs to a sibling, not this task, so
// the report may declare the narrower scope it actually ran instead of being blind-rejected.
const NARROWING_START = /^\s*-\s*Narrowing:/m;
const NARROWING_RE = /^\s*-\s*Narrowing:\s*(\S.*?)\s*—\s*(.*\S)\s*$/m;
function narrowingDeclaration(reportText) {
  if (!NARROWING_START.test(reportText)) return undefined;
  const m = reportText.match(NARROWING_RE);
  if (!m) {
    console.error(
      'evidence-completeness-check: malformed narrowing declaration (needs "<selector/scope> — <reason>")'
    );
    process.exit(1);
  }
  return { scope: m[1], reason: m[2] };
}

// The task's own gate is the whole gate by definition, even when it names a single test file.
const narrowHit = cmdIsGate ? undefined : narrowSelectorHit(cmd);
if (narrowHit) {
  const decl = narrowingDeclaration(text);
  if (decl) {
    console.log(`evidence-completeness-check: narrowing declared — ${decl.reason}`);
  } else if (narrowHit.file) {
    console.error(
      `evidence-completeness-check: cmd looks like a narrow selector — it names a single test file (${narrowHit.file}) instead of the whole gate`
    );
    process.exit(1);
  } else {
    console.error(
      `evidence-completeness-check: cmd looks like a narrow selector — it carries a test-name filter flag (${narrowHit.flag}) instead of running the whole gate`
    );
    process.exit(1);
  }
}

const isTestClass = /^(red-green|green-green)\b/.test(classPhrase);
const isConvention = classPhrase.startsWith("convention");

// --- #61: additive completeness checks on the report's captured evidence ---

// node --test / TAP counters, `<n> passed|failed`, `Tests: … passed`, and dotnet vstest's
// `Passed!  - Failed: 0, Passed: 98, …`; dotnet MTP's `total: 98` / `failed: 0` block already matches
// `<n> failed` across its line break.
const RUNNER_SUMMARY_RE =
  /(?:^|[#ℹ\s])(?:pass|fail)\s+\d+|\d+\s+(?:passed|failed)|tests?:.*\b(?:passed|failed)\b|\b(?:Passed|Failed)!\s+-\s+Failed:\s+\d+,\s+Passed:\s+\d+/im;
// Karma prints SUCCESS / FAILED rather than pass/fail counts, wrapped in colour and cursor escapes
// even when piped to a file, so the summary test reads an escape-stripped copy of the capture.
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -\/]*[@-~]/g;
const KARMA_TOTAL_RE = /^\s*TOTAL:\s+\d+\s+(?:SUCCESS|FAILED)\b/m;
const KARMA_EXECUTED_RE = /Executed (\d+) of (\d+)(?: \(skipped (\d+)\))?([^\n]*)/g;

// A Karma run's summary: its TOTAL line, or — the dots reporter prints none — its last Executed line
// when that line reports FAILED wherever the run stopped, or reads SUCCESS once complete. Karma prints
// `Executed 0 of <m>` before any test runs and one line per spec after it, so an earlier line, or a
// last one still short of <m> without a FAILED, is none.
function hasKarmaSummary(plain) {
  if (KARMA_TOTAL_RE.test(plain)) return true;
  const last = [...plain.matchAll(KARMA_EXECUTED_RE)].at(-1);
  if (!last) return false;
  const [, ran, total, skipped = "0", rest] = last;
  return /\bFAILED\b/.test(rest) || (Number(ran) + Number(skipped) === Number(total) && /\bSUCCESS\b/.test(rest));
}

function hasRunnerSummary(capture) {
  const plain = capture.replace(ANSI_ESCAPE_RE, "");
  return RUNNER_SUMMARY_RE.test(plain) || hasKarmaSummary(plain);
}

const BEFORE_LINE_RE = /^-\s*Before:\s*(.*)$/gm;
const AFTER_LINE_RE = /^-\s*After:\s*(.*)$/gm;

// (b) EVERY present Before/After line must carry an (exit <n>) status, not just the first.
for (const [label, re] of [["Before", BEFORE_LINE_RE], ["After", AFTER_LINE_RE]]) {
  for (const m of text.matchAll(re)) {
    if (!/\(exit\s+-?\d+\b[^)]*\)/.test(m[1])) {
      console.error(`evidence-completeness-check: ${label} line is missing an (exit <n>) status`);
      process.exit(1);
    }
  }
}

// The capture's first line is "# devcycle-cmd: <cmd>" (references/evidence.md §File-backed
// evidence). These helpers read and verify that header. #150: a convention capture gets the
// same header checks a test-class capture does, so a truncated capture cannot hide behind a
// full declared cmd:.
const readCmdHeader = (filePath) => {
  const first = readFileSync(filePath, "utf8").split("\n", 1)[0] ?? "";
  const m = first.match(/^#\s*devcycle-cmd:\s*(.+?)\s*$/);
  return m ? m[1] : null;
};
// A Before/After line's value is "<path> (exit <n>)"; its first token is the capture's path.
const evidencePath = (lineMatch) => stripBackticks(lineMatch[1].trim().split(/\s+/)[0]);
function captureHeaderOrExit(lineMatch, label) {
  const p = evidencePath(lineMatch);
  const resolved = resolveEvidence(p, reportPath);
  if (!existsSync(resolved)) {
    console.error(`evidence-completeness-check: ${label}-evidence file not found: ${p}`);
    process.exit(1);
  }
  return { path: p, resolved, header: readCmdHeader(resolved) };
}
// #382/#391: a pair whose headers differ passes only as a declared narrowing — the before is the
// task's gate, the after carries the scope the `- Narrowing:` line declares (references/evidence.md
// § File-backed evidence); requireHeaderMatchesCmd then holds the after to cmd:. Returns the halves
// of that relation the pair fails, none when it holds.
function narrowedPairFailures(beforeHeader, afterHeader) {
  const decl = narrowingDeclaration(text);
  return [
    ...(decl ? [] : ["no - Narrowing: line declared"]),
    ...(gate ? [] : ["no gate resolves for the task (run with --task <id>)"]),
    ...(gate && ![gate.cmd, gate.planGate].includes(beforeHeader) ? ["before is not the task's gate"] : []),
    ...(decl && !afterHeader.includes(decl.scope) ? ["after does not carry the declared scope"] : []),
  ];
}
function refuseUnequalHeaders(before, after, narrowable) {
  if (before.header === after.header) return;
  const failures = narrowable ? narrowedPairFailures(before.header, after.header) : ["a convention capture's before and after must be identical"];
  if (!failures.length) return;
  console.error(
    `evidence-completeness-check: before/after captured with non-identical commands — ` +
      `before: ${before.header} | after: ${after.header} — ${failures.join("; ")}`,
  );
  process.exit(1);
}
// #75: the before and after headers are identical, or form the declared narrowed pair (test classes
// only). Returns the after header, the one held to cmd:, plus the resolved after path for the
// runner-summary check.
function verifyCaptureHeaders(beforeM, afterM, { narrowable = false } = {}) {
  const before = captureHeaderOrExit(beforeM, "before");
  const after = captureHeaderOrExit(afterM, "after");
  if (before.header === null || after.header === null) {
    console.error(
      "evidence-completeness-check: evidence file missing '# devcycle-cmd: <cmd>' header line " +
        "(contract version " + HEADER_SINCE_VERSION + "; a capture authored against an older cached plugin " +
        "predates this requirement — reinstall the plugin or add the header per references/evidence.md §File-backed evidence)",
    );
    process.exit(1);
  }
  refuseUnequalHeaders(before, after, narrowable);
  return { header: after.header, afterPath: after.path, afterResolved: after.resolved };
}
// #75 (cont.): agreeing with each other is not enough — a header narrower than the report's
// declared cmd: is a partial-gate capture. references/evidence.md pins the capture's first
// line as "the exact command", the whole gate the report declares, so the header must equal cmd:.
function requireHeaderMatchesCmd(header) {
  if (header !== cmd) {
    console.error(
      `evidence-completeness-check: capture command differs from the declared cmd: — ` +
        `cmd: ${cmd} | captured: ${header}`,
    );
    process.exit(1);
  }
}

// --- required-checks manifest: a convention-class gate must run every host-required check,
// per the manifest's purpose — a narrow convention command masquerading as "the gate" is the
// same partial-gate defect the narrow-selector guard above catches for test commands.
// Absent manifest is a no-op (Global Constraints: "stays repo-agnostic"); plan-check holds the plan's
// pinned gates to the same manifest, through the same reader.
function enforceRequiredChecks(commandStr) {
  let required;
  try {
    required = readRequiredChecks(resolve(process.cwd(), requiredChecksArg ?? REQUIRED_CHECKS_PATH));
  } catch (e) {
    console.error(`evidence-completeness-check: ${e.message}`);
    process.exit(1);
  }
  const [missing] = missingRequiredChecks(commandStr, required ?? []);
  if (missing) {
    console.error(
      `evidence-completeness-check: cmd omits required gate check "${missing}" — the whole gate must run it (${REQUIRED_CHECKS_PATH})`
    );
    process.exit(1);
  }
}

// The gate-equality and failure-attribution checks print every finding they collect and exit once at
// the end, so one intake bounce names all of them; the checks below keep their first-failure exits.
let collected = 0;
const collect = (msg) => {
  collected++;
  console.error(`evidence-completeness-check: ${msg}`);
};
const firstBeforeLine = text.matchAll(BEFORE_LINE_RE).next().value;

// #282/#337: the declared cmd: is the task's resolved gate (resolved above).
function checkGateEquality() {
  if (!gate || cmdIsGate || narrowingDeclaration(text)) return;
  const beforePath = firstBeforeLine ? resolveEvidence(evidencePath(firstBeforeLine), reportPath) : null;
  const header = beforePath && existsSync(beforePath) ? readCmdHeader(beforePath) : null;
  const gates = gate.planGate ? `${gate.cmd} or the plan's Verification gate ${gate.planGate}` : gate.cmd;
  collect(
    `cmd: is not the task's gate command — gate: ${gates} | cmd: ${cmd} | capture header: ${header ?? "none"} — ` +
      "capture through capture-evidence.mjs and copy the cmd: it prints, or declare a - Narrowing: line (references/evidence.md § File-backed evidence)",
  );
}

// #333: a red explained away needs its reproduction artifact (references/evidence.md § Reviewer
// verdicts). Report-only: in a spec or a plan "pre-existing" is ordinary vocabulary. A sibling-caused
// red is the Narrowing line's, which foreign-change-check.mjs judges, so that line is skipped.
// Deliberately conservative: a failure word and an attribution word on one prose line, or a flake
// word alone, is an explained-away red unless the attribution word is negated by a negator directly
// before it ("no pre-existing failures", "nothing flaky") or by a colon-form "none" that ends the
// line after it ("flakes: none", "flaky: none observed"). Every cleverer exemption let a failure
// through, so a line that only mentions a failure beside an attribution word bounces too and its
// writer rephrases.
const bounded = (alternatives) => `(?<![\\w-])(?:${alternatives})(?![\\w-])`;
const FAILURE_RE = new RegExp(bounded("fail\\w*|errors?|erroring|crash\\w*|broken|red"), "i");
const ATTRIBUTION_RE = new RegExp(bounded("pre-?existing|flak\\w*|unrelated|environmental"), "gi");
const FLAKE_RE = /^flak/i;
const NEGATOR_BEFORE_RE = /(?<![\w-])(?:no|zero|nothing|none|not|without|never)\s+$/i;
const NONE_AFTER_RE = /^(?:\s+[\w-]+)?\s*:\s*none(?:\s+\w+)?[.;,)]*\s*$/i;
function attributesFailure(prose) {
  const hasFailure = FAILURE_RE.test(prose);
  return [...prose.matchAll(ATTRIBUTION_RE)].some(
    (m) =>
      (hasFailure || FLAKE_RE.test(m[0])) &&
      !NEGATOR_BEFORE_RE.test(prose.slice(0, m.index)) &&
      !NONE_AFTER_RE.test(prose.slice(m.index + m[0].length)),
  );
}
const FLAKY_CITATION_RE = /\.devcycle\/evidence\/[\w.-]+-flaky\.txt/g;
function checkFailureAttribution() {
  const taskId = taskArg ?? (firstBeforeLine && basename(evidencePath(firstBeforeLine)).match(/^(.+)-before\.txt$/)?.[1]);
  const artifact = `.devcycle/evidence/${taskId ?? "<task-id>"}-flaky.txt`;
  const citationOn = (line) => [...(line ?? "").matchAll(FLAKY_CITATION_RE)].map((m) => m[0]).find((c) => !taskId || c === artifact);
  const raw = text.split("\n");
  proseLines(text).forEach((prose, i) => {
    if (prose === null || NARROWING_START.test(raw[i])) return;
    if (!attributesFailure(prose)) return;
    // Inline code is blanked in prose, so the citation is searched on the raw lines.
    const cited = [i - 1, i, i + 1].map((j) => citationOn(raw[j])).find(Boolean);
    const where = `line ${i + 1}: "${raw[i].trim()}"`;
    if (!cited) {
      collect(
        `a failure is attributed as pre-existing, flaky, unrelated or environmental with no reproduction artifact — ${where} — ` +
          `cite ${artifact} on that line or an adjacent line, holding the failing run on clean HEAD and on the change at the same iteration count ` +
          "(references/evidence.md § Reviewer verdicts)",
      );
      return;
    }
    const path = resolveEvidence(cited, reportPath);
    if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") collect(`${where} cites ${cited}, which is missing or empty`);
  });
}

checkGateEquality();
checkFailureAttribution();

// Convention reports: when before/after captures are present, verify them against their
// `# devcycle-cmd:` header exactly as test-class captures are — header identity, the
// required-checks manifest against the ACTUAL capture command (#150), then header-vs-cmd:
// equality. A convention report with no captures is not forced to invent them; the manifest
// then falls back to the declared cmd:.
if (isConvention) {
  const beforeM = text.matchAll(BEFORE_LINE_RE).next().value;
  const afterM = text.matchAll(AFTER_LINE_RE).next().value;
  const haveCaptures = Boolean(beforeM && afterM);
  let header;
  if (haveCaptures) ({ header } = verifyCaptureHeaders(beforeM, afterM));
  enforceRequiredChecks(haveCaptures ? header : cmd);
  if (haveCaptures) requireHeaderMatchesCmd(header);
}

// (a) test-class reports need a Before and an After line, the captures must share an
//     identical header, or form the declared narrowed pair, with the after header equal to cmd:,
//     and the After file must carry a test-runner summary.
if (isTestClass) {
  const beforeM = text.matchAll(BEFORE_LINE_RE).next().value;
  const afterM = text.matchAll(AFTER_LINE_RE).next().value;
  if (!beforeM) {
    console.error(`evidence-completeness-check: ${classPhrase} report has no "- Before:" evidence line`);
    process.exit(1);
  }
  if (!afterM) {
    console.error(`evidence-completeness-check: ${classPhrase} report has no "- After:" evidence line`);
    process.exit(1);
  }
  const { header, afterPath, afterResolved } = verifyCaptureHeaders(beforeM, afterM, { narrowable: true });
  requireHeaderMatchesCmd(header);
  if (!hasRunnerSummary(readFileSync(afterResolved, "utf8"))) {
    console.error(`evidence-completeness-check: after-evidence file ${afterPath} has no test-runner summary line`);
    process.exit(1);
  }
}

if (collected) process.exit(1);
console.log(`evidence-completeness-check: ok — cmd: ${cmd}`);

function resolveEvidence(p, reportFile) {
  if (isAbsolute(p) && existsSync(p)) return p;
  const relCwd = resolve(process.cwd(), p);
  if (existsSync(relCwd)) return relCwd;
  const relReport = resolve(dirname(reportFile), p);
  if (existsSync(relReport)) return relReport;
  return relCwd; // report the cwd-relative form in the not-found error
}
