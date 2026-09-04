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
import { dirname, resolve, isAbsolute } from "node:path";
import { TEST_FILE_SUFFIXES } from "./task-files.mjs";

// The evidence contract's embedded minimum version, named in the staleness-aware
// header-missing error below (references/evidence.md's `<!-- evidence-contract-version: 1 -->`
// marker is the doc-side twin of this constant).
export const CONTRACT_VERSION = 1;

const argv = process.argv.slice(2);
const reportPath = argv[0];
const rcFlagIdx = argv.indexOf("--required-checks");
const requiredChecksArg = rcFlagIdx !== -1 ? argv[rcFlagIdx + 1] : undefined;

if (!reportPath) {
  console.error("evidence-completeness-check: usage: node scripts/evidence-completeness-check.mjs <report-file>");
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
function isTestRunnerInvocation(sub) {
  const toks = sub.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return false;
  if (toks.includes("--test")) return true;
  const bin = toks[0].split("/").pop();
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
function narrowSelectorFlag(sub) {
  const tokens = sub.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (SELECTOR_FLAGS.has(tokens[i])) return tokens[i];
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

const narrowHit = narrowSelectorHit(cmd);
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

const RUNNER_SUMMARY_RE =
  /(?:^|[#ℹ\s])(?:pass|fail)\s+\d+|\d+\s+(?:passed|failed)|tests?:.*\b(?:passed|failed)\b/im;
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
function captureHeaderOrExit(lineMatch, label) {
  const p = stripBackticks(lineMatch[1].trim().split(/\s+/)[0]);
  const resolved = resolveEvidence(p, reportPath);
  if (!existsSync(resolved)) {
    console.error(`evidence-completeness-check: ${label}-evidence file not found: ${p}`);
    process.exit(1);
  }
  return { path: p, resolved, header: readCmdHeader(resolved) };
}
// #75: the before-capture and after-capture must carry the identical `# devcycle-cmd:` header.
// Returns the shared header plus the resolved after path for the runner-summary check.
function verifyCaptureHeaders(beforeM, afterM) {
  const before = captureHeaderOrExit(beforeM, "before");
  const after = captureHeaderOrExit(afterM, "after");
  if (before.header === null || after.header === null) {
    console.error(
      "evidence-completeness-check: evidence file missing '# devcycle-cmd: <cmd>' header line " +
        "(contract version " + CONTRACT_VERSION + "; a capture authored against an older cached plugin " +
        "predates this requirement — reinstall the plugin or add the header per references/evidence.md §File-backed evidence)",
    );
    process.exit(1);
  }
  if (before.header !== after.header) {
    console.error(
      `evidence-completeness-check: before/after captured with non-identical commands — ` +
        `before: ${before.header} | after: ${after.header}`,
    );
    process.exit(1);
  }
  return { header: before.header, afterPath: after.path, afterResolved: after.resolved };
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
// Absent manifest is a no-op (Global Constraints: "stays repo-agnostic").
const DEFAULT_REQUIRED_CHECKS_PATH = "tests/fixtures/required-gate-checks.json";
function enforceRequiredChecks(commandStr) {
  const requiredChecksPath = resolve(process.cwd(), requiredChecksArg ?? DEFAULT_REQUIRED_CHECKS_PATH);
  if (!existsSync(requiredChecksPath)) return;
  let required;
  try {
    required = JSON.parse(readFileSync(requiredChecksPath, "utf8"));
  } catch (e) {
    console.error(`evidence-completeness-check: ${requiredChecksPath}: invalid JSON (${e.message})`);
    process.exit(1);
  }
  for (const req of required) {
    if (!commandStr.includes(req)) {
      console.error(
        `evidence-completeness-check: cmd omits required gate check "${req}" — the whole gate must run it (tests/fixtures/required-gate-checks.json)`
      );
      process.exit(1);
    }
  }
}

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
//     identical header equal to cmd:, and the After file must carry a test-runner summary.
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
  const { header, afterPath, afterResolved } = verifyCaptureHeaders(beforeM, afterM);
  requireHeaderMatchesCmd(header);
  if (!RUNNER_SUMMARY_RE.test(readFileSync(afterResolved, "utf8"))) {
    console.error(`evidence-completeness-check: after-evidence file ${afterPath} has no test-runner summary line`);
    process.exit(1);
  }
}

console.log(`evidence-completeness-check: ok — cmd: ${cmd}`);

function resolveEvidence(p, reportFile) {
  if (isAbsolute(p) && existsSync(p)) return p;
  const relCwd = resolve(process.cwd(), p);
  if (existsSync(relCwd)) return relCwd;
  const relReport = resolve(dirname(reportFile), p);
  if (existsSync(relReport)) return relReport;
  return relCwd; // report the cwd-relative form in the not-found error
}
