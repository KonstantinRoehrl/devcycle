// One owner for "what tokens a task's file list contains" — shared by the wave-disjointness
// check (a **Files:** block) and dream.mjs --match (a --files "a,b" CSV) so both agree.
const LABELS = new Set(["Create", "Modify", "Test"]);

export function normalizeFileToken(raw) {
  let tok = String(raw).replace(/^[`(),]+/, "").replace(/[`(),]+$/, "");
  tok = tok.replace(/:\d+-\d+$/, "").replace(/:$/, "");
  if (!tok || LABELS.has(tok) || tok === "-") return null;
  if (!/\//.test(tok) && !/\.[A-Za-z0-9]+$/.test(tok)) return null;
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
    const tok = normalizeFileToken(raw.trim());
    if (tok) out.push(tok);
  }
  return out;
}
