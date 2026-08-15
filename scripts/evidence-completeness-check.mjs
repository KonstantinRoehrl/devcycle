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
const EVIDENCE_LINE_RE = /^-\s*Evidence:.*\|\s*cmd:\s*(.*)$/m;
const match = text.match(EVIDENCE_LINE_RE);
if (!match) {
  console.error(`evidence-completeness-check: no evidence line found in ${reportPath}`);
  process.exit(1);
}

const cmd = match[1].trim();
if (cmd === "") {
  console.error(`evidence-completeness-check: cmd is empty in ${reportPath}`);
  process.exit(1);
}

// A whitespace-delimited token naming a single test file — e.g. `tests/unit/foo.test.mjs` —
// selects one file's tests, not the gate's whole suite. A glob token such as
// `tests/unit/*.test.mjs` still ends in one of these suffixes but selects every file the
// glob matches, so tokens carrying a glob character are exempt.
const TEST_FILE_SUFFIXES = [".test.mjs", ".test.js", ".test.ts", "_test.py"];
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

console.log(`evidence-completeness-check: ok — cmd: ${cmd}`);
