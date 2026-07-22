#!/usr/bin/env node
// Validates plugin manifests, skill/command frontmatter, description budget, markdown fences.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const DESCRIPTION_BUDGET_TOTAL = 6000; // chars; source: docs/platform-notes.md
const DESCRIPTION_MAX = 500;
const root = process.cwd();
const errors = [];
const fail = (m) => errors.push(m);

// --- manifests ---
let plugin = {};
try {
  plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  for (const f of ["name", "version", "description", "license", "dependencies"])
    if (!(f in plugin)) fail(`plugin.json: missing "${f}"`);
  if (plugin.name !== "devcycle") fail("plugin.json: name must be devcycle");
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? "")) fail("plugin.json: version not semver");
} catch (e) { fail(`plugin.json: ${e.message}`); }
try {
  const m = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  for (const f of ["name", "owner", "plugins"]) if (!(f in m)) fail(`marketplace.json: missing "${f}"`);
  if (!m.plugins?.some((p) => p.source === "./")) fail('marketplace.json: no plugin with source "./"');
} catch (e) { fail(`marketplace.json: ${e.message}`); }

// --- walk tree ---
const SKIP = new Set([".git", "node_modules"]);
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// --- frontmatter of skills + commands ---
function frontmatter(path) {
  const text = readFileSync(path, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}
let budget = 0;
if (existsSync(join(root, "skills")))
  for (const dir of readdirSync(join(root, "skills"))) {
    const p = join(root, "skills", dir, "SKILL.md");
    if (!existsSync(p)) { fail(`skills/${dir}: missing SKILL.md`); continue; }
    const fm = frontmatter(p);
    if (!fm?.name || !fm?.description) { fail(`${p}: frontmatter needs name+description`); continue; }
    if (!fm.description.startsWith("Use when")) fail(`${p}: description must start "Use when"`);
    if (fm.description.length > DESCRIPTION_MAX) fail(`${p}: description > ${DESCRIPTION_MAX} chars`);
    budget += fm.description.length;
  }
if (existsSync(join(root, "commands")))
  for (const f of readdirSync(join(root, "commands"))) {
    const fm = frontmatter(join(root, "commands", f));
    if (!fm?.description) fail(`commands/${f}: frontmatter needs description`);
    else budget += fm.description.length;
  }
if (budget > DESCRIPTION_BUDGET_TOTAL) fail(`total description budget ${budget} > ${DESCRIPTION_BUDGET_TOTAL}`);

// --- balanced fences in all .md ---
for (const p of walk(root))
  if (p.endsWith(".md")) {
    const fences = (readFileSync(p, "utf8").match(/^(```|~~~)/gm) ?? []).length;
    if (fences % 2 !== 0) fail(`${p}: unbalanced code fences (${fences})`);
  }

if (errors.length) { console.error("VALIDATION FAILED:\n" + errors.map((e) => " - " + e).join("\n")); process.exit(1); }
console.log("validate: ok");
