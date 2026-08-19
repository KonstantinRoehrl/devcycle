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

const [, , reportPath] = process.argv;

if (!reportPath) {
  console.error("evidence-completeness-check: usage: node scripts/evidence-completeness-check.mjs <report-file>");
  process.exit(1);
}

if (!existsSync(reportPath)) {
  console.error(`evidence-completeness-check: ${reportPath}: no such file`);
  process.exit(1);
}

const text = readFileSync(reportPath, "utf8");

// The report shape references/evidence.md pins: "- Evidence: <class> | cmd: <exact command>".
const EVIDENCE_LINE_RE = /^-\s*Evidence:\s*(.*?)\s*\|\s*cmd:\s*(.*)$/m;
const match = text.match(EVIDENCE_LINE_RE);
if (!match) {
  console.error(`evidence-completeness-check: no evidence line found in ${reportPath}`);
  process.exit(1);
}

const cmd = match[2].trim();
if (cmd === "") {
  console.error(`evidence-completeness-check: cmd is empty in ${reportPath}`);
  process.exit(1);
}

// A whitespace-delimited token naming a single test file — e.g. `tests/unit/foo.test.mjs` —
// selects one file's tests, not the gate's whole suite. A glob token such as
// `tests/unit/*.test.mjs` still ends in one of these suffixes but selects every file the
// glob matches, so tokens carrying a glob character are exempt.
const GLOB_CHARS = /[*?[\]]/;
function narrowTestFileToken(cmdStr) {
  return cmdStr
    .split(/\s+/)
    .find((tok) => !GLOB_CHARS.test(tok) && TEST_FILE_SUFFIXES.some((suf) => tok.endsWith(suf)));
}

// A test-runner flag that filters down to named tests, followed by its value token.
const SELECTOR_FLAGS = new Set(["-t", "--grep", "-g", "--filter", "-k", "--test-name-pattern"]);
function narrowSelectorFlag(cmdStr) {
  const tokens = cmdStr.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (SELECTOR_FLAGS.has(tokens[i])) return tokens[i];
  }
  return undefined;
}

const fileHit = narrowTestFileToken(cmd);
if (fileHit) {
  console.error(
    `evidence-completeness-check: cmd looks like a narrow selector — it names a single test file (${fileHit}) instead of the whole gate`
  );
  process.exit(1);
}

const flagHit = narrowSelectorFlag(cmd);
if (flagHit) {
  console.error(
    `evidence-completeness-check: cmd looks like a narrow selector — it carries a test-name filter flag (${flagHit}) instead of running the whole gate`
  );
  process.exit(1);
}

// --- #61: additive completeness checks on the report's captured evidence ---

const RUNNER_SUMMARY_RE =
  /(?:^|[#ℹ\s])(?:pass|fail)\s+\d+|\d+\s+(?:passed|failed)|tests?:.*\b(?:passed|failed)\b/im;
const BEFORE_LINE_RE = /^-\s*Before:\s*(.*)$/gm;
const AFTER_LINE_RE = /^-\s*After:\s*(.*)$/gm;

const classPhrase = match[1].trim();
const isTestClass = /^(red-green|green-green)\b/.test(classPhrase);

// (b) EVERY present Before/After line must carry an (exit <n>) status, not just the first.
for (const [label, re] of [["Before", BEFORE_LINE_RE], ["After", AFTER_LINE_RE]]) {
  for (const m of text.matchAll(re)) {
    if (!/\(exit\s+-?\d+\)/.test(m[1])) {
      console.error(`evidence-completeness-check: ${label} line is missing an (exit <n>) status`);
      process.exit(1);
    }
  }
}

// (a) test-class reports need a Before and an After line, and the After file must carry a
//     test-runner summary. Convention reports (prose gates) are exempt from the summary check.
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
  const afterPath = afterM[1].trim().split(/\s+/)[0];
  const resolved = resolveEvidence(afterPath, reportPath);
  if (!existsSync(resolved)) {
    console.error(`evidence-completeness-check: after-evidence file not found: ${afterPath}`);
    process.exit(1);
  }
  if (!RUNNER_SUMMARY_RE.test(readFileSync(resolved, "utf8"))) {
    console.error(`evidence-completeness-check: after-evidence file ${afterPath} has no test-runner summary line`);
    process.exit(1);
  }

  // #75: the before-capture and after-capture must be the identical command string.
  // The capture writes it as the first line "# devcycle-cmd: <cmd>" (references/evidence.md §File-backed evidence).
  const beforePath = beforeM[1].trim().split(/\s+/)[0];
  const resolvedBeforePath = resolveEvidence(beforePath, reportPath);
  if (!existsSync(resolvedBeforePath)) {
    console.error(`evidence-completeness-check: before-evidence file not found: ${beforePath}`);
    process.exit(1);
  }
  const cmdHeader = (filePath) => {
    const first = readFileSync(filePath, "utf8").split("\n", 1)[0] ?? "";
    const m = first.match(/^#\s*devcycle-cmd:\s*(.+?)\s*$/);
    return m ? m[1] : null;
  };
  const beforeCmd = cmdHeader(resolvedBeforePath);
  const afterCmd = cmdHeader(resolved);
  if (beforeCmd === null || afterCmd === null) {
    console.error(
      "evidence-completeness-check: evidence file missing '# devcycle-cmd: <cmd>' header line " +
        "(add it as the first line of each -before/-after capture per references/evidence.md §File-backed evidence)",
    );
    process.exit(1);
  }
  if (beforeCmd !== afterCmd) {
    console.error(
      `evidence-completeness-check: before/after captured with non-identical commands — ` +
        `before: ${beforeCmd} | after: ${afterCmd}`,
    );
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
