// One owner for "what tokens a task's file list contains" — shared by the wave-disjointness
// check (a **Files:** block) and dream.mjs --match (a --files "a,b" CSV) so both agree.
const LABELS = new Set(["Create", "Modify", "Test"]);

// Single owner for the base test-file suffixes, consumed by evidence-completeness-check.mjs
// (narrow-selector detection) and blast-radius-check.mjs (which extends it with a few more).
export const TEST_FILE_SUFFIXES = [".test.mjs", ".test.js", ".test.ts", "_test.py"];

// `trusted` skips the path-shape gate and the character denylist — used by the explicit --files CSV,
// where the caller has already asserted every token is a file, so a top-level extensionless name
// (Dockerfile, Makefile, LICENSE) must survive. The **Files:**-block path leaves it off, keeping the
// gate that rejects surrounding prose. The label and line-anchor stripping are shared by both paths.
// The trailing class includes `.` because an inline declaration ends its clause with one
// ("Modify `scripts/a.mjs`. Test: ..."); a token that keeps it is a different string from its
// bare twin, and wave-disjointness — which keys on the exact string — then misses the collision.
// But only for a token that already announced itself as a path, by code-span backticks or a `/`:
// in prose the trailing period belongs to the word, and stripping it off "e.g." or "Node.js."
// leaves something the extension gate below accepts, so surrounding prose became a declared file.
// On the trusted path there is no prose to disambiguate -- the caller asserted every token is a
// file -- so the period always comes off: "CHANGELOG.md." kept it, and matchLessons (exact string
// or glob) then withheld every lesson recorded against CHANGELOG.md.
// `declared` marks a token the author named on purpose, where a `/` alone makes a path
// (`bin/devcycle-root`, `commands/`): extractFiles passes it for a token right after its
// Create/Modify/Test label, and a caller that passes nothing -- blast-radius-check reading an
// override -- is naming a file deliberately too. Anywhere else a `/` is as often prose
// (`step/row`, `Keep/Drop`, `#!/usr/bin/env`), so extractFiles passes `declared: false` and an
// extensionless token counts only as one code span: blast-radius-check greps for every declared
// basename, and `row` matched half the repo.
const CODE_SPAN_RE = /^[(),.;:]*`[^`]+`[(),.;:]*$/;
const LINE_ANCHOR_RE = /:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
const EXTENSION_RE = /\.[A-Za-z0-9]+$/;
// No repo path holds these, while code and template text does: `${CLAUDE_PLUGIN_ROOT}/x.md`, a
// quoted string, a regex. Brackets, `$` and `+` stay allowed for target-repo routes (`app/[slug]/`).
const NON_PATH_CHAR_RE = /["'\\`{}]/;

export function normalizeFileToken(raw, { trusted = false, declared = true } = {}) {
  const text = String(raw);
  const codeSpan = CODE_SPAN_RE.test(text);
  const stripsTrailingPeriod = trusted || text.includes("`") || text.includes("/");
  let tok = text.replace(/^[`(),]+/, "").replace(stripsTrailingPeriod ? /[`(),.;:]+$/ : /[`(),;:]+$/, "");
  tok = tok.replace(LINE_ANCHOR_RE, "");
  if (!tok || LABELS.has(tok) || tok === "-") return null;
  if (trusted) return tok;
  if (NON_PATH_CHAR_RE.test(tok)) return null;
  const hasSlash = tok.includes("/");
  if (declared) return hasSlash || EXTENSION_RE.test(tok) ? tok : null;
  const hasExtension = EXTENSION_RE.test(tok.slice(tok.lastIndexOf("/") + 1));
  return hasExtension || (codeSpan && hasSlash) ? tok : null;
}

// The index of the `}` closing the group that opens at `open`, or -1 when it never closes.
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

// Splits on the commas no brace group encloses. Text whose braces never balance splits on every
// comma, as it did before brace lists existed, rather than becoming one piece.
function splitOutsideBraces(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth = Math.max(0, depth - 1);
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return depth === 0 ? parts : text.split(",");
}

// Brace lists expand the way bash expands them, so `src/lib/{a,b}.ts` declares two files rather
// than one string no path ever equals: task-commit then committed nothing for an accepted task.
// Only a balanced group holding a top-level comma expands; `{a}`, `${VAR}` and `{1..3}` stay
// literal, for the denylist above to reject.
export function expandBraces(text) {
  for (let open = text.indexOf("{"); open !== -1; open = text.indexOf("{", open + 1)) {
    const close = closingBrace(text, open);
    if (close === -1) continue;
    const alternatives = splitOutsideBraces(text.slice(open + 1, close)).map((alt) => alt.trim());
    if (alternatives.length < 2) continue;
    const head = text.slice(0, open);
    const tails = expandBraces(text.slice(close + 1));
    return alternatives.flatMap((alt) => expandBraces(alt).flatMap((mid) => tails.map((tail) => head + mid + tail)));
  }
  return [text];
}

// Whether the text between a group's braces is a list of alternatives inside ONE path token: no
// code, quote or parenthesis (a "(replace `const o = {`)" aside is prose), and no alternative
// holding a space once trimmed, outside the groups nested in it.
function isPathAlternatives(inner) {
  if (/[`()"']/.test(inner)) return false;
  const alternatives = splitOutsideBraces(inner);
  return alternatives.length > 1 && alternatives.every((alt) => {
    const text = alt.trim();
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) return false;
      if (text[i] !== "{") continue;
      const close = closingBrace(text, i);
      if (close === -1) continue;
      const nested = text.slice(i + 1, close);
      if (splitOutsideBraces(nested).length > 1 ? !isPathAlternatives(nested) : /\s/.test(nested)) return false;
      i = close;
    }
    return true;
  });
}

// A group that is an alternatives list is one token even across spaces (`src/{a, b}.ts`):
// splitting on whitespace first left `src/{a,` and `b}.ts` to be rejected one by one, and the
// group's files with them. Any other `{` splits on whitespace as it always did: fused up to a
// later `}`, a stray `{` in prose or a code span dropped every file between the two. A group never
// spans lines, so a stray `{` cannot swallow the block.
function splitTokens(line) {
  const tokens = [];
  let start = -1;
  for (let i = 0; i <= line.length; i++) {
    if (i < line.length && !/\s/.test(line[i])) {
      if (start === -1) start = i;
      if (line[i] === "{") {
        const close = closingBrace(line, i);
        // A code span opened before this token is still open here, so its `{` is code, not a group.
        const insideEarlierSpan = (line.slice(0, start).match(/`/g) ?? []).length % 2 === 1;
        if (close !== -1 && !insideEarlierSpan && isPathAlternatives(line.slice(i + 1, close))) i = close;
      }
    } else if (start !== -1) {
      tokens.push(line.slice(start, i));
      start = -1;
    }
  }
  return tokens;
}

const LABEL_TOKEN_RE = /^\**(?:Create|Modify|Test)\**:?\**$/;
const PARENTHETICAL_COLON_RE = /\)\**:\**$/;
const isConjunction = (token) => token === "and" || token === "+";

// The index of the token closing a `(...)` that opens at `tokens[from]` and is followed by the
// label's colon (`Create (tracked, on disk):`), or -1: a parenthetical elsewhere opens nothing.
function labelParentheticalEnd(tokens, from) {
  if (!tokens[from]?.startsWith("(")) return -1;
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    for (const ch of tokens[i]) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    if (depth <= 0) return PARENTHETICAL_COLON_RE.test(tokens[i]) ? i : -1;
  }
  return -1;
}

// A line the label's list may continue onto: bare paths only, no new bullet, no prose.
function isPathOnlyLine(line, tokens) {
  return tokens.length > 0 && !/^\s*-\s/.test(line) && tokens.every((token) =>
    isConjunction(token) || expandBraces(token).every((piece) => normalizeFileToken(piece, { declared: true })));
}

// A token is in declaration position right after its label's colon (or the bare label word), after a
// comma, and after `and`/`+` following a declared path. A label ending its line with the colon
// extends that over the path-only lines below it. After `and`/`+` a bare slash token (`bin/b`,
// `skills/`) is still prose (`a.py and step/row`) unless the path before it was bare too -- a list
// of one kind -- so only then does a `/` alone make it a path.
export function extractFiles(block) {
  const files = new Set();
  let declared = false;
  let afterDeclaredPath = false;
  let afterConjunction = false;
  let precededByBarePath = false;
  let listOpen = false;
  for (const line of block.split("\n")) {
    const tokens = splitTokens(line);
    if (listOpen) {
      listOpen = isPathOnlyLine(line, tokens);
      declared = declared || listOpen;
    }
    for (let i = 0; i < tokens.length; i++) {
      const raw = tokens[i];
      if (LABEL_TOKEN_RE.test(raw)) {
        declared = true;
        afterDeclaredPath = false;
        afterConjunction = false;
        precededByBarePath = false;
        const parenEnd = raw.includes(":") ? -1 : labelParentheticalEnd(tokens, i + 1);
        if (parenEnd !== -1) i = parenEnd;
        listOpen = (raw.includes(":") || parenEnd !== -1) && i === tokens.length - 1;
        continue;
      }
      if (isConjunction(raw) && (declared || afterDeclaredPath)) {
        declared = true;
        afterDeclaredPath = false;
        afterConjunction = true;
        continue;
      }
      const slashAloneMakesPath = declared && !(afterConjunction && !precededByBarePath);
      let accepted = false;
      let allBare = true;
      for (const piece of expandBraces(raw)) {
        const tok = /\s/.test(piece) ? null : normalizeFileToken(piece, { declared: slashAloneMakesPath });
        if (tok) {
          files.add(tok);
          accepted = true;
          allBare &&= !EXTENSION_RE.test(tok.slice(tok.lastIndexOf("/") + 1));
        }
      }
      afterDeclaredPath = declared && accepted;
      precededByBarePath = afterDeclaredPath && allBare;
      afterConjunction = false;
      declared = declared && raw.endsWith(",");
    }
  }
  return files;
}

export function parseFileList(csv) {
  const out = [];
  for (const raw of splitOutsideBraces(String(csv))) {
    for (const piece of expandBraces(raw.trim())) {
      const tok = normalizeFileToken(piece, { trusted: true });
      if (tok) out.push(tok);
    }
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

// Any other **Field:** of a task block, up to the next **Field:**, the next ### heading, or end of
// input. Returns null when the field is absent.
export function fieldValue(block, field) {
  const re = new RegExp(`\\*\\*${field}:\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n###|$)`);
  const m = block.match(re);
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

// The plan header (playbooks/planning-waves.md § plan header) is everything before the first task.
// Its `**Verification gate:**` line is read line-scoped: fieldValue runs on to the next `**` field,
// so it would swallow the section after the header into the value.
const GATE_LINE_RE = /^\*\*Verification gate:\*\*[ \t]*(.*?)[ \t]*$/m;
const SINGLE_SPAN_RE = /^`([^`]+)`$/;
const planHeader = (planText) => {
  const first = planText.search(/^### Task \d+:/m);
  return first === -1 ? planText : planText.slice(0, first);
};

export function verificationGateField(planText) {
  return planHeader(planText).match(GATE_LINE_RE)?.[1] ?? null;
}

export function verificationGate(planText) {
  return verificationGateField(planText)?.match(SINGLE_SPAN_RE)?.[1].trim() || null;
}

// A convention parenthetical is a command only when it is exactly one code span
// (references/evidence.md § The three evidence classes). Bare text is prose as often as a command
// ("whole-gate green-before/green-after"), and a span writing into .devcycle/evidence/ is a
// hand-written capture recipe from before the capture helper, so running either would capture
// nonsense or overwrite a capture: both resolve to null, as a cycle planned without a gate does.
export function conventionCommand(evidence) {
  const inner = evidence.split("\n")[0].match(/^convention\s*\((.*)\)\s*$/)?.[1].trim() ?? "";
  const cmd = inner.match(SINGLE_SPAN_RE)?.[1].trim();
  return cmd && !cmd.includes(".devcycle/evidence/") ? cmd : null;
}

// The one resolver for a task's gate command — the capture helper, the evidence check, the brief
// writer and wave setup all read it here: a convention task's own command, any other task's header
// gate. It also carries the task's evidence class, and for a convention task the header gate, which
// its report may declare instead of the parenthetical.
export function gateCommand(planText, taskNum) {
  const block = taskBlocks(planText).find((b) => b.num === taskNum);
  if (!block) return null;
  const evidence = fieldValue(block.text, "Evidence") ?? "";
  const planGate = verificationGate(planText);
  if (/^convention\b/.test(evidence)) {
    const cmd = conventionCommand(evidence);
    return cmd ? { cmd, source: "convention", evidenceClass: "convention", planGate } : null;
  }
  return planGate ? { cmd: planGate, source: "plan-gate", evidenceClass: evidence.split(/\s+/)[0] } : null;
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
