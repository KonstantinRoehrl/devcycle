#!/usr/bin/env node
// Splits every paragraph of the runtime surface — commands/, playbooks/, agents/,
// references/ (or --dir's *.md files), plus DESIGN.md and CONTRIBUTING.md — normalizes it,
// and flags near-duplicate pairs,
// including two paragraphs of the same file. Two passes over one normalization:
//   - shingled Jaccard over whole paragraphs, which catches near-verbatim restatement;
//   - Jaccard over content words alone, which catches the same rule stated in different
//     words, where the word order has changed enough to sink the shingle score.
// Two things are never compared, each documented at its own exemption below: a file's YAML
// frontmatter, and the declared shared-preamble convention.
// Output is order-stable: directories and files are walked in sorted order, so the same
// tree always reports the same pairs in the same order.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const DIRS = ["agents", "commands", "playbooks", "references"];
const THRESHOLD = 0.8; // shingle Jaccard: near-verbatim restatement
const CONTENT_THRESHOLD = 0.55; // content-word Jaccard: the same rule in different words
const SHINGLE_SIZE = 5; // words per shingle
const MIN_PARAGRAPH_WORDS = 20; // shorter paragraphs (headings, single lines) are exempt

// Function words carry no ownership, so they would inflate every pair's content-word
// score toward each other; content words are what a rule is actually about.
const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have how " +
    "if in into is it its may might must no nor not of on once only or other our out over own " +
    "per shall should so some such than that the their them then there these they this those " +
    "through to too under until up use used using was were what when where whether which while " +
    "who whom why will with within would you your we us i"
  ).split(" ")
);

const args = process.argv.slice(2);
const KNOWN_FLAGS = { "--dir": "value" };
const root = process.cwd();
// A flag this script never read is a false green waiting to happen: a typo, or a dropped flag
// name leaving a bare token, would otherwise scan the cwd and report it clean. cli-flags.mjs owns
// the unknown-flag check, the missing-value one, and — since this script takes no positional —
// the bare-token one; this script only owns the message prefix and the exit code.
let explicitDir = null;
try {
  const { flags } = parseFlags(args, KNOWN_FLAGS);
  explicitDir = requireValue(flags, "--dir") ?? null;
} catch (err) {
  console.error(`duplication-check: ${err.message}`);
  process.exit(1);
}
const targetDir = explicitDir ?? root;

const errors = [];
const fail = (m) => errors.push(m);
// A corpus this run could not read is not a clean corpus: every abort below would otherwise
// have printed `duplication-check: ok` in CI while comparing nothing.
const abort = (m) => {
  console.error(`duplication-check: ${m}`);
  process.exit(1);
};

// Read errors propagate: a directory that cannot be listed is reported, never skipped.
function collectFiles(dir) {
  const out = [];
  for (const name of [...readdirSync(dir)].sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectFiles(p));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

function targetFiles() {
  if (explicitDir !== null) return collectFiles(targetDir);
  const files = [];
  for (const dir of [...DIRS].sort()) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of [...readdirSync(abs)].sort())
      if (name.endsWith(".md")) files.push(join(abs, name));
  }
  const ROOT_FILES = ["DESIGN.md", "CONTRIBUTING.md"];
  for (const name of ROOT_FILES) {
    const abs = join(root, name);
    if (existsSync(abs)) files.push(abs);
  }
  return files;
}

// The single normalization both passes read from: markdown stripped to its prose, one
// space between words, lowercased.
function normalize(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// EXEMPTION 1 — YAML frontmatter is not prose and is never compared.
// A command's `description:` field is machine-readable metadata that the body is expected to
// expand on; comparing the two would fail every command whose body opens by explaining
// itself. Only a leading fence counts, and the *first* closing fence terminates it, so a
// `---` horizontal rule further down the body can never be read as the end of frontmatter.
function stripFrontmatter(raw) {
  const fence = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(raw);
  return fence ? raw.slice(fence[0].length) : raw;
}

// EXEMPTION 2 — the declared shared-preamble convention is reuse, not duplication.
// Every `references/*.md` file opens by naming itself the single owner of its subject and
// telling consumers to point at it instead of restating it. That is a convention this repo
// deliberately enforces, and a reviewer already ruled it legitimate reuse.
//
// Why an exemption rather than a higher threshold: the convention's own pairwise
// content-word scores span 0.529–0.688, so 0.55 cuts through the middle of them — four of
// its five pairs fire and the fifth sits 0.021 under the line, which means one shared word
// added to an unrelated preamble flips the gate red with no duplication introduced. Raising
// the threshold past 0.688 would also stop catching real duplication (a command restating
// its own playbook measures 0.783). So the threshold stays at 0.55 and the convention is
// exempted by shape.
//
// Narrow by construction: a pair is skipped only when BOTH paragraphs open with "the single
// owner of" AND carry the "names this file and does not restate it" clause. Any other
// duplicated paragraph — including one in a reference file, including a second paragraph of
// a file whose preamble is exempt — is still compared and still fails.
const isSharedPreamble = (text) =>
  /^the single owner of\b/.test(text) && /names this file and does not restate it/.test(text);

function paragraphs(path) {
  const raw = stripFrontmatter(readFileSync(path, "utf8"));
  return raw
    .split(/\n\s*\n+/)
    .map(normalize)
    .filter((p) => p.split(" ").length >= MIN_PARAGRAPH_WORDS);
}

function shingles(text) {
  const words = text.split(" ");
  const set = new Set();
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    set.add(words.slice(i, i + SHINGLE_SIZE).join(" "));
  }
  return set;
}

function contentWords(text) {
  const set = new Set();
  for (const word of text.split(" ")) {
    const w = word.replace(/[^a-z0-9-]/g, "");
    if (w.length > 2 && !STOPWORDS.has(w)) set.add(w);
  }
  return set;
}

function jaccard(a, b) {
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

let files;
try {
  files = targetFiles();
} catch (e) {
  abort(`cannot scan ${targetDir}: ${e.message}`);
}
if (files.length === 0) abort(`no .md files under ${targetDir} — nothing was compared`);

const entries = [];
for (const f of files) {
  paragraphs(f).forEach((text, idx) => {
    entries.push({
      file: f,
      idx,
      preamble: isSharedPreamble(text),
      shingles: shingles(text),
      content: contentWords(text),
    });
  });
}

for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    // j > i, so a paragraph is never compared against itself; every other pair is in
    // scope, including two paragraphs of the same file, apart from the one exemption below.
    const a = entries[i];
    const b = entries[j];
    if (a.preamble && b.preamble) continue; // see EXEMPTION 2
    const sim = jaccard(a.shingles, b.shingles);
    const contentSim = jaccard(a.content, b.content);
    if (sim >= THRESHOLD || contentSim >= CONTENT_THRESHOLD) {
      fail(
        `${relative(root, a.file)}:paragraph ${a.idx + 1} ~= ${relative(root, b.file)}:paragraph ${b.idx + 1}` +
          ` (shingle ${Math.round(sim * 100)}%, content-word ${Math.round(contentSim * 100)}%)`
      );
    }
  }
}

if (errors.length) {
  console.error("DUPLICATION CHECK FAILED:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log(`duplication-check: ok (${entries.length} paragraph(s) across ${files.length} file(s))`);
