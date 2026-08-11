#!/usr/bin/env node
// Validates plugin manifests, command frontmatter, description budget,
// markdown fences, and cross-references between the plugin's own surface files.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const DESCRIPTION_BUDGET_TOTAL = 6000; // chars; source: docs/platform-notes.md
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

// --- frontmatter of commands ---
// Playbooks are loaded by path and appear in no roster, so they carry no
// frontmatter and consume no description budget.
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
if (existsSync(join(root, "commands")))
  for (const f of readdirSync(join(root, "commands"))) {
    if (!f.endsWith(".md")) continue; // a stray .DS_Store is not a command
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
const SURFACE = ["playbooks", "commands", "agents", "references"];
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

  // 3. Every devcycle:<name> must resolve to an agent or a command. Playbooks are addressed
  //    by path (check 4), never by a devcycle: id — naming one here means someone tried to
  //    invoke stage logic as if it were a user-facing skill.
  for (const [, , name] of text.matchAll(/(^|[^A-Za-z0-9_-])devcycle:([a-z0-9][a-z0-9-]*)/g)) {
    if (existsSync(join(root, `playbooks/${name}.md`)))
      once(`ref:${name}`, `${rel(p)}: devcycle:${name} names a playbook — reference it as \${CLAUDE_PLUGIN_ROOT}/playbooks/${name}.md`);
    else if (![`agents/${name}.md`, `commands/${name}.md`].some((c) => existsSync(join(root, c))))
      once(`ref:${name}`, `${rel(p)}: unresolved devcycle:${name} (no agents/${name}.md or commands/${name}.md)`);
  }

  // 4. Every ${CLAUDE_PLUGIN_ROOT}/<path> must name a file that ships.
  for (const [, raw] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
    const target = raw.replace(/[.,;:]+$/, "");
    const abs = join(root, target);
    if (!existsSync(abs) || !statSync(abs).isFile())
      once(`root:${target}`, `${rel(p)}: \${CLAUDE_PLUGIN_ROOT}/${target} names no file in the plugin`);
  }
}

// 5. A playbook that emits a handoff block must name the reference that owns its shape.
//    The tree spells the same act three ways, so all three count: a heading naming the
//    handoff (`## Handoff`, `## Output and handoff`), a bold run-in step label
//    (`6. **Handoff.**`), and the inline instruction "emit the handoff block". Prose that
//    denies emitting one ("emits no handoff block") describes a non-emitter and is
//    deliberately not matched — three playbooks say exactly that and owe no reference.
const EMITS_HANDOFF = [/^#{1,6}\s.*handoff/i, /\*\*handoff\b/i, /\bemit the handoff\b/i];
if (existsSync(join(root, "playbooks")))
  for (const f of readdirSync(join(root, "playbooks"))) {
    if (!f.endsWith(".md")) continue;
    const text = readFileSync(join(root, "playbooks", f), "utf8");
    if (text.includes("references/handoff.md")) continue;
    const at = text.split("\n").findIndex((l) => EMITS_HANDOFF.some((p) => p.test(l)));
    if (at !== -1) fail(`playbooks/${f}:${at + 1}: emits a handoff block without referencing references/handoff.md`);
  }

// 6. Every command appears exactly once in the routing table, and its declared consequence
//    agrees with its disable-model-invocation frontmatter.
const routingPath = join(root, "references/routing.md");
if (!existsSync(routingPath)) fail("references/routing.md: missing (the routing table has no owner)");
else if (existsSync(join(root, "commands"))) {
  const routing = readFileSync(routingPath, "utf8");
  const rows = new Map();
  for (const [, name, consequence] of routing.matchAll(/^\|[^|]*\|\s*`([a-z-]+)`\s*\|\s*([a-z-]+)\s*\|/gm)) {
    if (rows.has(name)) fail(`references/routing.md: ${name} appears more than once`);
    rows.set(name, consequence);
  }
  const GUARD_REQUIRED = new Set(["side-effectful", "resume"]);
  // `confirm-first` is the deliberate exception class, so each member names its
  // justification inline — as prose, since the table has no column for one. A bare label
  // ("**`cycle`'s justification.**" with nothing behind it) is not a justification, which
  // is what the character floor rules out.
  const JUSTIFICATION_MIN_CHARS = 80;
  const prose = routing.split(/\n[ \t]*\n/).filter((b) => !b.trimStart().startsWith("|"));
  const justifies = (name) =>
    prose.some(
      (b) =>
        b.includes(`\`${name}\``) && /justif/i.test(b) && b.replace(/\s+/g, " ").trim().length >= JUSTIFICATION_MIN_CHARS
    );
  for (const f of readdirSync(join(root, "commands"))) {
    if (!f.endsWith(".md")) continue;
    const name = f.replace(/\.md$/, "");
    if (!rows.has(name)) { fail(`commands/${f}: missing from the routing table in references/routing.md`); continue; }
    const consequence = rows.get(name);
    const guarded = frontmatter(join(root, "commands", f))?.["disable-model-invocation"] === "true";
    if (GUARD_REQUIRED.has(consequence) && !guarded)
      fail(`commands/${f}: consequence "${consequence}" requires disable-model-invocation: true`);
    if (consequence === "read-only" && guarded)
      fail(`commands/${f}: consequence "read-only" forbids disable-model-invocation`);
    if (consequence === "confirm-first" && !justifies(name))
      fail(`references/routing.md: \`${name}\` is confirm-first but names no justification — the exception class requires one inline`);
  }
  for (const name of rows.keys())
    if (!existsSync(join(root, `commands/${name}.md`)))
      fail(`references/routing.md: row "${name}" names no command`);
}

// 7. skills/ is not part of the surface any more.
if (existsSync(join(root, "skills")))
  fail("skills/: no longer part of the surface — stage logic lives in playbooks/, loaded by path");

// Flat listing of the .md files directly under a surface directory.
const namesIn = (dir) =>
  existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")) : [];

// 8. Naming: commands are verbs, playbooks are gerunds, agents are role nouns.
// No exemption list: the rule is "not a gerund", and the one recorded exception to
// "commands are verbs" — `doctor`, on the brew/flutter/npm precedent — is a noun, so it
// satisfies this rule on its own merits. The precedent is recorded in references/routing.md,
// not in code. A command that genuinely needs a gerund name gets an allowlist then, with a
// test that exercises it.
for (const f of namesIn("commands")) {
  const name = f.replace(/\.md$/, "");
  if (/ing$/.test(name))
    fail(`commands/${f}: command names are verbs, not gerunds ("${name}" ends in -ing)`);
}
for (const f of namesIn("playbooks")) {
  const name = f.replace(/\.md$/, "");
  if (!/(^|-)[a-z]+ing(-|$)/.test(name))
    fail(`playbooks/${f}: playbook names are gerunds ("${name}" contains no -ing word)`);
}

// 9. Line budgets, as numbers. Counted the way `wc -l` counts: a file's closing
//    newline terminates its last line rather than starting an empty one.
const SURFACE_LINE_BUDGET = 3550, COMMAND_LINE_MAX = 104, PLAYBOOK_LINE_MAX = 154;
const lines = (p) => {
  const text = readFileSync(p, "utf8");
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
};
let surfaceLines = 0;
for (const p of surface) {
  const n = lines(p), r = rel(p);
  surfaceLines += n;
  if (r.startsWith("commands/") && n > COMMAND_LINE_MAX) fail(`${r}: ${n} lines > ${COMMAND_LINE_MAX}`);
  if (r.startsWith("playbooks/") && n > PLAYBOOK_LINE_MAX) fail(`${r}: ${n} lines > ${PLAYBOOK_LINE_MAX}`);
}
if (surfaceLines > SURFACE_LINE_BUDGET)
  fail(`runtime surface ${surfaceLines} lines > ${SURFACE_LINE_BUDGET} (commands+playbooks+agents+references)`);

// 10. No agent pins a model — a pin defeats session-tier escalation.
for (const f of namesIn("agents"))
  if (frontmatter(join(root, "agents", f))?.model)
    fail(`agents/${f}: frontmatter must not set model: — a pin defeats session-tier escalation`);

// 11. Every reference has at least one consumer — a surface file that loads it, or a
//     script that reads it (references/routing.md's consumer is this validator's check 6).
//     A reference mentioning itself is not a consumer of itself.
const scripts = existsSync(join(root, "scripts")) ? [...walk(join(root, "scripts"))] : [];
for (const f of namesIn("references")) {
  const needle = `references/${f}`;
  const consumed = [...surface, ...scripts].some(
    (p) => !rel(p).endsWith(needle) && readFileSync(p, "utf8").includes(needle)
  );
  if (!consumed) fail(`references/${f}: no consumer — every reference must be loaded by something`);
}

// 12. The state file's shape is declared once and carried by a fixture, and the two agree —
//     the guard on resumability after `/clear`, which nothing else checks. The declaration is
//     the `# devcycle state` template in references/resume.md; the fixture is any .md under
//     tests/fixtures/ whose first line is that same header. A row the declaration names must
//     be present and carry a value; an extra row is not drift (references/resume.md lets a
//     stage add evidence rows of its own). A declaration with no fixture is the failure this
//     check exists to prevent, so it fails rather than passing on an empty subject.
const STATE_HEADER = "# devcycle state";
const resumePath = join(root, "references/resume.md");
// Take the whole fenced block the header opens, not a run of consecutive `- ` lines: a run
// stops dead at the first line that is not a field — a blank line, a comment, an inserted
// note — and every field after that point would silently vanish from the check, which would
// then pass while the fixture had genuinely drifted.
const stateBlocks = existsSync(resumePath)
  ? [...readFileSync(resumePath, "utf8").matchAll(new RegExp("```[a-z]*\\n" + STATE_HEADER + "\\n[\\s\\S]*?```", "gm"))]
  : [];
// Exactly one block may declare the shape. Silently taking the first would let a second one —
// a stale "what drift used to look like" example, say — become the yardstick by file order,
// which is the same silent-wrong-yardstick failure this check exists to prevent.
if (stateBlocks.length > 1)
  fail(`references/resume.md: ${stateBlocks.length} fenced "${STATE_HEADER}" blocks — the state shape must be declared exactly once`);
// A resume.md that exists but yields no template is a broken declaration, not an absent one:
// without this, renaming the header on both sides while leaving STATE_HEADER stale empties the
// template AND the fixture list at once, and every branch below goes quiet.
if (existsSync(resumePath) && !stateBlocks.length)
  fail(`references/resume.md: no fenced "${STATE_HEADER}" block — the state shape is undeclared, or its fence or header changed shape`);
const stateTemplate = stateBlocks[0]?.[0] ?? "";
const stateFields = [...stateTemplate.matchAll(/^- ([A-Za-z][A-Za-z0-9_-]*):/gm)].map((m) => m[1]);
const fixturesDir = join(root, "tests/fixtures");
const stateFixtures = (existsSync(fixturesDir) ? [...walk(fixturesDir)] : []).filter(
  (p) => p.endsWith(".md") && readFileSync(p, "utf8").startsWith(STATE_HEADER)
);
if (stateFields.length && !stateFixtures.length)
  fail(
    `tests/fixtures/: references/resume.md declares the state file's ${stateFields.length} fields and no fixture carries them — the resume invariant has no guard`
  );
for (const p of stateFixtures) {
  if (!stateFields.length) {
    fail(`${rel(p)}: state-file shape unverifiable — no fields were read from references/resume.md's "${STATE_HEADER}" template (it is absent, or its fence or field rows changed shape)`);
    continue;
  }
  const text = readFileSync(p, "utf8");
  const missing = stateFields.filter((f) => !new RegExp(`^- ${f}:[ \\t]*\\S`, "m").test(text));
  if (missing.length)
    fail(`${rel(p)}: state file drifted from references/resume.md — no value for: ${missing.join(", ")}`);
}

// 13. The run record's shape is declared once, in tests/fixtures/run-record.schema.json, and
//     exercised by a golden fixture. A declaration nothing exercises is the failure this check
//     exists to prevent — the same reason check 12 fails on an empty subject.
const schemaPath = join(root, "tests/fixtures/run-record.schema.json");
const goldenPath = join(root, "tests/fixtures/run-record.golden.jsonl");
if (existsSync(schemaPath)) {
  if (!existsSync(goldenPath))
    fail("tests/fixtures/run-record.schema.json: declared with no golden fixture exercising it");
  else {
    let schema;
    try {
      schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    } catch (err) {
      fail(`tests/fixtures/run-record.schema.json: not valid JSON — ${err.message}`);
      schema = null;
    }
    const golden = readFileSync(goldenPath, "utf8").split("\n").filter(Boolean);
    const parsed = [];
    for (const [i, line] of golden.entries()) {
      try {
        parsed.push(JSON.parse(line));
      } catch (err) {
        fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: not valid JSON — ${err.message}`);
      }
    }
    if (schema) {
      const subs = schema.oneOf ?? [];
      const declaredKinds = subs.map((s) => s.properties?.kind?.const).filter(Boolean);
      const exercised = new Set(parsed.map((o) => o.kind));
      for (const k of declaredKinds)
        if (!exercised.has(k))
          fail(`tests/fixtures/run-record.golden.jsonl: schema declares kind "${k}" that no golden line exercises`);
      for (const [i, obj] of parsed.entries()) {
        const sub = subs.find((s) => s.properties?.kind?.const === obj.kind);
        if (!sub) {
          fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: kind "${obj.kind}" is not declared in the schema`);
          continue;
        }
        for (const req of sub.required ?? [])
          if (!(req in obj) || obj[req] === undefined)
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: missing required field "${req}"`);
        for (const key of Object.keys(obj)) {
          const prop = sub.properties?.[key];
          if (!prop) {
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: field "${key}" is not declared for kind "${obj.kind}"`);
            continue;
          }
          if (prop.enum && !prop.enum.includes(obj[key]))
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: "${key}" value "${obj[key]}" is not one of ${prop.enum.join(" | ")}`);
          if (prop.const !== undefined && obj[key] !== prop.const)
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: "${key}" must be ${JSON.stringify(prop.const)}`);
          if (prop.pattern && !new RegExp(prop.pattern).test(String(obj[key])))
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: "${key}" does not match ${prop.pattern}`);
          if (prop.type === "integer" && !Number.isInteger(obj[key]))
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: "${key}" must be an integer`);
          if (typeof prop.minimum === "number" && obj[key] < prop.minimum)
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: "${key}" must be >= ${prop.minimum}`);
        }
      }
      for (const sub of subs) {
        const exercisedFields = new Set(
          parsed.filter((o) => o.kind === sub.properties?.kind?.const).flatMap((o) => Object.keys(o))
        );
        for (const field of Object.keys(sub.properties ?? {}))
          if (!exercisedFields.has(field))
            fail(`tests/fixtures/run-record.golden.jsonl: schema declares "${sub.title}.${field}" that no golden line for kind "${sub.title}" exercises`);
      }

      // Rule 2 (§10.5): the schema declares no field the writing instructions cannot produce —
      // the same reason stage.path and dispatch.agentId were removed rather than half-wired.
      // A field is "producible" when some counted-surface file's prose names it as a
      // run-record.mjs append/new argument. Most fields pass through run-record.mjs's generic
      // append loop unrenamed (camelCase flag === camelCase key), so `--<field>` is the right
      // literal to search for — EXCEPT the cases below, verified against scripts/run-record.mjs's
      // actual field-sourcing code (main()) rather than assumed: kebab-case `new`-subcommand
      // flags, one explicit rename, and fields the script computes itself rather than ever
      // reading from a flag.
      //
      // Scoped to "run" and "session" kinds only (2026-08-11 decision, docs/DECISIONS.md): those
      // are the only two kinds whose writing instructions are literal CLI documentation (the
      // mint/session-append sites) — every other kind's write instructions are documented
      // conceptually in this codebase's prose (e.g. "with the task id and sha"), never as a
      // literal `--flag`, so this grep-for-`--flag` rule cannot pass against that prose style no
      // matter how complete it is. Those other kinds keep their protection at the kind level via
      // the exercised-kind check above (existing, unchanged) rather than per field.
      // "knobs" is no longer structurally exempt: it is produced by repeated `--knob key=value`
      // flags, so FLAG_NAME below points it at the literal `--knob` substring (singular, not the
      // nonexistent `--knobs`) and it is checked for real, live, every run, same as any other
      // renamed field.
      // "startedAt" is always computed by the script itself (`flags.startedAt ?? new
      // Date().toISOString()...`, scripts/run-record.mjs:114) — no surface instruction ever
      // needs to name `--started-at`.
      const STRUCTURAL_FIELDS = new Set(["kind", "runId", "repoSlug", "schemaVersion", "startedAt"]);
      const FLAG_NAME = { pluginVersion: "plugin-version", pluginSha: "plugin-sha", sessionHash: "sessionId", knobs: "knob" };
      const RULE2_KINDS = new Set(["run", "session"]);
      for (const sub of subs.filter((s) => RULE2_KINDS.has(s.properties?.kind?.const)))
        for (const field of Object.keys(sub.properties ?? {})) {
          if (STRUCTURAL_FIELDS.has(field)) continue; // computed by the script, never a flag
          const flag = FLAG_NAME[field] ?? field;
          const named = [...surface].some((p) => readFileSync(p, "utf8").includes(`--${flag}`));
          if (!named)
            fail(`tests/fixtures/run-record.schema.json: "${sub.title}.${field}" is declared but no surface instruction names --${flag}`);
        }
    }
  }
}

if (errors.length) { console.error("VALIDATION FAILED:\n" + errors.map((e) => " - " + e).join("\n")); process.exit(1); }
console.log("validate: ok");
