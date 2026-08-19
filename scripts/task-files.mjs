// One owner for "what tokens a task's file list contains" — shared by the wave-disjointness
// check (a **Files:** block) and dream.mjs --match (a --files "a,b" CSV) so both agree.
const LABELS = new Set(["Create", "Modify", "Test"]);

// Single owner for the base test-file suffixes, consumed by evidence-completeness-check.mjs
// (narrow-selector detection) and blast-radius-check.mjs (which extends it with a few more).
export const TEST_FILE_SUFFIXES = [".test.mjs", ".test.js", ".test.ts", "_test.py"];

// `trusted` skips only the path-shape gate — used by the explicit --files CSV, where the caller
// has already asserted every token is a file, so a top-level extensionless name (Dockerfile,
// Makefile, LICENSE) must survive. The **Files:**-block path leaves it off, keeping the gate that
// rejects surrounding prose. The label and :N-M/`:` stripping are shared by both paths.
export function normalizeFileToken(raw, { trusted = false } = {}) {
  let tok = String(raw).replace(/^[`(),]+/, "").replace(/[`(),]+$/, "");
  tok = tok.replace(/:\d+-\d+$/, "").replace(/:$/, "");
  if (!tok || LABELS.has(tok) || tok === "-") return null;
  if (!trusted && !/\//.test(tok) && !/\.[A-Za-z0-9]+$/.test(tok)) return null;
  return tok;
}

export function extractFiles(block) {
  const files = new Set();
  for (const raw of block.split(/\s+/).filter(Boolean)) {
    const tok = normalizeFileToken(raw);
    if (tok) files.add(tok);
  }
  return files;
}

export function parseFileList(csv) {
  const out = [];
  for (const raw of String(csv).split(",")) {
    const tok = normalizeFileToken(raw.trim(), { trusted: true });
    if (tok) out.push(tok);
  }
  return out;
}
