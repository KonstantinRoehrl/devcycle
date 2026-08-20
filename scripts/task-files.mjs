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
// The trailing class includes `.` because an inline declaration ends its clause with one
// ("Modify `scripts/a.mjs`. Test: ..."); a token that keeps it is a different string from its
// bare twin, and wave-disjointness — which keys on the exact string — then misses the collision.
// But only for a token that already announced itself as a path, by code-span backticks or a `/`:
// in prose the trailing period belongs to the word, and stripping it off "e.g." or "Node.js."
// leaves something the extension gate below accepts, so surrounding prose became a declared file.
// On the trusted path there is no prose to disambiguate -- the caller asserted every token is a
// file -- so the period always comes off: "CHANGELOG.md." kept it, and matchLessons (exact string
// or glob) then withheld every lesson recorded against CHANGELOG.md.
export function normalizeFileToken(raw, { trusted = false } = {}) {
  const text = String(raw);
  const stripsTrailingPeriod = trusted || text.includes("`") || text.includes("/");
  let tok = text.replace(/^[`(),]+/, "").replace(stripsTrailingPeriod ? /[`(),.]+$/ : /[`(),]+$/, "");
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

// The plan-file grammar, owned here because three pre-flight gates parsed it separately and a
// change to the heading format silently emptied two of them. Consumers: brief-completeness-check,
// wave-disjointness-check, blast-radius-check.
const TASK_HEADING_RE = /^### Task (\d+):.*$/gm;
// The value may begin on the line after the label or on the label's own line -- plans write both,
// and a grammar that accepted only the first read every inline declaration as no files at all,
// while brief-completeness-check read the same line as a valid field. The terminator is the one
// every other field uses: the next **Field:**, the next ### heading, or end of input.
// The label is anchored to line start: a mid-line mention of the literal **Files:** in a task's
// prose or a fenced example would otherwise be a match candidate, and the non-global .match below
// takes the FIRST one — so the prose parsed instead of the declaration. The anchor is written as
// an alternation rather than the `m` flag, which would also redefine the `$` in the terminator
// lookahead and move where a field ends.
const FILES_FIELD_RE = /(?:^|(?<=\n))\*\*Files:\*\*([\s\S]*?)(?=\n\*\*|\n###|$)/;

// The one reader for a task's **Files:** field. Returns null when the field is absent and "" when
// it is present but carries no value, so a caller can tell those two apart.
export function filesFieldValue(block) {
  const m = block.match(FILES_FIELD_RE);
  return m ? m[1].trim() : null;
}

export function taskBlocks(planText) {
  const headings = [...planText.matchAll(TASK_HEADING_RE)];
  const blocks = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : planText.length;
    blocks.push({ num: Number(headings[i][1]), text: planText.slice(start, end) });
  }
  return blocks;
}

export function taskFileMap(planText) {
  const map = new Map();
  for (const { num, text } of taskBlocks(planText)) {
    const value = filesFieldValue(text);
    if (value !== null) map.set(num, extractFiles(value));
  }
  return map;
}

// Only a task named in a wave's own task list counts as assigned: a mention inside a dependency
// parenthetical, e.g. "- Wave 2: Task 3 (needs Task 1 and Task 2)", is a reference, not an
// assignment. Returns null -- distinct from an empty Map -- when no heading exists at all, which
// wave-disjointness-check reports as "cannot verify" rather than as a violation.
export function parseDispatchMap(planText) {
  const idx = planText.indexOf("## Dispatch Map");
  if (idx === -1) return null;
  const waves = new Map();
  for (const m of planText.slice(idx).matchAll(/^- Wave (\d+):\s*(.+)$/gm)) {
    const rest = m[2];
    const parenIdx = rest.indexOf("(");
    const taskListText = parenIdx === -1 ? rest : rest.slice(0, parenIdx);
    waves.set(Number(m[1]), [...taskListText.matchAll(/Task (\d+)/g)].map((t) => Number(t[1])));
  }
  return waves;
}
