#!/usr/bin/env node
// Splits every playbooks/*.md and references/*.md paragraph (or --dir's *.md files),
// normalizes whitespace, and flags near-duplicate paragraphs living in different files
// via shingled Jaccard similarity — near-verbatim restatement only, not paraphrase.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const THRESHOLD = 0.8; // starting point; tune during implementation against the real corpus
const SHINGLE_SIZE = 5; // words per shingle
const MIN_PARAGRAPH_WORDS = 20; // shorter paragraphs (headings, single lines) are exempt

const args = process.argv.slice(2);
const dirFlagIdx = args.indexOf("--dir");
const root = process.cwd();
const targetDir = dirFlagIdx === -1 ? root : args[dirFlagIdx + 1];

const errors = [];
const fail = (m) => errors.push(m);

function collectFiles(dir) {
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...collectFiles(p));
      else if (p.endsWith(".md")) out.push(p);
    }
  } catch {
    // ignore permission errors
  }
  return out;
}

function targetFiles() {
  if (dirFlagIdx !== -1) return collectFiles(targetDir);
  const files = [];
  if (existsSync(join(root, "playbooks")))
    for (const name of readdirSync(join(root, "playbooks")))
      if (name.endsWith(".md")) files.push(join(root, "playbooks", name));
  if (existsSync(join(root, "references")))
    for (const name of readdirSync(join(root, "references")))
      if (name.endsWith(".md")) files.push(join(root, "references", name));
  return files;
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function paragraphs(path) {
  const raw = readFileSync(path, "utf8");
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

function jaccard(a, b) {
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const files = targetFiles();
const entries = [];
for (const f of files) {
  paragraphs(f).forEach((text, idx) => {
    entries.push({ file: f, idx, text, shingles: shingles(text) });
  });
}

for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i];
    const b = entries[j];
    if (a.file === b.file) continue; // only cross-file duplication is in scope
    const sim = jaccard(a.shingles, b.shingles);
    if (sim >= THRESHOLD) {
      fail(
        `${relative(root, a.file)}:paragraph ${a.idx + 1} ~= ${relative(root, b.file)}:paragraph ${b.idx + 1} (${Math.round(sim * 100)}% overlap)`
      );
    }
  }
}

if (errors.length) {
  console.error("DUPLICATION CHECK FAILED:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("duplication-check: ok");
