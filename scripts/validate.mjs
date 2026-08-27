#!/usr/bin/env node
// Validates plugin manifests, command frontmatter, description budget,
// markdown fences, and cross-references between the plugin's own surface files.
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SEMVER_RE, cmpSemver } from "./semver.mjs";
import { validate as validateRecord, validateCulprit, subSchemaFor } from "./run-record.mjs";


// The learn loop's compiled memory must stay tracked: README/DECISIONS say lessons + promotion
// records survive a clone (the flywheel's suppress/verify/retire need them). A .gitignore that
// re-ignores them silently half-opens the loop. --no-index makes check-ignore consult the ignore
// rules regardless of index state: without it git reports "not ignored" for any already-tracked
// path, so the guard would go permanently dead the moment the store is staged or committed.
export function lessonsTrackingErrors(repoRoot) {
  const errs = [];
  for (const p of ["docs/devcycle/lessons.md", "docs/devcycle/promotions"]) {
    const res = spawnSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: repoRoot });
    if (res.status === 0) errs.push(`.gitignore must not ignore ${p} — the learn loop's records must stay tracked`);
  }
  return errs;
}

const DESCRIPTION_BUDGET_TOTAL = 6000; // chars; source: docs/platform-notes.md

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
    // Every userConfig entry's type must be one the plugin loader accepts, or the whole
    // manifest is rejected on install (0.17.0 shipped type "integer" and failed to load).
    const CONFIG_TYPES = new Set(["string", "number", "boolean", "directory", "file"]);
    if (plugin.userConfig && typeof plugin.userConfig === "object" && !Array.isArray(plugin.userConfig))
      for (const [knob, spec] of Object.entries(plugin.userConfig)) {
        const t = spec?.type;
        if (!CONFIG_TYPES.has(t))
          fail(`plugin.json: userConfig.${knob}.type "${t}" invalid — must be one of ${[...CONFIG_TYPES].join(", ")}`);
      }
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
    //    invoke stage logic as if it were a user-facing skill. Only from this check, an HTML
    //    comment whose entire body is a bare devcycle:<name> anchor is exempt: it is a splice
    //    anchor a script renders into its output, not an invocation, and
    //    playbooks/profiling-sessions.md must state both of doctor.mjs's anchors verbatim because
    //    it owns the splice rule. A devcycle:<name> mentioned inside a longer comment is not a
    //    splice anchor and is still checked. Every other check still reads the whole text.
    const outsideComments = text.replace(/<!--\s*devcycle:[a-z0-9][a-z0-9-]*\s*-->/g, "");
    for (const [, , name] of outsideComments.matchAll(/(^|[^A-Za-z0-9_-])devcycle:([a-z0-9][a-z0-9-]*)/g)) {
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

    // 4b. Check 4 validates the ${CLAUDE_PLUGIN_ROOT} paths that are written; this catches the
    //     form it structurally cannot see. Surface text runs from the INSTALLED plugin, where the
    //     cwd is the user's repo, so a repo-relative `node scripts/<engine>.mjs` resolves to
    //     nothing and the gate it dispatches silently never runs. This is the enforcement point
    //     for CONTRIBUTING.md's rule, which until now was stated with nothing behind it. Both
    //     engine directories count: `workflows/` ships dispatched engines exactly as `scripts/`
    //     does. Everything the defect can wear between `node` and the path is matched with it —
    //     runner flags (`node --experimental-strip-types …`) and a sentence-initial capital
    //     (`Node …`) — since each hides the same broken dispatch. Only `node` is matched:
    //     widening to other runners risks false hits on prose about shell scripts, and there is
    //     no instance to justify it. No exemption marker — a surface file that ever genuinely
    //     needs the literal form changes this check, visibly, in review.
    //     The prescribed ${CLAUDE_PLUGIN_ROOT} form can never match, quoted or bare: the path must
    //     start with an engine directory, and that form starts with `${`. That, not the quoting,
    //     is what keeps the prescribed form clean — so an opening quote is optional and its closing
    //     one is consumed only if it is there. Detection never depends on the quotes balancing: an
    //     unterminated quote, or one closing past the path (`node "scripts/x.mjs --flag"`), is the
    //     same broken dispatch. A separator is horizontal whitespace or a single line break with
    //     any indentation after it — so an invocation markdown-wraps across a line and is still
    //     caught — but never a line break followed by a blank line, so a paragraph break cannot
    //     join unrelated prose into a hit. A `\` before the line ending is deliberately NOT a
    //     separator, and re-adding it would be a regression: that is CommonMark's hard-break
    //     syntax as much as it is a shell continuation, the two are textually identical, and with
    //     no exemption marker prose that merely hard-breaks near a `scripts/` path would fail CI
    //     with no way out but rewording. The cost accepted for that is missing `node \` + newline
    //     + path, a form that realistically appears only inside fenced code blocks. The
    //     alternatives begin with different characters, so a run of them parses one way only and
    //     cannot backtrack. The target class and the trailing-punctuation strip match check 4's,
    //     so a nested path keeps its subdirectory and un-backticked prose does not suggest a fix
    //     ending in a sentence period.
    const SEP = String.raw`(?:[ \t]|\r?\n(?![ \t]*\r?\n))`;
    const BARE_DISPATCH = new RegExp(
      String.raw`(?<![A-Za-z0-9_-])[Nn]ode(?:${SEP}+-{1,2}[A-Za-z0-9][A-Za-z0-9._=-]*)*` +
        String.raw`${SEP}+(["']?)(?:\./)?((?:scripts|workflows)/[A-Za-z0-9._/-]+)\1?`,
      "g"
    );
    for (const [hit, , raw] of text.matchAll(BARE_DISPATCH)) {
      const target = raw.replace(/[.,;:]+$/, "");
      once(
        `barenode:${target}`,
        `${rel(p)}: \`${hit.replace(/\s+/g, " ")}\` uses the repo-relative form — surface text runs ` +
          `from the installed plugin, not this repo; use \${CLAUDE_PLUGIN_ROOT}/${target}`
      );
    }
  }

  // --- continue.md's resume discovery must stay hook-proof ---
  // The discovery step MUST invoke scripts/find-state-files.mjs, a Node-walk that consults no
  // gitignore, rather than an ad-hoc find/rg a gitignore-aware shell hook can silently blind
  // (memory devcycle-state-file-not-found-culprit). Skip when the fixture has no continue.md;
  // the real plugin always ships one.
  const continuePath = join(root, "commands/continue.md");
  if (existsSync(continuePath)) {
    const continueText = readFileSync(continuePath, "utf8");
    if (!continueText.includes("scripts/find-state-files.mjs"))
      fail("commands/continue.md: resume discovery must invoke scripts/find-state-files.mjs (hook-proof enumeration)");
    else if (!existsSync(join(root, "scripts/find-state-files.mjs")))
      fail("commands/continue.md references scripts/find-state-files.mjs but that script is missing");
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
  const routingPath = join(root, "docs/routing.md");
  if (!existsSync(routingPath)) fail("docs/routing.md: missing (the routing table has no owner)");
  else if (existsSync(join(root, "commands"))) {
    const routing = readFileSync(routingPath, "utf8");
    const rows = new Map();
    for (const [, name, consequence] of routing.matchAll(/^\|[^|]*\|\s*`([a-z-]+)`\s*\|\s*([a-z-]+)\s*\|/gm)) {
      if (rows.has(name)) fail(`docs/routing.md: ${name} appears more than once`);
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
      if (!rows.has(name)) { fail(`commands/${f}: missing from the routing table in docs/routing.md`); continue; }
      const consequence = rows.get(name);
      const guarded = frontmatter(join(root, "commands", f))?.["disable-model-invocation"] === "true";
      if (GUARD_REQUIRED.has(consequence) && !guarded)
        fail(`commands/${f}: consequence "${consequence}" requires disable-model-invocation: true`);
      if (consequence === "read-only" && guarded)
        fail(`commands/${f}: consequence "read-only" forbids disable-model-invocation`);
      if (consequence === "confirm-first" && !justifies(name))
        fail(`docs/routing.md: \`${name}\` is confirm-first but names no justification — the exception class requires one inline`);
    }
    for (const name of rows.keys())
      if (!existsSync(join(root, `commands/${name}.md`)))
        fail(`docs/routing.md: row "${name}" names no command`);
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
  // satisfies this rule on its own merits. The precedent is recorded in docs/routing.md,
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

  // 9. Line budgets, as numbers, read from a committed baseline rather than hardcoded here.
  //    Counted the way `wc -l` counts: a file's closing newline terminates its last line
  //    rather than starting an empty one. Growth is not forbidden — it must be a reviewed
  //    decision, so it fails unless the same commit raises the baseline.
  const BUDGET_PATH = "tests/fixtures/surface-budget.json";
  const budgetFile = join(root, BUDGET_PATH);
  //    `budgetsParsed` tracks whether a usable baseline survived, for check 14's reason: a
  //    `budgets === null` sentinel cannot tell "parse failed" from a file whose whole content
  //    legally parses to `null` — and a falsy `budgets` skips every guard below, leaving the
  //    budget unenforced at exit 0.
  let budgets, budgetsParsed = true;
  if (!existsSync(budgetFile)) {
    fail(`${BUDGET_PATH}: missing — the line budgets have no baseline, so no growth could be reviewed`);
    budgetsParsed = false;
  } else {
    try {
      budgets = JSON.parse(readFileSync(budgetFile, "utf8"));
    } catch (e) {
      budgetsParsed = false;
      fail(`${BUDGET_PATH}: not valid JSON — ${e.message}`);
    }
    if (budgetsParsed && (typeof budgets !== "object" || budgets === null || Array.isArray(budgets))) {
      fail(`${BUDGET_PATH}: must be a JSON object carrying the line budgets, got ${JSON.stringify(budgets)}`);
      budgetsParsed = false;
    }
  }
  for (const key of ["surfaceTotal", "commandMax", "playbookMax"]) {
    if (budgetsParsed && !Number.isInteger(budgets[key]))
      fail(`${BUDGET_PATH}: ${key} must be an integer, got ${JSON.stringify(budgets[key])}`);
  }
  const lines = (p) => {
    const text = readFileSync(p, "utf8");
    return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  };
  let surfaceLines = 0;
  for (const p of surface) {
    const n = lines(p), r = rel(p);
    surfaceLines += n;
    if (budgetsParsed && Number.isInteger(budgets.commandMax) && r.startsWith("commands/") && n > budgets.commandMax)
      fail(`${r}: ${n} lines > ${budgets.commandMax} (baseline ${BUDGET_PATH}) — raise the baseline in this same commit if the growth is intended`);
    if (budgetsParsed && Number.isInteger(budgets.playbookMax) && r.startsWith("playbooks/") && n > budgets.playbookMax)
      fail(`${r}: ${n} lines > ${budgets.playbookMax} (baseline ${BUDGET_PATH}) — raise the baseline in this same commit if the growth is intended`);
  }
  if (budgetsParsed && Number.isInteger(budgets.surfaceTotal) && surfaceLines > budgets.surfaceTotal)
    fail(
      `runtime surface ${surfaceLines} lines > baseline ${budgets.surfaceTotal} (${BUDGET_PATH}) — ` +
        `raise the baseline in this same commit if the growth is intended; it is a reviewed decision, not a workaround`
    );

  // 10. No agent pins a model — a pin defeats session-tier escalation.
  for (const f of namesIn("agents"))
    if (frontmatter(join(root, "agents", f))?.model)
      fail(`agents/${f}: frontmatter must not set model: — a pin defeats session-tier escalation`);

  // 11. Every reference has at least one consumer — a surface file that loads it, or a
  //     script that reads it (references/impact-scoring.md's consumer is a comment in
  //     scripts/doctor.mjs; it gains its two surface citations in Phases 2 and 3).
  //     A reference mentioning itself is not a consumer of itself.
  const scripts = existsSync(join(root, "scripts")) ? [...walk(join(root, "scripts"))] : [];
  for (const f of namesIn("references")) {
    // references/README.md is the index — a consumer OF references, not a loadable reference —
    // so nothing cites it and requiring a consumer of it would be self-defeating.
    if (f === "README.md") continue;
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
          const sub = subSchemaFor(schema, obj.kind);
          if (!sub) {
            fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: kind "${obj.kind}" is not declared in the schema`);
            continue;
          }
          // One validator, two moments: run-record.mjs guards every real append, this guards the declared
          // shape in CI. They were separate implementations and had already drifted on the minimum guard.
          const errors = [
            ...validateRecord(obj, sub),
            ...validateCulprit(obj.culprit, join(root, "references/culprits.json")),
          ];
          for (const err of errors) fail(`tests/fixtures/run-record.golden.jsonl:${i + 1}: ${err}`);
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

  // 14. The culprit vocabulary (references/culprits.json) is well-formed: sorted, unique,
  //     lowercase-hyphen slugs of at most 6 words, kinds from the enum, phases from
  //     commands/cycle.md's stage enum, semver since/resolved-in, resolved-in never earlier
  //     than since. The file is part of the shipped surface, so absence is a failure.
  const culpritsPath = join(root, "references/culprits.json");
  const CULPRIT_KINDS = new Set([
    "friction", "correction", "rule-violation", "decision", "contradiction", "win",
  ]);
  const CULPRIT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+){0,5}$/;
  if (!existsSync(culpritsPath)) {
    fail("references/culprits.json: missing — the culprit vocabulary is part of the shipped surface");
  } else {
    // `parsed` tracks whether JSON.parse succeeded — it cannot be impersonated by a legitimate
    // parse result the way a `vocab === null` sentinel can, since the file's whole content may
    // itself legally parse to `null` (or any other non-array value).
    let vocab, parsed = true;
    try {
      vocab = JSON.parse(readFileSync(culpritsPath, "utf8"));
    } catch (e) {
      parsed = false;
      fail(`references/culprits.json: not valid JSON — ${e.message}`);
    }
    if (parsed && !Array.isArray(vocab)) {
      fail("references/culprits.json: must be an array");
      parsed = false;
    }
    if (parsed) {
      const slugs = [];
      for (const [i, e] of vocab.entries()) {
        const at = `references/culprits.json[${i}]`;
        if (typeof e !== "object" || e === null || Array.isArray(e)) {
          fail(`${at}: entry must be an object, got ${JSON.stringify(e)}`);
          continue;
        }
        for (const f of ["slug", "kind", "phase", "desc", "since"])
          if (!(f in e)) fail(`${at}: missing "${f}"`);
        if (typeof e.slug === "string") {
          slugs.push(e.slug);
          if (!CULPRIT_SLUG_RE.test(e.slug))
            fail(`${at}: slug "${e.slug}" is not lowercase-hyphen of at most 6 words`);
        }
        if (!CULPRIT_KINDS.has(e.kind))
          fail(`${at}: kind "${e.kind}" is not one of ${[...CULPRIT_KINDS].join(" | ")}`);
        if (!Array.isArray(e.phase) || e.phase.length === 0)
          fail(`${at}: phase must be a non-empty array`);
        else
          for (const p of e.phase) {
            if (!stages.size) fail(`${at}: phase "${p}" unverifiable — no stage enum in commands/cycle.md`);
            else if (!stages.has(p)) fail(`${at}: phase "${p}" is not in commands/cycle.md's stage enum`);
          }
        if (!SEMVER_RE.test(e.since ?? "")) fail(`${at}: since "${e.since}" is not semver`);
        if ("resolved-in" in e) {
          if (!SEMVER_RE.test(e["resolved-in"]))
            fail(`${at}: resolved-in "${e["resolved-in"]}" is not semver`);
          else if (SEMVER_RE.test(e.since ?? "") && cmpSemver(e["resolved-in"], e.since) < 0)
            fail(`${at}: resolved-in ${e["resolved-in"]} precedes since ${e.since}`);
        }
      }
      if (slugs.join("\n") !== [...slugs].sort().join("\n"))
        fail("references/culprits.json: entries must be sorted by slug");
      const dupes = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
      if (dupes.length) fail(`references/culprits.json: duplicate slug(s) ${dupes.join(", ")}`);
    }
  }

  // 15. Per-stage context budget: a playbook's own bytes plus every reference reachable from it
  //     through ${CLAUDE_PLUGIN_ROOT} citations, against a committed baseline. Bytes, not lines:
  //     a context window is spent in bytes, and a long line costs what it costs. Growth is a
  //     reviewed decision, same rule as check 9.
  const CONTEXT_BUDGET_PATH = "tests/fixtures/context-budget.json";
  const contextFile = join(root, CONTEXT_BUDGET_PATH);
  if (!existsSync(contextFile)) {
    fail(`${CONTEXT_BUDGET_PATH}: missing — no stage declares its context cost, so growth could not be reviewed`);
  } else {
    // `parsed` tracks whether a usable baseline survived, for check 14's reason: a
    // `contextBaseline === null` sentinel cannot tell "parse failed" from a file whose whole
    // content legally parses to `null`, and the shape guard is what keeps a truthy non-object
    // from reaching the `in` below — which throws on a primitive, killing the run before
    // checks 17 and 18 execute at all.
    let contextBaseline, parsed = true;
    try {
      contextBaseline = JSON.parse(readFileSync(contextFile, "utf8"));
    } catch (e) {
      parsed = false;
      fail(`${CONTEXT_BUDGET_PATH}: not valid JSON — ${e.message}`);
    }
    if (parsed && (typeof contextBaseline !== "object" || contextBaseline === null || Array.isArray(contextBaseline))) {
      fail(
        `${CONTEXT_BUDGET_PATH}: must be a JSON object mapping each playbook to its byte budget, ` +
          `got ${JSON.stringify(contextBaseline)}`
      );
      parsed = false;
    }
    if (parsed) {
      // Citations are followed to a fixed point; `seen` makes a citation cycle terminate and
      // counts each file exactly once, which is also what the reader's context actually pays.
      const citationsIn = (text) =>
        [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(references\/[A-Za-z0-9._-]+\.md)/g)].map((m) => m[1]);
      const transitiveBytes = (startRel) => {
        const seen = new Set();
        const queue = [startRel];
        let total = 0;
        while (queue.length) {
          const relPath = queue.shift();
          if (seen.has(relPath)) continue;
          seen.add(relPath);
          const abs = join(root, relPath);
          if (!existsSync(abs)) continue;
          const text = readFileSync(abs, "utf8");
          total += Buffer.byteLength(text);
          queue.push(...citationsIn(text));
        }
        return total;
      };
      const playbookNames = namesIn("playbooks").map((f) => `playbooks/${f}`);
      for (const p of playbookNames) {
        if (!(p in contextBaseline)) {
          fail(`${p}: no entry in ${CONTEXT_BUDGET_PATH} — a stage must declare its context budget`);
          continue;
        }
        const limit = contextBaseline[p];
        if (!Number.isInteger(limit)) {
          fail(`${CONTEXT_BUDGET_PATH}: ${p} must be an integer, got ${JSON.stringify(limit)}`);
          continue;
        }
        const bytes = transitiveBytes(p);
        if (bytes > limit)
          fail(
            `${p}: ${bytes} bytes > baseline ${limit} (${CONTEXT_BUDGET_PATH}, playbook plus its cited references) — ` +
              `raise the baseline in this same commit if the growth is intended`
          );
      }
      for (const p of Object.keys(contextBaseline))
        if (!playbookNames.includes(p))
          fail(`${CONTEXT_BUDGET_PATH}: entry "${p}" names no such playbook — remove it or restore the file`);
    }
  }

  // 16. Every ${CLAUDE_PLUGIN_ROOT} citation resolves: that is check 4 above, which walks every
  //     surface file and tests every cited path against the tree, scripts included. The number is
  //     reserved here so the sequence stays readable — a second parser would report each broken
  //     citation twice, and would fail on a citation that merely ends a sentence unless it also
  //     repeated check 4's trailing-punctuation handling.

  // 17. The command count is a regression guard, not a target. D7 proposed collapsing seven verbs
  //     to five; that required folding `continue` into `cycle` (declined — docs/DECISIONS.md,
  //     2026-08-12) and removing `onboard` (never specified anywhere). Neither happened. The
  //     ceiling is today's count so an added command is a deliberate surface decision, not a file
  //     addition; it was raised 7→8 when `maintain` landed (the deliberate eighth command), and
  //     8→9 when `reconcile` landed (the deliberate ninth command).
  const COMMAND_CEILING = 9;
  const commandCount = namesIn("commands").length;
  if (commandCount > COMMAND_CEILING)
    fail(
      `${commandCount} commands > ${COMMAND_CEILING} — the user-facing verb count is a surface decision, ` +
        `not a file addition; raise this ceiling deliberately or fold the new entry point into an existing one`
    );

  // 18. The model-tier table (references/model-tiers.json) is well-formed: every entry names a
  //     family, an integer rank and a compilable match, ranks ascend strictly, and no family
  //     repeats. The ceiling rule in references/config.md is only as trustworthy as this ordering,
  //     and scripts/model-pool.mjs reads it verbatim.
  const TIERS_PATH_REL = "references/model-tiers.json";
  const tiersFile = join(root, TIERS_PATH_REL);
  if (!existsSync(tiersFile)) {
    fail(`${TIERS_PATH_REL}: missing — the orchestrator ceiling has no ordering to rank against`);
  } else {
    // `parsed` tracks whether a usable table survived, for check 14's reason: a `tierTable === null`
    // sentinel cannot tell "parse failed" from a file whose whole content legally parses to `null`.
    let tierTable, parsed = true;
    try {
      tierTable = JSON.parse(readFileSync(tiersFile, "utf8"));
    } catch (e) {
      parsed = false;
      fail(`${TIERS_PATH_REL}: not valid JSON — ${e.message}`);
    }
    if (parsed && !Array.isArray(tierTable)) {
      fail(`${TIERS_PATH_REL}: must be an array`);
      parsed = false;
    }
    if (parsed) {
      // An empty table is the one well-formed-looking shape the loop below cannot catch: it runs
      // zero times, so `rank()` returns null for every id and every dispatch degrades to the
      // session tier — policy-free, and silently so.
      if (tierTable.length === 0)
        fail(
          `${TIERS_PATH_REL}: 0 entries, at least 1 required — an empty table ranks no family, so ` +
            `every dispatch would fall back to the session tier; restore the tier entries`
        );
      const families = [];
      let previousRank = null;
      for (const [i, e] of tierTable.entries()) {
        const at = `${TIERS_PATH_REL}[${i}]`;
        if (typeof e?.family !== "string" || !e.family)
          fail(`${at}: family must be a non-empty string, got ${JSON.stringify(e?.family)}`);
        else families.push(e.family);
        if (!Number.isInteger(e?.rank)) fail(`${at}: rank must be an integer, got ${JSON.stringify(e?.rank)}`);
        else {
          if (previousRank !== null && e.rank <= previousRank)
            fail(`${at}: ranks must ascend strictly — ${e.rank} follows ${previousRank}; renumber or reorder the table so each rank exceeds the one before`);
          previousRank = e.rank;
        }
        if (typeof e?.match !== "string" || !e.match)
          fail(`${at}: match must be a non-empty string, got ${JSON.stringify(e?.match)}`);
        else {
          try {
            new RegExp(e.match);
          } catch (err) {
            fail(`${at}: match ${JSON.stringify(e.match)} is not a valid regular expression — ${err.message}`);
          }
        }
      }
      const dupeFamilies = [...new Set(families.filter((f, i) => families.indexOf(f) !== i))];
      if (dupeFamilies.length)
        fail(`${TIERS_PATH_REL}: duplicate family name(s) ${dupeFamilies.join(", ")} — each family must appear exactly once, or the ranking it resolves to is ambiguous`);
    }
  }

  // 19. Every CHANGELOG version heading carries its release date. Outer-loop turnaround
  //     (scripts/verification.mjs's releaseDates) measures issue createdAt against the release that
  //     resolved it, so a heading with no date silently drops that release out of the metric.
  const changelogPath = join(root, "CHANGELOG.md");
  if (existsSync(changelogPath)) {
    const VERSION_HEADING = /^## \d+\.\d+\.\d+/;
    const DATED_HEADING = /^## \d+\.\d+\.\d+ — (\d{4})-(\d{2})-(\d{2})[ \t]*$/;
    for (const line of readFileSync(changelogPath, "utf8").split("\n")) {
      if (!VERSION_HEADING.test(line)) continue;
      const m = line.match(DATED_HEADING);
      if (!m) {
        fail(`CHANGELOG.md: heading "${line.trim()}" carries no release date — expected \`## <version> — YYYY-MM-DD\``);
        continue;
      }
      // A real calendar date, not merely the shape: Date rolls 2026-02-30 forward to March 2
      // rather than rejecting it, so the round-trip is the check.
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d)
        fail(`CHANGELOG.md: heading "${line.trim()}" carries "${m[1]}-${m[2]}-${m[3]}", which is not a real calendar date`);
    }
  }

  // 20. A "read-only-mandate" agent — its frontmatter grants Bash, and its body prose asserts
  //     read-only access even though Bash itself is not actually restricted by the harness — must
  //     name both "commit" and "push" among the git operations it disclaims. Naming only one
  //     (as agents/task-reviewer.md once did, "committing" with no "push") leaves the prose
  //     silent on the one write a Bash-wielding "read-only" agent could actually make stick.
  const READ_ONLY_RE = /read[- ]only/i;
  for (const f of namesIn("agents")) {
    const path = join(root, "agents", f);
    const tools = frontmatter(path)?.tools ?? "";
    if (!/\bBash\b/.test(tools)) continue;
    const body = readFileSync(path, "utf8");
    if (!READ_ONLY_RE.test(body)) continue;
    const lower = body.toLowerCase();
    const missing = ["commit", "push"].filter((w) => !lower.includes(w));
    if (missing.length)
      fail(`agents/${f}: grants Bash and claims read-only access but never names ${missing.join(" or ")} among the disallowed git operations`);
  }

  // 21. A job that checks out with `persist-credentials: false` and later runs `git push` must
  //     show re-authentication evidence in between (`git remote set-url`, or a token env var like
  //     GH_TOKEN/GITHUB_TOKEN) — persist-credentials: false deliberately drops the checkout's push
  //     credential, so a push after it with no replacement credential fails at push time, or worse,
  //     invites "fixing" it by dropping persist-credentials: false instead. Text-based, not a YAML
  //     parse: this repo's own workflow YAML is flat enough that job bodies are delimited by their
  //     2-space-indented name lines under `jobs:`.
  const workflowsDir = join(root, ".github/workflows");
  const REAUTH_RE = /git remote set-url|\bGH_TOKEN\b|\bGITHUB_TOKEN\b|\b[A-Z][A-Z0-9]*_TOKEN\b/;
  if (existsSync(workflowsDir))
    for (const f of readdirSync(workflowsDir)) {
      if (!/\.ya?ml$/.test(f)) continue;
      const text = readFileSync(join(workflowsDir, f), "utf8");
      const jobsAt = text.search(/^jobs:[ \t]*$/m);
      if (jobsAt === -1) continue; // no jobs: section, nothing to check
      const jobsText = text.slice(jobsAt);
      const jobHeads = [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)];
      for (const [i, m] of jobHeads.entries()) {
        const jobStart = m.index + m[0].length;
        const jobEnd = i + 1 < jobHeads.length ? jobHeads[i + 1].index : jobsText.length;
        const jobText = jobsText.slice(jobStart, jobEnd);
        const credAt = jobText.search(/persist-credentials:\s*false/);
        if (credAt === -1) continue;
        // Only a hazard when the persist-credentials: false belongs to a checkout step — a
        // detached occurrence elsewhere in the job (there is none in practice, but the text scan
        // cannot otherwise tell) would be a false positive.
        if (jobText.lastIndexOf("actions/checkout", credAt) === -1) continue;
        for (const push of jobText.matchAll(/git push\b/g)) {
          if (push.index <= credAt) continue; // only a push AFTER the checkout is the hazard
          if (!REAUTH_RE.test(jobText.slice(credAt, push.index)))
            fail(
              `.github/workflows/${f}: job "${m[1]}" checks out with persist-credentials: false and later runs ` +
                `git push with no re-authentication evidence (e.g. git remote set-url, or a *_TOKEN env var) in between`
            );
        }
      }
    }

  // 22. hooks/hooks.json is machinery Claude loads at runtime, but it is JSON, so the surface walk
  //     above — scoped to .md under playbooks/ commands/ agents/ references/ — structurally cannot
  //     see it, and check 4's ${CLAUDE_PLUGIN_ROOT} resolution rides on that same walk. Until this
  //     check, renaming a hook script or emptying a matcher silently disarmed a registered hook
  //     while every other check, and every hook test, stayed green. What is asserted here is that
  //     the registration exists at all, and is well-formed and resolvable — every command entry
  //     carries type: "command", every matcher is non-empty and compiles (or is the documented "*"
  //     literal), and every ${CLAUDE_PLUGIN_ROOT} path resolves — the JSON analogue of check 4;
  //     WHICH tools a given hook must cover is policy, asserted in tests/unit/golden-path.test.mjs.
  //     The `hooksParsed` flag follows check 9's baseline pattern: a document that failed to parse
  //     must report that and stop, never fall through and leave the registration unchecked at exit 0.
  const hooksDir = join(root, "hooks");
  const hooksPath = join(root, "hooks/hooks.json");
  if (existsSync(hooksDir) && !existsSync(hooksPath)) {
    fail(
      "hooks/hooks.json is missing but hooks/ ships a component — a hook script with no registration " +
        "never fires; deleting or renaming this file is the exact disarm this check exists to catch"
    );
  } else if (existsSync(hooksPath)) {
    let hooksDoc, hooksParsed = true;
    try {
      hooksDoc = JSON.parse(readFileSync(hooksPath, "utf8"));
    } catch (e) {
      hooksParsed = false;
      fail(`hooks/hooks.json: not valid JSON — ${e.message}`);
    }
    const events = hooksDoc?.hooks;
    if (hooksParsed && (typeof events !== "object" || events === null || Array.isArray(events)))
      fail(`hooks/hooks.json: must carry a "hooks" object keyed by event name, got ${JSON.stringify(events)}`);
    else if (hooksParsed)
      for (const [event, entries] of Object.entries(events)) {
        if (!Array.isArray(entries) || entries.length === 0) {
          fail(`hooks/hooks.json: ${event} must be a non-empty array of matcher entries`);
          continue;
        }
        for (const [i, entry] of entries.entries()) {
          const at = `hooks/hooks.json: ${event}[${i}]`;
          if (typeof entry?.matcher !== "string" || entry.matcher.trim() === "")
            fail(`${at}: matcher must be a non-empty string — an empty matcher registers a hook that never fires`);
          // "*" is a literal the harness documents specially, meaning "match every tool" — it is
          // not regex syntax (`new RegExp("*")` throws "Nothing to repeat"), so compiling it here
          // would reject the documented match-all matcher with a message asserting the hook can
          // never fire, when in fact it fires on everything. Every other matcher is still required
          // to compile as a regular expression.
          else if (entry.matcher !== "*") {
            try {
              new RegExp(entry.matcher);
            } catch (e) {
              fail(
                `${at}: matcher "${entry.matcher}" is not a valid regular expression (${e.message}) — the ` +
                  "registered hook can never fire"
              );
            }
          }
          const commands = Array.isArray(entry?.hooks) ? entry.hooks : null;
          if (!commands || commands.length === 0) {
            fail(`${at}: hooks must be a non-empty array of commands`);
            continue;
          }
          for (const [j, h] of commands.entries()) {
            if (h?.type !== "command")
              fail(
                `${at}.hooks[${j}]: type must be "command" — dropping or misspelling it means this entry is not ` +
                  "a command hook, so the harness never registers it and the guard is unregistered"
              );
            const cmd = typeof h?.command === "string" ? h.command : "";
            if (cmd.trim() === "") {
              fail(`${at}.hooks[${j}]: command must be a non-empty string`);
              continue;
            }
            const paths = [...cmd.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)];
            if (!paths.length) {
              fail(
                `${at}.hooks[${j}]: command names no \${CLAUDE_PLUGIN_ROOT}/<path> — a hook runs with the user's ` +
                  `repo as cwd, so a repo-relative command resolves to nothing and the hook silently never fires`
              );
              continue;
            }
            for (const [, raw] of paths) {
              const target = raw.replace(/[.,;:]+$/, "");
              const abs = join(root, target);
              if (!existsSync(abs) || !statSync(abs).isFile())
                fail(`${at}.hooks[${j}]: \${CLAUDE_PLUGIN_ROOT}/${target} names no file in the plugin`);
            }
          }
        }
      }
  }

  lessonsTrackingErrors(process.cwd()).forEach(fail);

  if (errors.length) { console.error("VALIDATION FAILED:\n" + errors.map((e) => " - " + e).join("\n")); process.exit(1); }
  console.log("validate: ok");
}
