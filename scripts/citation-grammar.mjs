#!/usr/bin/env node
// The citation grammar references/README.md states: `${CLAUDE_PLUGIN_ROOT}/<dir>/<file>.md` means
// read — the citing step opens that file here — and a bare `<dir>/<file>.md` names an owner, which
// nobody opens on the strength of the mention. Pure rule functions scripts/validate.mjs calls, and
// a CLI that prints every hit as a worklist.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.mjs";

export const GRAMMAR_DIRS = ["commands", "playbooks", "references"];
const PREFIXED = /\$\{CLAUDE_PLUGIN_ROOT\}\/((?:references|playbooks|commands)\/[A-Za-z0-9._-]+\.md)/g;
const BACK_EDGE = /\$\{CLAUDE_PLUGIN_ROOT\}\/((?:playbooks|commands)\/[A-Za-z0-9._-]+\.md)/g;
// The lookbehind keeps a path inside a longer one (`docs/playbooks/…`, `tests/fixtures/references/…`)
// and the prefixed form from counting as bare; a `<name>` placeholder never matches the name class.
const BARE = /(?<![\w./}-])((?:references|playbooks|commands)\/[a-z0-9-]+\.md)/g;
const OWNER_VERB = /\b(?:owns|owner|owners|owned|restate|restates|restated|restating)\b/i;
const READ_VERB =
  /\b(?:read|reads|reading|follow|follows|followed|following|run|runs|running|ran|open|opens|opened|opening|consult|consults|consulted|consulting|load|loads|loaded|loading|execute|executes|executed|executing)\b/i;
// bare-read fires only on an imperative read — the verb opens the sentence, after any list marker,
// bold step label, or sequencing word. A read verb anywhere fired on "read-only", "a run" and verbs
// inside code spans far more often than on a real instruction.
const IMPERATIVE_READ =
  /^(?:(?:[-*+]|\d+[a-z]?\.)\s+)?(?:\*\*[^*]+\*\*\s*)?(?:(?:then|first|next|always),?\s+)?(?:re-?read|read|follow|run|open|consult|load|execute)\b/i;
const FENCE = /^\s*(```|~~~)/;

const maskCode = (s) => s.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
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
    .filter((s) => has(PREFIXED, s.text) && OWNER_VERB.test(maskCode(s.text)) && !READ_VERB.test(maskCode(s.text)))
    .map((s) =>
      hit(rel, s.line, "owner-sentence", `prefixed citation in an owner sentence — make it bare, or split a read sentence from an owner sentence: "${excerpt(s.text)}"`)
    );
}

export function bareReadErrors(rel, text) {
  return sentences(text)
    .filter((s) => !has(PREFIXED, s.text) && has(BARE, s.text) && IMPERATIVE_READ.test(s.text))
    .map((s) => hit(rel, s.line, "bare-read", `a step that reads a file must prefix it: "${excerpt(s.text)}"`));
}

export function bareExistsErrors(rel, text, exists) {
  const out = [];
  let fenced = false;
  text.split("\n").forEach((l, i) => {
    if (FENCE.test(l)) fenced = !fenced;
    else if (!fenced)
      for (const m of l.matchAll(BARE)) if (!exists(m[1])) out.push(hit(rel, i + 1, "bare-exists", `${m[1]} names no file in the plugin`));
  });
  return out;
}

// Check 11, tightened: a substring mention no longer counts, because a reference demoted to bare
// everywhere would still pass while nothing reads it. validate.mjs names references in its own
// messages and checks, which makes it their checker, not their consumer.
export function referenceReadErrors({ references, surface, scripts }) {
  const consumers = scripts.filter((s) => s.rel !== "scripts/validate.mjs");
  return references
    .filter((f) => f !== "README.md")
    .filter((f) => {
      const own = `references/${f}`;
      const prefixed = `\${CLAUDE_PLUGIN_ROOT}/${own}`;
      return !surface.some((s) => s.rel !== own && s.text.includes(prefixed)) && !consumers.some((s) => s.text.includes(own));
    })
    .map((f) => hit(`references/${f}`, 0, "reference-read", `references/${f}: no consumer — no surface file reads it prefixed and no script reads it`));
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
  const rels = parsed.flags["--references"] ? [] : parsed.positionals.length ? parsed.positionals : grammarFiles(root);
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
