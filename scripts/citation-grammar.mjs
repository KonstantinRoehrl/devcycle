#!/usr/bin/env node
// The citation grammar references/README.md states: `${CLAUDE_PLUGIN_ROOT}/<dir>/<file>.md` means
// read — the citing step opens that file here — and a bare `<dir>/<file>.md` names an owner, which
// nobody opens on the strength of the mention. Pure rule functions scripts/validate.mjs calls, and
// a CLI that prints every hit as a worklist.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.mjs";

// The grammar's vocabulary, owned here and imported by context-closure.mjs, context-report.mjs and
// stage-entry.mjs, so a path one of them recognises is a path all of them recognise.
export const GRAMMAR_DIRS = ["commands", "playbooks", "references"];
const NAME = "[A-Za-z0-9._-]+";
export const prefixedPattern = (dirs = GRAMMAR_DIRS) =>
  new RegExp(String.raw`\$\{CLAUDE_PLUGIN_ROOT\}\/((?:${dirs.join("|")})\/${NAME}\.md)`, "g");
export const PREFIXED = prefixedPattern();
// The separator between a command's words: horizontal whitespace or a single line break with any
// indentation after it — so an invocation markdown-wraps across a line and is still one — but never a
// line break followed by a blank line, so a paragraph break cannot join unrelated prose into a hit. A
// `\` before the line ending is deliberately NOT a separator, and re-adding it would be a regression:
// that is CommonMark's hard-break syntax as much as it is a shell continuation, the two are textually
// identical, and with no exemption marker prose that merely hard-breaks near a path would fail CI with
// no way out but rewording. The cost accepted for that is missing `node \` + newline + path, a form
// that realistically appears only inside fenced code blocks.
export const SEP = String.raw`(?:[ \t]|\r?\n(?![ \t]*\r?\n))`;
// The section-read form: a step that needs one `##` section of a reference runs
// `node "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs" references/<file>.md <slug>`. Group 1 is the
// reference, group 2 the slug; only references are read by section. The slug is the call's last
// argument, as read-section.mjs takes exactly two: after any spaces or tabs, the call ends — a closing
// backtick, a line break, the end of the text, or a shell operator (`|`, `>`, `<`, `;`, `&`, `)`). So
// `alpha.extra` is no read of `alpha`, and neither is `alpha extra`.
const SECTION_READ_CALL = "${CLAUDE_PLUGIN_ROOT}/scripts/read-section.mjs";
const sectionReadPattern = (reference, slug, flags) =>
  new RegExp(
    String.raw`\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/read-section\.mjs"?${SEP}+${reference}${SEP}+${slug}(?=[ \t]*(?:[\x60|><;&)\r\n]|$))`,
    flags
  );
export const SECTION_READ = sectionReadPattern(String.raw`(references\/${NAME}\.md)`, "([a-z0-9_-]+)", "g");
// The form written out with its placeholders, as the grammar's owner documents it, is no call.
const SECTION_READ_TEMPLATE = sectionReadPattern(String.raw`references\/<file>\.md`, "<slug>", "y");

// The text with every section read blanked but its line breaks, so line numbers still hold and a
// section read's reference is never mistaken for a bare mention.
export const withoutSectionReads = (text) => text.replace(SECTION_READ, (m) => m.replace(/[^\n]/g, ""));

// Each read-section.mjs call SECTION_READ does not parse — an uppercase slug, a quoted argument, a
// tail past the slug — as written up to the end of its line or code span. Unparsed, it is a read no
// check resolves and no closure counts.
export function unparsedSectionReads(text) {
  const parsed = new Set([...text.matchAll(SECTION_READ)].map((m) => m.index));
  const out = [];
  for (let i = text.indexOf(SECTION_READ_CALL); i !== -1; i = text.indexOf(SECTION_READ_CALL, i + 1)) {
    SECTION_READ_TEMPLATE.lastIndex = i;
    if (!parsed.has(i) && !SECTION_READ_TEMPLATE.test(text)) out.push(text.slice(i).match(/^[^`\n]*/)[0]);
  }
  return out;
}
const BACK_EDGE = prefixedPattern(["playbooks", "commands"]);
// The lookbehind keeps a path inside a longer one (`docs/playbooks/…`, `tests/fixtures/references/…`)
// and the prefixed form from counting as bare; a `<name>` placeholder never matches the name class.
export const BARE = new RegExp(String.raw`(?<![\w./}-])((?:${GRAMMAR_DIRS.join("|")})\/${NAME}\.md)`, "g");
const OWNER_VERB = /\b(?:owns|owner|owners|owned|restate|restates|restated|restating)\b/i;
// A read is imperative: the verb opens the sentence, after any list marker, bold step label (or the
// bold that opens one), or sequencing word. A read verb anywhere fired on "read-only", "a run",
// "what follows" and verbs inside code spans far more often than on a real instruction.
const READ = String.raw`(?:re-?read|read|follow|run|open|consult|load|execute)(?![\w-])`;
const LEAD = String.raw`(?:(?:[-*+]|\d+[a-z]?\.)\s+)?(?:\*\*[^*]+\*\*\s*)?(?:\*\*)?(?:(?:then|first|next|always),?\s+)?`;
const IMPERATIVE_READ = new RegExp(`^${LEAD}${READ}`, "i");
// The owner-sentence exemption also takes an imperative read that opens a later clause or a table
// cell: "It owns the walk, so read `…` first." The verb must take an object — a code span or a
// determiner — so "run by validate.mjs" and "the run order" are no reads.
const OBJECT = String.raw`(?=\s+(?:\x60|(?:the|a|an|it|its|this|that|these|those|each|every|both|all|them)\b))`;
const CLAUSE_READ = new RegExp(
  String.raw`(?:^${LEAD}|(?:[,;:|—–]\s+|\(\s*|\b(?:and|so|then)\s+)(?:(?:then|first|next|always),?\s+)?)${READ}${OBJECT}`,
  "i"
);
const FENCE = /^\s*(```|~~~)/;

// Blanks a code span's content but keeps its backticks, so a read verb's object still shows.
const maskCode = (s) => s.replace(/`[^`]*`/g, (m) => `\`${" ".repeat(m.length - 2)}\``);
// `search`, not `test`: a /g regex's `test` carries `lastIndex` from one call into the next.
const has = (re, s) => s.search(re) !== -1;
const excerpt = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);
const hit = (rel, line, rule, message) => ({ rel, line, rule, message });

// A sentence ends at `.`, `;` or `:` followed by whitespace or the end of a line, at a blank line,
// or where a list item or heading starts. Inside an inline code span a boundary does not count, so
// the `.` in `resume.md` never splits; fenced blocks are skipped; a table row is one sentence.
export function sentences(text) {
  const out = [];
  let cur = "";
  let start = 0;
  let fenced = false;
  // Spans can wrap a line break, so the code state carries across lines and resets only where a
  // span cannot continue: a fence, a blank line, a table row, a list item, a heading.
  let inCode = false;
  const flush = () => {
    if (cur.trim()) out.push({ text: cur.trim(), line: start });
    cur = "";
  };
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (FENCE.test(raw)) {
      flush();
      fenced = !fenced;
      inCode = false;
      return;
    }
    if (fenced) return;
    if (!raw.trim()) {
      inCode = false;
      return flush();
    }
    if (/^\s*\|/.test(raw)) {
      flush();
      inCode = false;
      out.push({ text: raw.trim(), line });
      return;
    }
    const heading = /^#{1,6}\s/.test(raw);
    if (heading || /^\s*(?:[-*+]|\d+[a-z]?\.)\s/.test(raw)) {
      flush();
      inCode = false;
    }
    for (let j = 0; j < raw.length; j++) {
      if (!cur.trim()) start = line;
      const c = raw[j];
      cur += c;
      if (c === "`") inCode = !inCode;
      else if (!inCode && /[.;:]/.test(c) && (j + 1 === raw.length || /\s/.test(raw[j + 1]))) flush();
    }
    if (heading) flush();
    else cur += " ";
  });
  flush();
  return out;
}

// Every line counts, fenced or not: a prefixed path is followed wherever it sits.
export function backEdgeErrors(rel, text) {
  if (!rel.startsWith("references/")) return [];
  return text.split("\n").flatMap((l, i) =>
    [...l.matchAll(BACK_EDGE)].map((m) =>
      hit(rel, i + 1, "back-edge", `\${CLAUDE_PLUGIN_ROOT}/${m[1]} — a reference names a playbook or command bare, never prefixed`)
    )
  );
}

export function ownerSentenceErrors(rel, text) {
  return sentences(text)
    .filter((s) => has(PREFIXED, s.text) && OWNER_VERB.test(maskCode(s.text)) && !CLAUSE_READ.test(maskCode(s.text)))
    .map((s) =>
      hit(rel, s.line, "owner-sentence", `prefixed citation in an owner sentence — make it bare, or split a read sentence from an owner sentence: "${excerpt(s.text)}"`)
    );
}

export function bareReadErrors(rel, text) {
  return sentences(text)
    .filter((s) => {
      const t = s.text.replace(SECTION_READ, "");
      return !has(PREFIXED, t) && has(BARE, t) && IMPERATIVE_READ.test(t);
    })
    .map((s) => hit(rel, s.line, "bare-read", `a step that reads a file must prefix it: "${excerpt(s.text)}"`));
}

// A section read's reference is check 4c's to resolve, so a missing one is reported once, there.
export function bareExistsErrors(rel, text, exists) {
  const out = [];
  let fenced = false;
  withoutSectionReads(text).split("\n").forEach((l, i) => {
    if (FENCE.test(l)) fenced = !fenced;
    else if (!fenced)
      for (const m of l.matchAll(BARE)) if (!exists(m[1])) out.push(hit(rel, i + 1, "bare-exists", `${m[1]} names no file in the plugin`));
  });
  return out;
}

// A `/` after one of these words opens a regex literal; after any other word it divides.
const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

// A script's string literals and template-literal text, in source order, each with the source span
// of its delimiters. Comments and regex literals are walked past whole, so a quote inside `/[^']/`
// opens nothing and a `//` inside a string closes nothing; a `${…}` expression is scanned as code.
// `whole` marks a literal that is the entire quoted value — a template with no `${…}` included.
export function scriptLiterals(src) {
  const out = [];
  const templateBraces = []; // one per open `{`: true when it is a template's `${`
  let regexAllowed = true;
  let i = src.startsWith("#!") ? src.indexOf("\n") + 1 || src.length : 0;
  // Scan to the unescaped `close`; a string stops at a newline, a template only at `close` or `${`.
  const scanTo = (from, close, multiline) => {
    let j = from;
    while (j < src.length && src[j] !== close && (multiline || src[j] !== "\n")) {
      if (src[j] === "\\") j++;
      else if (close === "`" && src[j] === "$" && src[j + 1] === "{") break;
      j++;
    }
    return Math.min(j, src.length);
  };
  const templateText = (open) => {
    const j = scanTo(open + 1, "`", true);
    const opensExpr = src[j] === "$";
    out.push({ value: src.slice(open + 1, j), start: open, end: j + (opensExpr ? 2 : 1), whole: src[open] === "`" && !opensExpr });
    if (opensExpr) templateBraces.push(true);
    regexAllowed = opensExpr;
    return j + (opensExpr ? 2 : 1);
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) === -1 ? src.length : src.indexOf("*/", i + 2) + 2;
    else if (c === '"' || c === "'") {
      const j = scanTo(i + 1, c, false);
      out.push({ value: src.slice(i + 1, j), start: i, end: j + 1, whole: true });
      i = j + 1;
      regexAllowed = false;
    } else if (c === "`" || (c === "}" && templateBraces.at(-1))) {
      if (c === "}") templateBraces.pop();
      i = templateText(i);
    } else if (c === "/" && regexAllowed) {
      let j = i + 1;
      for (let inClass = false; j < src.length && src[j] !== "\n" && (inClass || src[j] !== "/"); j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
      }
      i = j + 1;
      while (/\w/.test(src[i] ?? "")) i++;
      regexAllowed = false;
    } else if (/[\w$]/.test(c)) {
      const word = src.slice(i).match(/^[\w$]+/)[0];
      i += word.length;
      regexAllowed = REGEX_AFTER_WORD.has(word);
    } else {
      if (c === "{") templateBraces.push(false);
      else if (c === "}") templateBraces.pop();
      regexAllowed = c !== ")" && c !== "]";
      i++;
    }
  }
  return out;
}

// A script reads a reference when a string literal names the path (`"references/x.md"`,
// `` `${root}/references/x.md` ``) or two adjacent ones are `join(…, "references", "x.md")`'s
// segments. A path in a comment, a regex or bare code is no read.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesInCode = ({ src, literals }, name) => {
  const path = new RegExp(String.raw`(?<![\w-])references\/${escape(name)}(?![\w-])`);
  const segments = (l, next) =>
    l.whole && next?.whole && l.value === "references" && next.value === name && /^\s*,\s*$/.test(src.slice(l.end, next.start));
  return literals.some((l, k) => path.test(l.value) || segments(l, literals[k + 1]));
};

// Check 11, tightened: a substring mention no longer counts, because a reference demoted to bare
// everywhere would still pass while nothing reads it — and a script counts only where a string
// literal in it names the file. validate.mjs names references in its own messages and checks,
// which makes it their checker, not their consumer.
export function referenceReadErrors({ references, surface, scripts }) {
  const consumers = scripts
    .filter((s) => s.rel !== "scripts/validate.mjs")
    .map((s) => ({ src: s.text, literals: scriptLiterals(s.text) }));
  return references
    .filter((f) => f !== "README.md")
    .filter((f) => {
      const own = `references/${f}`;
      const prefixed = `\${CLAUDE_PLUGIN_ROOT}/${own}`;
      const reads = (s) => s.text.includes(prefixed) || [...s.text.matchAll(SECTION_READ)].some((m) => m[1] === own);
      return !surface.some((s) => s.rel !== own && reads(s)) && !consumers.some((script) => namesInCode(script, f));
    })
    .map((f) => hit(`references/${f}`, 0, "reference-read", `references/${f}: no consumer — no surface file reads it prefixed or by section and no script reads it`));
}

// Who reads each reference, for validate.mjs check 15's fan-in threshold: every reference a surface
// file other than itself reads by prefix or by section, mapped to the set of its readers' paths.
export function referenceReaders(surface) {
  const readers = new Map();
  for (const { rel, text } of surface) {
    const prefixed = [...text.matchAll(PREFIXED)].map((m) => m[1]).filter((p) => p.startsWith("references/"));
    const bySection = [...text.matchAll(SECTION_READ)].map((m) => m[1]);
    for (const ref of [...prefixed, ...bySection]) {
      if (ref === rel) continue;
      if (!readers.has(ref)) readers.set(ref, new Set());
      readers.get(ref).add(rel);
    }
  }
  return readers;
}

export const grammarFiles = (root) =>
  GRAMMAR_DIRS.flatMap((d) =>
    existsSync(join(root, d)) ? readdirSync(join(root, d)).filter((f) => f.endsWith(".md")).map((f) => `${d}/${f}`) : []
  );

// The whole-tree half of the grammar: which references nothing reads any more. Agents count as
// readers here, as in check 11, because a subagent's citation is still a read.
export function referenceHits(root) {
  const md = (d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).filter((f) => f.endsWith(".md")) : []);
  const surface = [...GRAMMAR_DIRS, "agents"].flatMap((d) => md(d).map((f) => `${d}/${f}`));
  const scriptsDir = join(root, "scripts");
  const scripts = existsSync(scriptsDir)
    ? readdirSync(scriptsDir, { recursive: true }).filter((f) => statSync(join(scriptsDir, f)).isFile())
    : [];
  return referenceReadErrors({
    references: md("references"),
    surface: surface.map((rel) => ({ rel, text: readFileSync(join(root, rel), "utf8") })),
    scripts: scripts.map((f) => ({ rel: `scripts/${f}`, text: readFileSync(join(scriptsDir, f), "utf8") })),
  });
}

export function grammarHits(root, rels) {
  const exists = (r) => existsSync(join(root, r));
  return rels.flatMap((rel) => {
    const text = readFileSync(join(root, rel), "utf8");
    return [...backEdgeErrors(rel, text), ...ownerSentenceErrors(rel, text), ...bareReadErrors(rel, text), ...bareExistsErrors(rel, text, exists)];
  });
}

function main(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, { "--json": "none", "--references": "none" }, { allowPositionals: true });
    if (parsed.flags["--references"] && parsed.positionals.length) throw new Error("--references takes no file arguments");
  } catch (err) {
    console.error(`citation-grammar: ${err.message}`);
    console.error("citation-grammar: usage: citation-grammar.mjs [--json] [--references | <surface file>...]");
    process.exit(1);
  }
  const root = process.cwd();
  // Every rule keys on the root-relative path, so `./references/x.md` or an absolute path must
  // reach them as `references/x.md`, or back-edge never sees the reference.
  const named = parsed.positionals.map((p) => ({ p, rel: relative(root, resolve(root, p)) }));
  const outside = named.filter(({ rel }) => rel.startsWith("..") || isAbsolute(rel)).map(({ p }) => p);
  if (outside.length) {
    console.error(`citation-grammar: outside the plugin root: ${outside.join(", ")}`);
    process.exit(1);
  }
  const rels = parsed.flags["--references"] ? [] : named.length ? named.map(({ rel }) => rel) : grammarFiles(root);
  const missing = rels.filter((r) => !existsSync(join(root, r)));
  if (missing.length) {
    console.error(`citation-grammar: no such file: ${missing.join(", ")}`);
    process.exit(1);
  }
  const hits = parsed.flags["--references"] ? referenceHits(root) : grammarHits(root, rels);
  if (parsed.flags["--json"]) process.stdout.write(JSON.stringify(hits) + "\n");
  else {
    for (const h of hits) console.log(`${h.rel}:${h.line}  ${h.rule}  ${h.message}`);
    console.log(`citation-grammar: ${hits.length} hit(s) in ${rels.length} file(s)`);
  }
  process.exit(hits.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
