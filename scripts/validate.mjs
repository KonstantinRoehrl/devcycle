#!/usr/bin/env node
// Validates plugin manifests, skill/command frontmatter, description budget,
// markdown fences, and cross-references between the plugin's own surface files.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

// --- cross-references across the plugin surface ---
// These are the files Claude loads at runtime; docs/ and DESIGN.md are prose
// about the plugin and legitimately carry `<name>`-style placeholders.
const SURFACE = ["skills", "commands", "agents", "references"];
const surface = SURFACE.flatMap((d) =>
  existsSync(join(root, d)) ? [...walk(join(root, d))].filter((p) => p.endsWith(".md")) : []
);
const rel = (p) => relative(root, p).split(sep).join("/");

// The stage enum's single source of truth: `- stage: <a|b|c>` in commands/cycle.md.
const cyclePath = join(root, "commands/cycle.md");
const stages = new Set(
  (existsSync(cyclePath) ? readFileSync(cyclePath, "utf8").match(/stage:\s*<([a-z|-]+)>/)?.[1] : "")
    ?.split("|") ?? []
);
// `null` means the knob list could not be read — check 2 reports that, never skips it.
const userConfig = plugin.userConfig;
const knobs =
  userConfig && typeof userConfig === "object" && !Array.isArray(userConfig) ? new Set(Object.keys(userConfig)) : null;

for (const p of surface) {
  const text = readFileSync(p, "utf8");
  const seen = new Set();
  const once = (token, message) => { if (!seen.has(token)) { seen.add(token); fail(message); } };

  // 1. A backticked `stage: <value>` must name a stage in the enum. Anchored on
  //    the backticks: prose like "the pipeline's last stage: resolve …" is not a
  //    reference, and a bare `stage:` names the state-file field, not a value.
  for (const [, value] of text.matchAll(/`stage:[ ]+([^`]+)`/g)) {
    const stage = value.trim();
    if (!stages.size) once(`stage:${stage}`, `${rel(p)}: \`stage: ${stage}\` unverifiable — no stage enum in commands/cycle.md`);
    else if (!stages.has(stage)) once(`stage:${stage}`, `${rel(p)}: unknown stage \`stage: ${stage}\` (not in commands/cycle.md's stage enum)`);
  }

  // 2. Every ${user_config.X} must name a key in plugin.json's userConfig.
  //    ${user_config.KEY} is the literal placeholder documenting the convention.
  for (const [, key] of text.matchAll(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (key === "KEY") continue;
    if (!knobs) once(`knob:${key}`, `${rel(p)}: \${user_config.${key}} unverifiable — no userConfig object in plugin.json`);
    else if (!knobs.has(key)) once(`knob:${key}`, `${rel(p)}: unknown knob \${user_config.${key}} (not in plugin.json userConfig)`);
  }

  // 3. Every devcycle:<name> must resolve to a skill, an agent, or a command.
  for (const [, , name] of text.matchAll(/(^|[^A-Za-z0-9_-])devcycle:([a-z0-9][a-z0-9-]*)/g))
    if (![`skills/${name}/SKILL.md`, `agents/${name}.md`, `commands/${name}.md`].some((c) => existsSync(join(root, c))))
      once(`ref:${name}`, `${rel(p)}: unresolved devcycle:${name} (no skills/${name}/SKILL.md, agents/${name}.md, or commands/${name}.md)`);

  // 4. Every ${CLAUDE_PLUGIN_ROOT}/<path> must name a file that ships.
  for (const [, raw] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
    const target = raw.replace(/[.,;:]+$/, "");
    const abs = join(root, target);
    if (!existsSync(abs) || !statSync(abs).isFile())
      once(`root:${target}`, `${rel(p)}: \${CLAUDE_PLUGIN_ROOT}/${target} names no file in the plugin`);
  }
}

// 5. A skill that emits a handoff block must name the reference that owns its shape.
if (existsSync(join(root, "skills")))
  for (const dir of readdirSync(join(root, "skills"))) {
    const p = join(root, "skills", dir, "SKILL.md");
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    if (text.includes("## Handoff") && !text.includes("references/handoff.md"))
      fail(`skills/${dir}/SKILL.md: emits "## Handoff" without referencing references/handoff.md`);
  }

if (errors.length) { console.error("VALIDATION FAILED:\n" + errors.map((e) => " - " + e).join("\n")); process.exit(1); }
console.log("validate: ok");
