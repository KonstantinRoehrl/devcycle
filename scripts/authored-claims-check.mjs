#!/usr/bin/env node
// Blocking lint: flags two high-confidence unverified-claim patterns in a pipeline artifact —
// a `path.ext:line` reference and a bare count claim ("38 sessions") — cleared by a
// `(verified: <cmd>)` or `(assumption)` marker on the same line or an immediately adjacent one.
// Conservative by design: fenced code, inline code, and URLs are blanked before matching so a
// guarded span can never trigger a false positive. See references/evidence.md § Authored claims.
import { readFileSync } from "node:fs";

const [, , filePath] = process.argv;
if (!filePath) {
  console.error("usage: node scripts/authored-claims-check.mjs <file>");
  process.exit(1);
}

// A path with a file extension, then `:line` (optionally `-line` for a range). The trailing
// `(?![\d.])` lookahead rejects a `:8080`-then-more port and a semver-ish tail; ISO dates and
// `HH:MM` timestamps carry no file-extension token before the colon so they never match at all.
const LINE_REF_RE = /(?<![\w./-])([\w./-]+\.[a-z0-9]{1,6}):(\d+)(?:-\d+)?(?![\d.])/g;
const COUNT_RE = /\b(\d+)\s+(files?|occurrences?|tests?|sessions?|lines?|callers?|places?|instances?|references?|tasks?|waves?)\b/gi;
const MARKER_RE = /\((?:verified:[^)]*|assumption)\)/i;
const FENCE_RE = /^\s*```/;
const INLINE_CODE_RE = /`[^`]*`/g;
const URL_RE = /https?:\/\/\S+/g;

const rawLines = readFileSync(filePath, "utf8").split("\n");

// Blanks a matched span to same-length spaces so a guarded span cannot match while line/column
// positions of everything else stay meaningful.
const blank = (line, re) => line.replace(re, (m) => " ".repeat(m.length));

let inFence = false;
const guardedLines = rawLines.map((line) => {
  if (FENCE_RE.test(line)) {
    inFence = !inFence;
    return null; // the fence delimiter line itself carries no claims
  }
  if (inFence) return null;
  return blank(blank(line, INLINE_CODE_RE), URL_RE);
});

function markerClears(lineIdx) {
  return [lineIdx - 1, lineIdx, lineIdx + 1].some(
    (i) => rawLines[i] !== undefined && MARKER_RE.test(rawLines[i])
  );
}

const violations = [];
guardedLines.forEach((guarded, idx) => {
  if (guarded === null) return;
  if (markerClears(idx)) return;
  for (const m of guarded.matchAll(LINE_REF_RE)) {
    violations.push({ line: idx + 1, kind: "line-reference", text: m[0] });
  }
  for (const m of guarded.matchAll(COUNT_RE)) {
    violations.push({ line: idx + 1, kind: "count", text: m[0] });
  }
});

if (violations.length > 0) {
  for (const v of violations) {
    console.error(
      `authored-claims-check: ${filePath}:${v.line}: unverified ${v.kind} claim "${v.text}" — add a (verified: <cmd>) or (assumption) marker`
    );
  }
  process.exit(1);
}
console.log(`authored-claims-check: ok — ${filePath}`);
process.exit(0);
