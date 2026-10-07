#!/usr/bin/env node
// Blocking lint: flags two high-confidence unverified-claim patterns in a pipeline artifact —
// a `path.ext:line` reference and a bare count claim ("38 sessions") — cleared by a
// `(verified: <cmd>)` or `(assumption)` marker on the same line or an immediately adjacent one.
// Conservative by design: fenced code, inline code, and URLs are blanked before matching so a
// guarded span can never trigger a false positive. See references/evidence.md § Authored claims.
import { readFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

// A path with a file extension, then `:line` (optionally `-line` for a range). The trailing
// `(?![\d.])` lookahead rejects a `:8080`-then-more port and a semver-ish tail; ISO dates and
// `HH:MM` timestamps carry no file-extension token before the colon so they never match at all.
const LINE_REF_RE = /(?<![\w./-])([\w./-]+\.[a-z0-9]{1,6}):(\d+)(?:-\d+)?(?![\d.])/g;
const COUNT_RE = /\b(\d+)\s+(files?|occurrences?|tests?|sessions?|lines?|callers?|places?|instances?|references?|tasks?|waves?)\b/gi;
const MARKER_RE = /\((?:verified:[^)]*|assumption)\)/i;
const FENCE_RE = /^\s*```/;
const INLINE_CODE_RE = /`[^`]*`/g;
const URL_RE = /https?:\/\/\S+/g;
// The implementer-report template's evidence-tail field header — `- Tail (…, last <N> lines):`
// (references/evidence.md § Implementer report shape). Its <N> is a structural descriptor of the
// report's own tail field, not an authored claim about repo/source state (what this lint polices),
// so it is blanked before matching like a code span. Deliberately narrowed to the field-label
// span itself (up through "last <N> lines") — a bare count in report body prose, or a real
// claim written after the label on the same line, still trips.
const TAIL_FIELD_RE = /^\s*-\s*Tail\b.*?\blast\s+\d+\s+lines\b/i;

// Blanks a matched span to same-length spaces so a guarded span cannot match while line/column
// positions of everything else stay meaningful.
const blank = (line, re) => line.replace(re, (m) => " ".repeat(m.length));

export function authoredClaimsLeg(text, { planPath }) {
  const rawLines = text.split("\n");

  let inFence = false;
  const guardedLines = rawLines.map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return null; // the fence delimiter line itself carries no claims
    }
    if (inFence) return null;
    return blank(blank(blank(line, INLINE_CODE_RE), URL_RE), TAIL_FIELD_RE);
  });

  const markerClears = (lineIdx) =>
    [lineIdx - 1, lineIdx, lineIdx + 1].some(
      (i) => rawLines[i] !== undefined && MARKER_RE.test(rawLines[i])
    );

  const findings = [];
  const flag = (idx, kind, claim) =>
    findings.push(`${planPath}:${idx + 1}: unverified ${kind} claim "${claim}" — add a (verified: <cmd>) or (assumption) marker`);
  guardedLines.forEach((guarded, idx) => {
    if (guarded === null) return;
    if (markerClears(idx)) return;
    for (const m of guarded.matchAll(LINE_REF_RE)) flag(idx, "line-reference", m[0]);
    for (const m of guarded.matchAll(COUNT_RE)) flag(idx, "count", m[0]);
  });

  return { findings, ok: `ok — ${planPath}`, notes: [] };
}

function main() {
  const [, , filePath] = process.argv;
  if (!filePath) {
    console.error("usage: node scripts/authored-claims-check.mjs <file>");
    process.exit(1);
  }

  const { findings, ok } = authoredClaimsLeg(readFileSync(filePath, "utf8"), { planPath: filePath });
  if (findings.length > 0) {
    for (const f of findings) console.error(`authored-claims-check: ${f}`);
    process.exit(1);
  }
  console.log(`authored-claims-check: ${ok}`);
  process.exit(0);
}

if (isMain(import.meta.url, process.argv[1])) main();
