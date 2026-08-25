#!/usr/bin/env node
// Reports broken cross-references in the markdown runtime surface, three kinds:
//   1. ${CLAUDE_PLUGIN_ROOT}/<path> references whose <path> does not exist at the repo root.
//   2. Markdown [text](relative.md#anchor) links whose file or heading anchor is missing.
//   3. §M<n> section-label citations with no matching §M<n> definition anywhere in the surface.
// KNOWN LIMITS: sub-check 3 validates label EXISTENCE, not that a citation points at the right
// owning file; its "definition" heuristic is "a §M<n> in a heading line or a bold-led list
// item", so an oddly-formatted real definition could be missed and over-flag a citation.
//
// ADVISORY, NOT A GATE. Findings print to stdout and the script exits 0; a non-zero exit is
// reserved for abort() (corpus unreadable). Do NOT change this to exit 1 on findings to match
// duplication-check.mjs — that script is a gate; this one is a fact-gatherer.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { DESIGN_DOC } from "./doc-paths.mjs";

const DIRS = ["agents", "commands", "playbooks", "references"];
const ROOT_FILES = [DESIGN_DOC, "CONTRIBUTING.md"];
const args = process.argv.slice(2);
const KNOWN_FLAGS = { "--dir": "value" };
const root = process.cwd();

let explicitDir = null;
try {
  const { flags } = parseFlags(args, KNOWN_FLAGS);
  explicitDir = requireValue(flags, "--dir") ?? null;
} catch (err) {
  console.error(`xref-check: ${err.message}`);
  process.exit(1);
}
const scanRoot = explicitDir ? resolve(explicitDir) : root;

const abort = (m) => {
  console.error(`xref-check: ${m}`);
  process.exit(1);
};

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
  if (explicitDir !== null) return collectFiles(scanRoot);
  const files = [];
  for (const dir of [...DIRS].sort()) {
    const abs = join(scanRoot, dir);
    if (existsSync(abs)) files.push(...collectFiles(abs));
  }
  for (const name of ROOT_FILES) {
    const abs = join(scanRoot, name);
    if (existsSync(abs)) files.push(abs);
  }
  return files;
}

let files;
try {
  files = targetFiles();
} catch (e) {
  abort(`cannot scan ${scanRoot}: ${e.message}`);
}
if (files.length === 0) abort(`no .md files under ${scanRoot} — nothing was checked`);

// GitHub-style heading slug: lowercase, drop non-word (keep spaces/hyphens), spaces -> hyphens.
const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");

// Pass 1: per-file heading slugs (anchor checks) + the global §M-label definitions.
const headingsByFile = new Map();
const definedLabels = new Set();
for (const f of files) {
  const slugs = new Set();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) slugs.add(slug(h[1]));
    const isDef = /^#{1,6}\s/.test(line) || /^\s*(?:[-*]|\d+\.)\s+\*\*/.test(line);
    if (isDef) for (const m of line.matchAll(/§M(\d+)/g)) definedLabels.add(m[1]);
  }
  headingsByFile.set(f, slugs);
}

// Pass 2: check every reference, line by line, in sorted file order.
const TEMPLATE_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g;
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const LABEL_RE = /§M(\d+)/g;
const findings = { template: [], link: [], label: [] };
let templateCount = 0, linkCount = 0, labelCount = 0;

for (const f of files) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    const lineNo = i + 1;
    for (const m of line.matchAll(TEMPLATE_RE)) {
      templateCount++;
      const rel = m[1].replace(/\.+$/, ""); // drop a trailing sentence period
      if (!existsSync(join(scanRoot, rel)))
        findings.template.push(`${relative(root, f)}:${lineNo} → \${CLAUDE_PLUGIN_ROOT}/${rel}`);
    }
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1].trim();
      if (/^(https?:|mailto:|#)/.test(target)) continue;          // external / same-page anchor
      if (target.startsWith("${CLAUDE_PLUGIN_ROOT}")) continue;    // counted by TEMPLATE_RE
      const [path, anchor] = target.split("#");
      if (!path) continue;
      linkCount++;
      const abs = resolve(dirname(f), path);
      if (!existsSync(abs))
        findings.link.push(`${relative(root, f)}:${lineNo} → ${target} (missing file)`);
      else if (anchor && headingsByFile.has(abs) && !headingsByFile.get(abs).has(anchor))
        findings.link.push(`${relative(root, f)}:${lineNo} → ${target} (missing anchor #${anchor})`);
    }
    for (const m of line.matchAll(LABEL_RE)) {
      labelCount++;
      if (!definedLabels.has(m[1]))
        findings.label.push(`${relative(root, f)}:${lineNo} → §M${m[1]} (no definition in surface)`);
    }
  });
}

const total = findings.template.length + findings.link.length + findings.label.length;
if (total) {
  console.log(`xref-check: ${total} broken reference(s)`);
  for (const [kind, list] of [
    ["template path", findings.template],
    ["markdown link", findings.link],
    ["§-label", findings.label],
  ])
    for (const x of list) console.log(`  - [${kind}] ${x}`);
} else {
  console.log(
    `xref-check: ok (${templateCount} template ref(s), ${linkCount} md link(s), ${labelCount} §-label cite(s) checked; 0 broken)`
  );
}
process.exit(0);
