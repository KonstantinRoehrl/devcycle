// The duplication sweep's clone scanners: functions with one normalized body under different
// names, and the per-file function index the semantic-duplicate judgment reads. Both share one
// function extractor. The first returns candidates for verification to judge, never findings.
// Ids, kinds and stacks are `references/hygiene-sweeps.json`'s `scanners`; this file owns only
// the detection rules.
import { createHash } from "node:crypto";
import { extname } from "node:path";

const MIN_BODY_LENGTH = 40;
const MAX_FUNCTIONS_PER_FILE = 200;
const MAX_CHARS_PER_FILE = 65_536;

const wordSet = (words) => new Set(words.split(" "));
const JS_KEYWORDS = wordSet("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while with yield await async static get set from as type interface implements readonly public private protected abstract declare any unknown never string number boolean");
const PY_KEYWORDS = wordSet("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield");
const GO_KEYWORDS = wordSet("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota");

const JS_LANG = { keywords: JS_KEYWORDS, python: false, hashComments: false };
const LANGUAGES = new Map([
  ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].map((ext) => [ext, JS_LANG]),
  [".py", { keywords: PY_KEYWORDS, python: true, hashComments: true }],
  [".go", { keywords: GO_KEYWORDS, python: false, hashComments: false }],
]);

const IDENT_START = /[A-Za-z_$]/;
const WORD_CHAR = /[\w$]/;

// End (exclusive) of the string literal starting at `i`, or `i` when none starts there. A quoted
// string ends at its closing quote or the line's end; a backtick string may span lines.
function skipString(text, i, lang) {
  const quote = text[i];
  if (lang.python && (quote === '"' || quote === "'") && text.startsWith(quote.repeat(3), i)) {
    const close = text.indexOf(quote.repeat(3), i + 3);
    return close < 0 ? text.length : close + 3;
  }
  if (quote !== '"' && quote !== "'" && !(quote === "`" && !lang.python)) return i;
  let j = i + 1;
  while (j < text.length && text[j] !== quote) {
    if (text[j] === "\n" && quote !== "`") return j;
    j += text[j] === "\\" ? 2 : 1;
  }
  return Math.min(j + 1, text.length);
}

const blankKeepingNewlines = (s) => s.replace(/[^\n]/g, " ");

// The text with comments blanked, every offset and newline kept so declaration lines still hold.
function stripComments(text, lang) {
  const out = [];
  let last = 0, i = 0;
  const blank = (end) => { out.push(text.slice(last, i), blankKeepingNewlines(text.slice(i, end))); last = i = end; };
  while (i < text.length) {
    const stringEnd = skipString(text, i, lang);
    if (stringEnd > i) { i = stringEnd; continue; }
    if (lang.hashComments ? text[i] === "#" : text.startsWith("//", i)) {
      const eol = text.indexOf("\n", i);
      blank(eol < 0 ? text.length : eol);
    } else if (!lang.hashComments && text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      blank(close < 0 ? text.length : close + 2);
    } else i += 1;
  }
  out.push(text.slice(last));
  return out.join("");
}

// Index of the bracket closing the one at `open`, skipping strings; -1 when it never closes.
function matching(text, open, lang) {
  const opener = text[open];
  const closer = { "(": ")", "{": "}", "[": "]" }[opener];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const stringEnd = skipString(text, i, lang);
    if (stringEnd > i) { i = stringEnd - 1; continue; }
    if (text[i] === opener) depth += 1;
    else if (text[i] === closer && --depth === 0) return i;
  }
  return -1;
}

// A `{` body after a declaration's parameters; `interface{}` and `struct{}` in a return type do not open it.
function braceBodyStart(text, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === ";") return -1;
    if (text[i] === "{" && !/\b(?:interface|struct)\s*$/.test(text.slice(Math.max(from, i - 12), i))) return i;
  }
  return -1;
}

// The end of an expression-bodied arrow function: a depth-0 `;`, `,` or closing bracket, or a
// newline that the next line does not continue.
function expressionEnd(text, from, lang) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const stringEnd = skipString(text, i, lang);
    if (stringEnd > i) { i = stringEnd - 1; continue; }
    const ch = text[i];
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) { if (depth === 0) return i; depth -= 1; }
    else if (depth === 0 && (ch === ";" || ch === ",")) return i;
    else if (depth === 0 && ch === "\n" && text.slice(from, i).trim() && !/^\s*[.?:+\-*/%&|=<>]/.test(text.slice(i))) return i;
  }
  return text.length;
}

const collapse = (s) => s.replace(/\s+/g, " ").trim();
const lineStarts = (text) => {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
};
const lineAt = (starts, offset) => {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
};

const JS_FUNCTION = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\(/gm;
const JS_ARROW = /^[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:<[^>(]*>\s*)?\(/gm;
const ARROW_HEAD = /\s*(?::\s*[^=;{]+?)?\s*=>\s*/y;
const PY_DEF = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;
const PY_DEF_TAIL = /[ \t]*(?:->[^:\n]*)?:[ \t]*(?:\n|$)/y;
const GO_FUNC = /^[ \t]*func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/gm;

function braceFunctions(text, lang, pattern, isArrow) {
  const starts = lineStarts(text);
  const out = [];
  for (const m of text.matchAll(pattern)) {
    const open = m.index + m[0].length - 1;
    const close = matching(text, open, lang);
    if (close < 0) continue;
    const fn = { name: m[1], params: collapse(text.slice(open + 1, close)), line: lineAt(starts, m.index), at: m.index, body: null };
    let after = close + 1;
    if (isArrow) {
      ARROW_HEAD.lastIndex = after;
      const head = ARROW_HEAD.exec(text);
      if (!head) continue;
      after += head[0].length;
      if (text[after] !== "{") {
        fn.body = `return ${text.slice(after, expressionEnd(text, after, lang)).trim()};`;
        out.push(fn);
        continue;
      }
    } else after = braceBodyStart(text, after);
    if (after < 0) continue;
    const end = matching(text, after, lang);
    fn.body = end < 0 ? null : text.slice(after + 1, end).trim();
    out.push(fn);
  }
  return out;
}

function pythonFunctions(text, lang) {
  const starts = lineStarts(text);
  const lines = text.split("\n");
  const out = [];
  for (const m of text.matchAll(PY_DEF)) {
    const open = m.index + m[0].length - 1;
    const close = matching(text, open, lang);
    if (close < 0) continue;
    PY_DEF_TAIL.lastIndex = close + 1;
    if (!PY_DEF_TAIL.test(text)) continue;
    const body = [];
    for (const next of lines.slice(lineAt(starts, PY_DEF_TAIL.lastIndex - 1))) {
      if (next.trim() && next.length - next.trimStart().length <= m[1].length) break;
      body.push(next);
    }
    out.push({ name: m[2], params: collapse(text.slice(open + 1, close)), line: lineAt(starts, m.index), at: m.index, body: body.join("\n").trim() });
  }
  return out;
}

// Every function a file declares, in source order; `body` is the comment-free text between its
// braces (or its indented lines), `null` when it never closes.
function extractFunctions(file, rawText) {
  const lang = LANGUAGES.get(extname(file));
  if (!lang) return [];
  const text = stripComments(rawText, lang);
  const found = lang.python ? pythonFunctions(text, lang)
    : lang === JS_LANG ? [...braceFunctions(text, lang, JS_FUNCTION, false), ...braceFunctions(text, lang, JS_ARROW, true)]
      : braceFunctions(text, lang, GO_FUNC, false);
  return found.sort((a, b) => a.at - b.at).map((fn) => ({ ...fn, lang }));
}

// The body with identifiers renamed by first appearance and whitespace dropped, so helpers that
// differ only in naming and layout hash alike. Strings stay verbatim; a member name after `.`
// and a regex escape after `\` are not identifiers.
function normalizeBody(body, lang) {
  const names = new Map();
  let out = "";
  for (let i = 0; i < body.length;) {
    const stringEnd = skipString(body, i, lang);
    if (stringEnd > i) { out += body.slice(i, stringEnd); i = stringEnd; continue; }
    if (WORD_CHAR.test(body[i])) {
      let end = i + 1;
      while (end < body.length && WORD_CHAR.test(body[end])) end += 1;
      const word = body.slice(i, end);
      const member = i > 0 && (body[i - 1] === "." || body[i - 1] === "\\");
      if (!IDENT_START.test(word[0]) || member || lang.keywords.has(word)) out += word;
      else {
        if (!names.has(word)) names.set(word, `v${names.size}`);
        out += names.get(word);
      }
      i = end;
    } else {
      if (!/\s/.test(body[i])) out += body[i];
      i += 1;
    }
  }
  return out;
}

const bodyHash = (normalized) => createHash("sha256").update(normalized).digest("hex").slice(0, 12);
const byFileThenLine = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
const sourceFiles = (files) => files.filter((f) => LANGUAGES.has(extname(f)));

export const sameBodyHelpers = {
  id: "same-body-helpers",
  scan({ files, read }) {
    const groups = new Map();
    for (const file of sourceFiles(files)) {
      for (const fn of extractFunctions(file, read(file) ?? "")) {
        if (fn.body === null) continue;
        const normalized = normalizeBody(fn.body, fn.lang);
        if (normalized.length < MIN_BODY_LENGTH) continue;
        const hash = bodyHash(normalized);
        if (!groups.has(hash)) groups.set(hash, []);
        groups.get(hash).push({ file, line: fn.line, name: fn.name });
      }
    }
    const out = [];
    for (const members of groups.values()) {
      const names = [...new Set(members.map((m) => m.name))].sort();
      if (names.length < 2) continue;
      const clusterKey = `body ${names.join(",")}`;
      for (const { file, line, name } of members) {
        out.push({ kind: "duplicate-logic", file, line, symbol: name, clusterKey, anchor: clusterKey,
          detail: `same body as ${names.filter((n) => n !== name).join(", ")}` });
      }
    }
    return out.sort(byFileThenLine);
  },
};

export const semanticIndex = {
  id: "semantic-index",
  scan: () => [],
  material({ files, read }) {
    const out = [];
    for (const file of sourceFiles(files).sort()) {
      const text = read(file) ?? "";
      const functions = extractFunctions(file, text.slice(0, MAX_CHARS_PER_FILE));
      if (!functions.length) continue;
      out.push({ key: file, kinds: ["semantic-duplicate"], file,
        functions: functions.slice(0, MAX_FUNCTIONS_PER_FILE).map(({ name, params, line }) => ({ name, params, line })),
        truncated: text.length > MAX_CHARS_PER_FILE || functions.length > MAX_FUNCTIONS_PER_FILE });
    }
    return out;
  },
};
