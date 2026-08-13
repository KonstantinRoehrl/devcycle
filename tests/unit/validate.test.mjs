// Cross-reference checks in scripts/validate.mjs, exercised against throwaway
// plugin trees. Every test starts from a green fixture and breaks one thing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { makePluginFixture as makeBaseFixture, writeInto, runValidate, FIXTURE_PLAYBOOK_HEAD } from "./helpers.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// The routing table check 6 reads. `cycle` is confirm-first, so the table has to
// name its justification; helpers.mjs's base table predates that arm and is owned
// elsewhere, so every fixture tree gets the table from here instead.
const ROUTING_PATH = "docs/routing.md";
const ROUTING_HEAD = "# Routing\n\n| intent | entry point | consequence | model-invocable |\n| --- | --- | --- | --- |\n";
const CYCLE_ROW = "| run the pipeline | `cycle` | confirm-first | yes |\n";
const CYCLE_JUSTIFICATION =
  "\n**`cycle`'s justification.** Model-invocable by deliberate exception so a wrapper can drive the\n" +
  "pipeline programmatically: it creates no branch and makes no commit before its first user\n" +
  "confirmation, and it surfaces a state-file collision rather than overwriting one.\n";
const routing = (...rows) => ROUTING_HEAD + CYCLE_ROW + rows.join("") + CYCLE_JUSTIFICATION;

const makePluginFixture = () => {
  const dir = makeBaseFixture();
  writeInto(dir, ROUTING_PATH, routing());
  return dir;
};

// Replaces the fixture playbook's body, keeping the fixture head. Playbooks
// have no frontmatter.
const playbook = (dir, body) => writeInto(dir, "playbooks/demoing-things.md", FIXTURE_PLAYBOOK_HEAD + "\n" + body);

// The stage enum lives in commands/cycle.md; checks that consult it need it present.
const withStageEnum = (dir) =>
  writeInto(
    dir,
    "commands/cycle.md",
    "---\ndescription: Fixture command.\n---\n\n" +
      "```markdown\n# devcycle state\n" +
      "- stage: <scoping|planning|execution|finish|done>  (the stage to RESUME at)\n" +
      "```\n"
  );

const ok = (res) => assert.equal(res.status, 0, `expected pass, got:\n${res.stdout}${res.stderr}`);
const failsWith = (res, ...patterns) => {
  assert.equal(res.status, 1, `expected failure, got:\n${res.stdout}${res.stderr}`);
  for (const p of patterns) assert.match(res.stderr, p);
};

// --- check 1: backticked stage references against cycle.md's enum ---

test("stage check: backticked stages in the enum pass, and unbackticked prose is not a reference", () => {
  const dir = makePluginFixture();
  withStageEnum(dir);
  playbook(
    dir,
    "Write `stage: planning`, then `stage: done`.\n\n" +
      "The `stage:` line records the stage to resume at.\n\n" +
      "The pipeline's last stage: resolve the effective git policy.\n"
  );
  ok(runValidate(dir));
});

test("stage check: a backticked stage outside the enum fails, naming file and token", () => {
  const dir = makePluginFixture();
  withStageEnum(dir);
  playbook(dir, "Write `stage: reviewing` and continue.\n");
  failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /reviewing/);
});

// --- check 2: ${user_config.X} against plugin.json's userConfig ---

test("user_config check: a declared knob passes, and the literal ${user_config.KEY} placeholder is exempt", () => {
  const dir = makePluginFixture();
  playbook(dir, "Resolve `${user_config.profile}`. The convention is `${user_config.KEY}`.\n");
  ok(runValidate(dir));
});

test("user_config check: an undeclared knob fails, naming file and token", () => {
  const dir = makePluginFixture();
  playbook(dir, "Resolve `${user_config.reviewDepth}` before reviewing.\n");
  failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /reviewDepth/);
});

test("user_config check: an unreadable knob list fails loudly rather than skipping the check", () => {
  // Missing entirely, and present but not an object. Either way the check cannot
  // run, and a check that cannot run must not report success.
  for (const userConfig of [undefined, "not-an-object", []]) {
    const dir = makePluginFixture();
    writeInto(
      dir,
      ".claude-plugin/plugin.json",
      JSON.stringify(
        {
          name: "devcycle",
          version: "0.0.1",
          description: "Fixture plugin.",
          license: "MIT",
          dependencies: [],
          ...(userConfig === undefined ? {} : { userConfig }),
        },
        null,
        2
      ) + "\n"
    );
    playbook(dir, "Resolve `${user_config.profile}` before planning.\n");
    failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /profile/, /unverifiable/);
  }
});

// --- check 3: devcycle:<name> against agents and commands ---

test("devcycle: reference check: names resolving to an agent or a command all pass", () => {
  const dir = makePluginFixture();
  withStageEnum(dir);
  writeInto(dir, "agents/task-reviewer.md", "---\nname: task-reviewer\n---\n\nReviewer.\n");
  playbook(dir, "Dispatch `devcycle:task-reviewer`, resume via `/devcycle:cycle`.\n");
  ok(runValidate(dir));
});

test("devcycle: reference check: a name resolving to nothing fails, naming file and token", () => {
  const dir = makePluginFixture();
  playbook(dir, "Invoke `devcycle:ghost-stage` to finish.\n");
  failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /devcycle:ghost-stage/);
});

test("devcycle: reference check: a name resolving to a playbook fails, asking for the path form", () => {
  // Playbooks are addressed by path, never by a devcycle: id — a devcycle:<playbook>
  // is someone invoking stage logic as if it were a user-facing skill.
  const dir = makePluginFixture();
  writeInto(dir, "playbooks/padding-things.md", "# Padding things\n");
  playbook(dir, "Invoke `devcycle:padding-things` to finish.\n");
  failsWith(
    runValidate(dir),
    /playbooks\/demoing-things\.md/,
    /devcycle:padding-things names a playbook/,
    /\$\{CLAUDE_PLUGIN_ROOT\}\/playbooks\/padding-things\.md/
  );
});

// --- check 4: ${CLAUDE_PLUGIN_ROOT}/<path> against the tree ---

test("plugin-root check: a path that exists passes", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/handoff.md", "# Handoff\n\nThe block shape.\n");
  playbook(dir, "Read `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and follow it.\n");
  ok(runValidate(dir));
});

test("plugin-root check: a path that does not exist fails, naming file and token", () => {
  const dir = makePluginFixture();
  playbook(dir, "Read `${CLAUDE_PLUGIN_ROOT}/references/nowhere.md` and follow it.\n");
  failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /references\/nowhere\.md/);
});

// --- check 5: a playbook emitting a handoff block must name the reference ---

test("handoff check: a playbook emitting a handoff block that names references/handoff.md passes", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/handoff.md", "# Handoff\n\nThe block shape.\n");
  playbook(dir, "Read `${CLAUDE_PLUGIN_ROOT}/references/handoff.md` and follow it.\n\n## Handoff\n\nEmit the block.\n");
  ok(runValidate(dir));
});

test("handoff check: a playbook emitting a handoff block without the reference fails, naming file and token", () => {
  const dir = makePluginFixture();
  playbook(dir, "## Handoff\n\nEmit whatever block you like.\n");
  failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /references\/handoff\.md/);
});

// The tree spells the same act three ways; the check has to recognise all three.
// Sources: playbooks/scoping-the-request.md ("## Output and handoff"),
// playbooks/taking-the-fast-path.md ("6. **Handoff.**"),
// playbooks/reviewing-code.md ("emit the handoff block per …").
for (const [form, body] of [
  ["a heading that names the handoff among other words", "## Output and handoff\n\nEmit the block.\n"],
  ["a bold run-in step label", "6. **Handoff.** Emit this stage's block with the fields below.\n"],
  ["an inline instruction to emit the block", "Close the state file, then emit the handoff block with the paths.\n"],
])
  test(`handoff check: ${form} without the reference fails, naming file and token`, () => {
    const dir = makePluginFixture();
    playbook(dir, body);
    failsWith(runValidate(dir), /playbooks\/demoing-things\.md/, /references\/handoff\.md/);
  });

test("handoff check: a playbook that states it emits no handoff block is not an emitter", () => {
  // playbooks/learning-from-sessions.md, profiling-sessions.md and onboarding-a-repo.md
  // all say this and reference nothing; a matcher on the bare phrase would fail them.
  const dir = makePluginFixture();
  playbook(dir, "This run starts no cycle and emits no handoff block.\n\nNeither mode emits a handoff block.\n");
  ok(runValidate(dir));
});

// --- check 6: commands against the routing table in docs/routing.md ---

test("routing check: a command missing from the routing table fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "commands/verify.md", '---\ndescription: "v"\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /verify\.md.*routing table/);
});

test("routing check: a side-effectful command without the guard fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, ROUTING_PATH, routing("| set up a repo | `onboard` | side-effectful | no |\n"));
  writeInto(dir, "commands/onboard.md", '---\ndescription: "o"\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /onboard\.md.*disable-model-invocation/);
});

test("routing check: a read-only command carrying the guard fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, ROUTING_PATH, routing("| review code | `review` | read-only | yes |\n"));
  writeInto(dir, "commands/review.md", '---\ndescription: "r"\ndisable-model-invocation: true\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /review\.md.*forbids disable-model-invocation/);
});

// The third clause of the consequence contract: `confirm-first` is the deliberate
// exception class, and every member names its justification inline.

test("routing check: a confirm-first command whose justification is missing fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, ROUTING_PATH, ROUTING_HEAD + CYCLE_ROW);
  failsWith(runValidate(dir), /docs\/routing\.md/, /cycle.*confirm-first.*justification/);
});

test("routing check: a confirm-first justification that is only a label fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, ROUTING_PATH, ROUTING_HEAD + CYCLE_ROW + "\n**`cycle`'s justification.**\n");
  failsWith(runValidate(dir), /docs\/routing\.md/, /cycle.*confirm-first.*justification/);
});

test("routing check: a justification naming another command does not cover this one", () => {
  const dir = makePluginFixture();
  writeInto(
    dir,
    ROUTING_PATH,
    ROUTING_HEAD +
      CYCLE_ROW +
      "| plan a change | `sketch` | confirm-first | yes |\n" +
      CYCLE_JUSTIFICATION
  );
  writeInto(dir, "commands/sketch.md", '---\ndescription: "s"\n---\n');
  failsWith(runValidate(dir), /docs\/routing\.md/, /sketch.*confirm-first.*justification/);
});

test("routing check: a command listed twice in the routing table fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, ROUTING_PATH, ROUTING_HEAD + CYCLE_ROW + CYCLE_ROW + CYCLE_JUSTIFICATION);
  failsWith(runValidate(dir), /docs\/routing\.md.*cycle appears more than once/);
});

test("routing check: a routing row naming no command fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, ROUTING_PATH, routing("| do the thing | `ghost` | read-only | yes |\n"));
  failsWith(runValidate(dir), /docs\/routing\.md.*"ghost" names no command/);
});

// --- check 7: skills/ is not part of the surface any more ---

test("structure check: a resurrected skills/ directory fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "skills/x/SKILL.md", "---\nname: x\ndescription: Use when x is needed.\n---\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /skills\/.*no longer part of the surface/);
});

// --- check 8: commands are verbs, playbooks are gerunds ---

test("naming check: a command named as a gerund fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "commands/reviewing.md", '---\ndescription: "r"\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /reviewing\.md.*verbs, not gerunds/);
});

test("naming check: a playbook that is not a gerund fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "playbooks/fast-path.md", "# Fast path\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /fast-path\.md.*gerunds/);
});

// --- check 9: line budgets, per file and across the surface ---

test("budget check: a command over 100 lines fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "commands/cycle.md", '---\ndescription: "c"\n---\n' + "x\n".repeat(120));
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /commands\/cycle\.md: \d+ lines > 104/);
});

// Pads the surface with `count` gerund-named playbooks of 100 lines each — each
// one under the 150-line per-file ceiling, so only the total arm can fire.
// Each padding playbook also gets a context-budget entry, generous enough never to fire:
// check 15 requires every playbook to declare one, and these exist to move the line total.
const padSurface = (dir, count) => {
  const context = { "playbooks/demoing-things.md": 999999 };
  for (let i = 0; i < count; i++) {
    writeInto(dir, `playbooks/padding-${i}.md`, "x\n".repeat(100));
    context[`playbooks/padding-${i}.md`] = 999999;
  }
  writeInto(dir, CONTEXT_PATH, JSON.stringify(context, null, 2) + "\n");
};

test("budget check: a surface over 3500 lines in total fails", () => {
  const dir = makePluginFixture();
  padSurface(dir, 40); // 4000 lines
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /runtime surface \d+ lines > baseline 3620/);
  assert.doesNotMatch(stderr, /lines > 154/); // the total arm fired, not the per-file arm
});

test("budget check: the same surface under 3500 lines in total passes", () => {
  const dir = makePluginFixture();
  padSurface(dir, 30); // 3000 lines
  ok(runValidate(dir));
});

test("budget check: a playbook over 150 lines fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "playbooks/padding-things.md", "x\n".repeat(160));
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /playbooks\/padding-things\.md: \d+ lines > 154/);
  assert.doesNotMatch(stderr, /runtime surface/); // the per-file arm fired, not the total arm
});

// --- check 10: no agent pins a model ---

test("agent check: a model: pin in agent frontmatter fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "agents/implementer.md", "---\nname: implementer\nmodel: sonnet\n---\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /agents\/implementer\.md.*must not set model:/);
});

// --- check 11: every reference has a consumer ---

test("reference check: a reference with no consumer fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/orphan.md", "# Orphan\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /orphan\.md.*no consumer/);
});

test("reference check: a reference that mentions only itself is still an orphan", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/orphan.md", "# Orphan\n\nSee references/orphan.md for the shape.\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /orphan\.md.*no consumer/);
});

test("reference check: a reference loaded only by a script has a consumer", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/orphan.md", "# Orphan\n");
  writeInto(dir, "scripts/uses-it.mjs", 'readFileSync(join(root, "references/orphan.md"), "utf8");\n');
  ok(runValidate(dir));
});

// --- the description budget reads commands, not whatever else lands in the directory ---

test("description budget: a .DS_Store beside the commands is not read as a command", () => {
  const dir = makePluginFixture();
  writeInto(dir, "commands/.DS_Store", "\x00\x00\x00\x01Bud1\x00\x00\x00\x00");
  ok(runValidate(dir));
});

// --- check 12: the state-file shape, resume.md declaring it and a fixture carrying it ---

const STATE_FIELDS = ["stage", "root", "branch", "request", "plan", "ledger", "updated"];

// references/resume.md owns the shape. A script consumer keeps check 11 satisfied.
const declareState = (dir, fields = STATE_FIELDS) => {
  writeInto(
    dir,
    "references/resume.md",
    "# Resuming a run\n\nThe state file's shape:\n\n```markdown\n# devcycle state\n" +
      fields.map((f) => `- ${f}: <value>\n`).join("") +
      "```\n"
  );
  writeInto(dir, "scripts/reads-state.mjs", 'readFileSync(join(root, "references/resume.md"), "utf8");\n');
};
const stateFixture = (dir, lines) =>
  writeInto(dir, "tests/fixtures/golden-path/state.md", "# devcycle state\n" + lines.join("\n") + "\n");
const allFields = (fields = STATE_FIELDS) => fields.map((f) => `- ${f}: something`);

test("state-file check: a fixture carrying every declared field passes", () => {
  const dir = makePluginFixture();
  declareState(dir);
  stateFixture(dir, allFields());
  ok(runValidate(dir));
});

test("state-file check: a fixture missing a declared field fails, naming file and field", () => {
  const dir = makePluginFixture();
  declareState(dir);
  stateFixture(dir, allFields().filter((l) => !l.startsWith("- plan:")));
  failsWith(runValidate(dir), /tests\/fixtures\/golden-path\/state\.md/, /plan/);
});

test("state-file check: a declared field left blank is missing", () => {
  const dir = makePluginFixture();
  declareState(dir);
  stateFixture(dir, allFields().map((l) => (l.startsWith("- plan:") ? "- plan:" : l)));
  failsWith(runValidate(dir), /tests\/fixtures\/golden-path\/state\.md/, /plan/);
});

test("state-file check: a fixture may carry a field the shape does not declare", () => {
  // references/resume.md: "A stage may add evidence rows of its own for states this
  // table does not name" — an extra row is not drift.
  const dir = makePluginFixture();
  declareState(dir);
  stateFixture(dir, [...allFields(), "- sweepCommit: abc1234"]);
  ok(runValidate(dir));
});

test("state-file check: a declared shape with no fixture carrying it fails", () => {
  const dir = makePluginFixture();
  declareState(dir);
  writeInto(dir, "tests/fixtures/golden-path/ledger.md", "# ledger\n");
  failsWith(runValidate(dir), /state file/, /no fixture/);
});

test("state-file check: a fixture whose shape is declared nowhere fails as unverifiable", () => {
  const dir = makePluginFixture();
  stateFixture(dir, allFields());
  failsWith(runValidate(dir), /tests\/fixtures\/golden-path\/state\.md/, /unverifiable/);
});

test("state-file check: a blank line inside the template does not drop the fields after it", () => {
  // The extraction used to read a run of consecutive `- ` lines, which stops at the first
  // line that is not a field: one blank line took it from every field to the few above the
  // gap, and the check then passed while the fixture had genuinely drifted.
  const dir = makePluginFixture();
  declareState(dir);
  const resume = join(dir, "references/resume.md");
  writeFileSync(resume, readFileSync(resume, "utf8").replace("- plan:", "\n- plan:"));
  stateFixture(dir, allFields().filter((l) => !l.startsWith("- updated:")));
  failsWith(runValidate(dir), /state file drifted/, /updated/);
});

test("state-file check: two declared shapes fail rather than the first one silently winning", () => {
  const dir = makePluginFixture();
  declareState(dir);
  stateFixture(dir, allFields());
  const resume = join(dir, "references/resume.md");
  writeFileSync(resume, readFileSync(resume, "utf8") + "\n```markdown\n# devcycle state\n- stage: <stale>\n```\n");
  failsWith(runValidate(dir), /references\/resume\.md/, /declared exactly once/);
});

test("state-file check: a resume.md that declares no template fails instead of going quiet", () => {
  // Renaming the header on both sides while the checker's constant stays stale used to empty
  // the template AND the fixture list at once, so every branch went silent.
  const dir = makePluginFixture();
  declareState(dir);
  const resume = join(dir, "references/resume.md");
  writeFileSync(resume, readFileSync(resume, "utf8").replace("# devcycle state", "# devcycle run state"));
  stateFixture(dir, allFields());
  failsWith(runValidate(dir), /references\/resume\.md/, /undeclared/);
});

// --- check 13: the run-record schema and its golden fixture ---

test("check 13 accepts the golden run record against its schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-runrecord-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test("check 13 fails when the golden record violates the schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-runrecord-bad-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  writeFileSync(
    join(dir, "tests/fixtures/run-record.golden.jsonl"),
    JSON.stringify({ kind: "dispatch", runId: "r1", modelSource: "guessed" }) + "\n"
  );
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /run-record\.golden\.jsonl/);
});

test("check 13 fails when the schema declares a kind the golden record never exercises", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate-runrecord-unexercised-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const schema = JSON.parse(
    readFileSync(join(dir, "tests/fixtures/run-record.schema.json"), "utf8")
  );
  schema.oneOf.push({
    type: "object",
    properties: { kind: { const: "phantom" }, runId: { type: "string" } },
    required: ["kind", "runId"],
    additionalProperties: false,
  });
  writeFileSync(
    join(dir, "tests/fixtures/run-record.schema.json"),
    JSON.stringify(schema, null, 2) + "\n"
  );
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /phantom/);
});

// check 13's "missing required field" arm used `!(req in obj)` alone, which JSON.parse can
// never distinguish from "present as JS-undefined" — that shape only exists in-memory (e.g.
// run-record.mjs's own writeLine() building `{ pluginVersion: flags["plugin-version"] }` when
// the flag is absent), and collapses to a truly-absent key the instant it round-trips through
// JSON.stringify (which drops undefined-valued keys) and back through JSON.parse from disk —
// the only way check 13 ever sees a golden line. Confirmed live (see task 37's report): this
// reproduction is already rejected by the pre-fix `!(req in obj)` check, so it is not a
// red-green pair for the added `|| obj[req] === undefined` arm — kept as a regression test for
// the missing-field message, with the finding disclosed rather than a fabricated red.
test("check 13 rejects a golden line missing a required field via JSON.stringify's undefined-drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate13-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const golden = readFileSync(join(dir, "tests/fixtures/run-record.golden.jsonl"), "utf8").trim().split("\n");
  const runLine = JSON.parse(golden[0]);
  const broken = [JSON.stringify({ ...runLine, pluginVersion: undefined }), ...golden.slice(1)].join("\n") + "\n";
  writeFileSync(join(dir, "tests/fixtures/run-record.golden.jsonl"), broken);
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], { cwd: dir, encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /pluginVersion/);
});

test("check 13 rejects a golden line whose integer field violates the schema's minimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate13b-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const golden = readFileSync(join(dir, "tests/fixtures/run-record.golden.jsonl"), "utf8").trim().split("\n");
  const verdictLine = JSON.parse(golden.find((l) => JSON.parse(l).kind === "verdict"));
  verdictLine.round = -1; // schema declares "round": { "type": "integer", "minimum": 1 }
  const lines = golden.map((l) => (JSON.parse(l).kind === "verdict" ? JSON.stringify(verdictLine) : l));
  writeFileSync(join(dir, "tests/fixtures/run-record.golden.jsonl"), lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], { cwd: dir, encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /round/);
});

test("check 13 fails when a declared optional schema field is never exercised by the golden fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate13c-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const schemaPath = join(dir, "tests/fixtures/run-record.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  // Add a field nothing in the (post-Task-36) golden fixture carries.
  const dispatchSub = schema.oneOf.find((s) => s.properties?.kind?.const === "dispatch");
  dispatchSub.properties.neverExercised = { type: "string" };
  writeFileSync(schemaPath, JSON.stringify(schema));
  // golden.jsonl copied unchanged — it never mentions "neverExercised".
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], { cwd: dir, encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /neverExercised/);
});

test("check 13 rule 2 fails when the schema declares a field no surface file's run-record.mjs append instruction names", () => {
  const dir = mkdtempSync(join(tmpdir(), "validate13d-"));
  cpSync(REPO_ROOT, dir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const schemaPath = join(dir, "tests/fixtures/run-record.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  // Rule 2 is scoped to "run"/"session" kinds only (2026-08-11 decision, docs/DECISIONS.md) —
  // "session" carries the fewest fields, so it is the simplest kind to inject an orphan into.
  const sessionSub = schema.oneOf.find((s) => s.properties?.kind?.const === "session");
  sessionSub.properties.orphanField = { type: "string" };
  sessionSub.required.push("orphanField");
  writeFileSync(schemaPath, JSON.stringify(schema));
  // Satisfy the required-field check so only rule 2 (no surface instruction names
  // --orphanField) can fail this — the real commands/playbooks/agents/references tree, copied
  // unmodified above, names neither "orphanField" nor "--orphanField" anywhere.
  const goldenPath = join(dir, "tests/fixtures/run-record.golden.jsonl");
  const lines = readFileSync(goldenPath, "utf8").trim().split("\n").map((l) => {
    const o = JSON.parse(l);
    if (o.kind === "session") o.orphanField = "x";
    return JSON.stringify(o);
  });
  writeFileSync(goldenPath, lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [join(dir, "scripts/validate.mjs")], { cwd: dir, encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /orphanField/);
});

test("check 13 rule 2 fails when no surface instruction names --knob for the knobs field, and passes once commands/cycle.md does", () => {
  // Failing half: a surface stripped of every --knob mention must not be waved through.
  const failDir = mkdtempSync(join(tmpdir(), "validate13e-fail-"));
  cpSync(REPO_ROOT, failDir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const cyclePath = join(failDir, "commands/cycle.md");
  writeFileSync(cyclePath, readFileSync(cyclePath, "utf8").replaceAll("--knob ", ""));
  const rFail = spawnSync(process.execPath, [join(failDir, "scripts/validate.mjs")], { cwd: failDir, encoding: "utf8" });
  assert.notStrictEqual(rFail.status, 0);
  assert.match(rFail.stdout + rFail.stderr, /knobs/);

  // Passing half: the real, unmodified tree wires --knob into commands/cycle.md's mint command.
  const passDir = mkdtempSync(join(tmpdir(), "validate13e-pass-"));
  cpSync(REPO_ROOT, passDir, { recursive: true, filter: (s) => !s.includes("/.git/") });
  const rPass = spawnSync(process.execPath, [join(passDir, "scripts/validate.mjs")], { cwd: passDir, encoding: "utf8" });
  assert.strictEqual(rPass.status, 0, rPass.stdout + rPass.stderr);
});

// --- check 14: the culprit vocabulary is well-formed ---

const culprits = (dir, entries) => writeInto(dir, "references/culprits.json", JSON.stringify(entries));

test("check 14 fails on an unsorted culprits.json", () => {
  const dir = makePluginFixture();
  culprits(dir, [
    { slug: "zebra-pattern", kind: "friction", phase: ["execution"], desc: "z", since: "0.13.0" },
    { slug: "alpha-pattern", kind: "friction", phase: ["execution"], desc: "a", since: "0.13.0" },
  ]);
  failsWith(runValidate(dir), /must be sorted by slug/);
});

test("check 14 fails on a kind outside the enum and a phase outside the stage enum", () => {
  const dir = makePluginFixture();
  culprits(dir, [
    { slug: "alpha-pattern", kind: "not-a-kind", phase: ["not-a-stage"], desc: "a", since: "0.13.0" },
  ]);
  failsWith(
    runValidate(dir),
    /kind "not-a-kind" is not one of/,
    /phase "not-a-stage" is not in commands\/cycle\.md's stage enum/
  );
});

test("check 14 fails on a duplicate slug", () => {
  const dir = makePluginFixture();
  culprits(dir, [
    { slug: "alpha-pattern", kind: "friction", phase: ["execution"], desc: "a", since: "0.13.0" },
    { slug: "alpha-pattern", kind: "win", phase: ["execution"], desc: "b", since: "0.13.0" },
  ]);
  failsWith(runValidate(dir), /duplicate slug\(s\) alpha-pattern/);
});

test("check 14 fails when resolved-in precedes since", () => {
  const dir = makePluginFixture();
  culprits(dir, [
    { slug: "alpha-pattern", kind: "friction", phase: ["execution"], desc: "a",
      since: "0.14.0", "resolved-in": "0.13.0" },
  ]);
  failsWith(runValidate(dir), /resolved-in 0\.13\.0 precedes since 0\.14\.0/);
});

test("check 14 fails when culprits.json is missing entirely", () => {
  const dir = makePluginFixture();
  rmSync(join(dir, "references/culprits.json"), { force: true });
  failsWith(runValidate(dir), /references\/culprits\.json: missing/);
});

test("check 14 fails when culprits.json's whole content is the JSON literal null, not silently passing", () => {
  const dir = makePluginFixture();
  // `null` is valid JSON and the parse-failure sentinel used to be `null` itself, so a file
  // containing exactly this bypassed both the array guard and the per-entry loop.
  writeInto(dir, "references/culprits.json", "null");
  failsWith(runValidate(dir), /references\/culprits\.json: must be an array/);
});

test("check 14 fails on a null entry instead of crashing on the \"slug\" in e check", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/culprits.json", JSON.stringify([null]));
  failsWith(runValidate(dir), /VALIDATION FAILED/, /references\/culprits\.json\[0\]/);
});

test("check 14 fails on a bare-string entry instead of crashing on the \"slug\" in e check", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/culprits.json", JSON.stringify(["x"]));
  failsWith(runValidate(dir), /VALIDATION FAILED/, /references\/culprits\.json\[0\]/);
});

test("check 14 passes on the repo's own shipped vocabulary", () => {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/validate.mjs")],
    { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

// --- check 9: the line budgets are a committed baseline, not hardcoded constants ---

const BUDGET_PATH = "tests/fixtures/surface-budget.json";
const budget = (dir, over = {}) =>
  writeInto(dir, BUDGET_PATH, JSON.stringify({ surfaceTotal: 3620, commandMax: 104, playbookMax: 154, ...over }, null, 2) + "\n");

test("budget baseline: a missing baseline file fails", () => {
  const dir = makePluginFixture();
  rmSync(join(dir, BUDGET_PATH), { force: true });
  const { stderr } = runValidate(dir);
  assert.match(stderr, /surface-budget\.json/);
  assert.match(stderr, /baseline/);
});

test("budget baseline: surface growth past the baseline fails and names the overage", () => {
  const dir = makePluginFixture();
  budget(dir, { surfaceTotal: 1 });
  const { stderr } = runValidate(dir);
  assert.match(stderr, /runtime surface \d+ lines > baseline 1/);
  assert.match(stderr, /raise the baseline in this same commit/);
});

test("budget baseline: a baseline that admits the current surface passes", () => {
  const dir = makePluginFixture();
  budget(dir);
  assert.equal(runValidate(dir).status, 0);
});

test("budget baseline: a surface smaller than the baseline passes and the baseline is not rewritten", () => {
  const dir = makePluginFixture();
  budget(dir, { surfaceTotal: 9999 });
  assert.equal(runValidate(dir).status, 0);
  assert.match(readFileSync(join(dir, BUDGET_PATH), "utf8"), /"surfaceTotal": 9999/);
});

test("budget baseline: a command over commandMax fails against the baseline's value", () => {
  const dir = makePluginFixture();
  budget(dir, { commandMax: 2 });
  const { stderr } = runValidate(dir);
  assert.match(stderr, /commands\/cycle\.md: \d+ lines > 2/);
});

test("budget baseline: a playbook over playbookMax fails against the baseline's value", () => {
  const dir = makePluginFixture();
  budget(dir, { playbookMax: 1 });
  const { stderr } = runValidate(dir);
  assert.match(stderr, /playbooks\/demoing-things\.md: \d+ lines > 1/);
});

test("budget baseline: a non-integer baseline value fails rather than coercing", () => {
  const dir = makePluginFixture();
  writeInto(dir, BUDGET_PATH, JSON.stringify({ surfaceTotal: "3620", commandMax: 104, playbookMax: 154 }) + "\n");
  assert.match(runValidate(dir).stderr, /surfaceTotal.*integer/);
});

// A baseline file legally parses to `null`, so a `budgets === null` sentinel cannot tell a
// thrown parse from a file that simply says `null` — the same defect checks 14 and 18 already
// carry the `parsed` sentinel to close.
test("budget baseline: a baseline whose whole content is the JSON literal null fails rather than disabling the check", () => {
  const dir = makePluginFixture();
  writeInto(dir, BUDGET_PATH, "null\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1, `expected failure, got:\n${stderr}`);
  assert.match(stderr, /surface-budget\.json: must be a JSON object/);
});

test("budget baseline: a baseline that is not an object fails naming the shape, not a missing key", () => {
  const dir = makePluginFixture();
  writeInto(dir, BUDGET_PATH, "[]\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1, `expected failure, got:\n${stderr}`);
  assert.match(stderr, /surface-budget\.json: must be a JSON object/);
  assert.doesNotMatch(stderr, /TypeError/);
});

// --- check 15: each stage's transitive context cost against a committed baseline ---

const CONTEXT_PATH = "tests/fixtures/context-budget.json";

test("context budget: a playbook missing from the baseline fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, CONTEXT_PATH, JSON.stringify({}, null, 2) + "\n");
  const { stderr } = runValidate(dir);
  assert.match(stderr, /playbooks\/demoing-things\.md.*no entry in/);
});

test("context budget: a baseline whose whole content is the JSON literal null fails rather than disabling the check", () => {
  const dir = makePluginFixture();
  writeInto(dir, CONTEXT_PATH, "null\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1, `expected failure, got:\n${stderr}`);
  assert.match(stderr, /context-budget\.json: must be a JSON object/);
});

// The `in` operator throws on a primitive right-hand side, so an unguarded truthy non-object
// baseline crashed the validator before checks 17 and 18 could run at all.
test("context budget: a baseline that is not an object fails with a message rather than crashing", () => {
  const dir = makePluginFixture();
  writeInto(dir, CONTEXT_PATH, "5\n");
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1, `expected failure, got:\n${stderr}`);
  assert.match(stderr, /context-budget\.json: must be a JSON object/);
  assert.doesNotMatch(stderr, /TypeError|Cannot use 'in' operator/);
});

test("context budget: growth past a playbook's baseline fails and names both numbers", () => {
  const dir = makePluginFixture();
  writeInto(dir, CONTEXT_PATH, JSON.stringify({ "playbooks/demoing-things.md": 1 }, null, 2) + "\n");
  const { stderr } = runValidate(dir);
  assert.match(stderr, /playbooks\/demoing-things\.md: \d+ bytes > baseline 1/);
  assert.match(stderr, /raise the baseline in this same commit/);
});

test("context budget: a baseline entry for a playbook that no longer exists fails", () => {
  const dir = makePluginFixture();
  writeInto(
    dir,
    CONTEXT_PATH,
    JSON.stringify({ "playbooks/demoing-things.md": 999999, "playbooks/gone-away.md": 10 }, null, 2) + "\n"
  );
  assert.match(runValidate(dir).stderr, /playbooks\/gone-away\.md.*no such playbook/);
});

test("context budget: the total counts a cited reference, and counts it once when two cite each other", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/alpha.md", "# Alpha\n\nSee ${CLAUDE_PLUGIN_ROOT}/references/beta.md.\n");
  writeInto(dir, "references/beta.md", "# Beta\n\nSee ${CLAUDE_PLUGIN_ROOT}/references/alpha.md.\n");
  writeInto(
    dir,
    "playbooks/demoing-things.md",
    FIXTURE_PLAYBOOK_HEAD + "\nLoad ${CLAUDE_PLUGIN_ROOT}/references/alpha.md.\n"
  );
  // A cycle must terminate, and the two references must be counted once each, not repeatedly.
  const playbookBytes = Buffer.byteLength(readFileSync(join(dir, "playbooks/demoing-things.md"), "utf8"));
  const alphaBytes = Buffer.byteLength(readFileSync(join(dir, "references/alpha.md"), "utf8"));
  const betaBytes = Buffer.byteLength(readFileSync(join(dir, "references/beta.md"), "utf8"));
  writeInto(dir, CONTEXT_PATH, JSON.stringify({ "playbooks/demoing-things.md": playbookBytes + alphaBytes + betaBytes }, null, 2) + "\n");
  const res = runValidate(dir);
  assert.equal(res.status, 0, res.stderr);
});

test("context budget: one byte less than the transitive total fails, proving the closure is followed", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/alpha.md", "# Alpha\n\nA reference the playbook loads.\n");
  writeInto(
    dir,
    "playbooks/demoing-things.md",
    FIXTURE_PLAYBOOK_HEAD + "\nLoad ${CLAUDE_PLUGIN_ROOT}/references/alpha.md.\n"
  );
  const playbookBytes = Buffer.byteLength(readFileSync(join(dir, "playbooks/demoing-things.md"), "utf8"));
  writeInto(dir, CONTEXT_PATH, JSON.stringify({ "playbooks/demoing-things.md": playbookBytes }, null, 2) + "\n");
  assert.match(runValidate(dir).stderr, /playbooks\/demoing-things\.md: \d+ bytes > baseline/);
});

test("context budget: a missing baseline file fails", () => {
  const dir = makePluginFixture();
  rmSync(join(dir, CONTEXT_PATH), { force: true });
  assert.match(runValidate(dir).stderr, /context-budget\.json: missing/);
});

// --- check 4, revisited: citations outside references/ resolve too ---
// "Every ${CLAUDE_PLUGIN_ROOT} citation resolves" is check 4's job already, for every surface
// file and every path shape; a second walk over the same files with the same regex would only
// have reported each broken citation twice. The case check 4 had no test for is a citation
// that names something other than a reference, so that is what this adds.

test("plugin-root check: a citation to a script path resolves too", () => {
  const dir = makePluginFixture();
  writeInto(dir, "scripts/thing.mjs", "// fixture script\n");
  playbook(dir, "Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/thing.mjs`.\n");
  ok(runValidate(dir));
});

// --- check 17: the command count is a regression guard ---

test("command ceiling: an eighth command fails", () => {
  const dir = makePluginFixture();
  for (const name of ["one", "two", "three", "four", "five", "six", "seven"])
    writeInto(dir, `commands/${name}.md`, `---\ndescription: "Fixture command."\n---\n\n# /devcycle:${name}\n`);
  const { stderr } = runValidate(dir);
  assert.match(stderr, /8 commands > 7/);
  assert.match(stderr, /surface decision/);
});

// --- check 18: the model-tier table is well-formed ---

const TIERS_PATH = "references/model-tiers.json";
const tiers = (dir, value) => writeInto(dir, TIERS_PATH, JSON.stringify(value, null, 2) + "\n");
const withContext = (dir) => writeInto(dir, CONTEXT_PATH, JSON.stringify({ "playbooks/demoing-things.md": 999999 }, null, 2) + "\n");

test("model tiers: a missing table fails", () => {
  const dir = makePluginFixture();
  rmSync(join(dir, TIERS_PATH));
  assert.match(runValidate(dir).stderr, /model-tiers\.json: missing/);
});

test("model tiers: a table that is JSON null fails instead of passing silently", () => {
  const dir = makePluginFixture();
  withContext(dir);
  tiers(dir, null);
  assert.match(runValidate(dir).stderr, /model-tiers\.json: must be an array/);
});

test("model tiers: non-ascending ranks fail", () => {
  const dir = makePluginFixture();
  withContext(dir);
  tiers(dir, [
    { family: "sonnet", rank: 2, match: "sonnet" },
    { family: "haiku", rank: 1, match: "haiku" },
  ]);
  assert.match(runValidate(dir).stderr, /ranks must ascend/);
});

test("model tiers: duplicate ranks fail", () => {
  const dir = makePluginFixture();
  withContext(dir);
  tiers(dir, [
    { family: "haiku", rank: 1, match: "haiku" },
    { family: "sonnet", rank: 1, match: "sonnet" },
  ]);
  assert.match(runValidate(dir).stderr, /ranks must ascend/);
});

test("model tiers: a match that is not a valid regular expression fails", () => {
  const dir = makePluginFixture();
  withContext(dir);
  tiers(dir, [{ family: "haiku", rank: 1, match: "haiku(" }]);
  assert.match(runValidate(dir).stderr, /match .* is not a valid regular expression/);
});

test("model tiers: a duplicate family fails", () => {
  const dir = makePluginFixture();
  withContext(dir);
  tiers(dir, [
    { family: "haiku", rank: 1, match: "haiku" },
    { family: "haiku", rank: 2, match: "haiku-2" },
  ]);
  assert.match(runValidate(dir).stderr, /duplicate family/);
});

test("model tiers: a table that is not valid JSON fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, TIERS_PATH, "[{ family: haiku }]\n");
  assert.match(runValidate(dir).stderr, /model-tiers\.json: not valid JSON/);
});

test("model tiers: an entry with no family fails", () => {
  const dir = makePluginFixture();
  tiers(dir, [{ rank: 1, match: "haiku" }]);
  assert.match(runValidate(dir).stderr, /model-tiers\.json\[0\]: family must be a non-empty string, got undefined/);
});

test("model tiers: a non-integer rank fails rather than coercing", () => {
  const dir = makePluginFixture();
  tiers(dir, [{ family: "haiku", rank: "1", match: "haiku" }]);
  assert.match(runValidate(dir).stderr, /model-tiers\.json\[0\]: rank must be an integer, got "1"/);
});

test("model tiers: an empty match fails", () => {
  const dir = makePluginFixture();
  tiers(dir, [{ family: "haiku", rank: 1, match: "" }]);
  assert.match(runValidate(dir).stderr, /model-tiers\.json\[0\]: match must be a non-empty string, got ""/);
});

test("model tiers: an empty table fails rather than ranking nothing", () => {
  const dir = makePluginFixture();
  tiers(dir, []);
  const { stderr } = runValidate(dir);
  assert.match(stderr, /model-tiers\.json: 0 entries, at least 1 required/);
  assert.match(stderr, /session tier/);
});

test("model tiers: a well-formed table passes", () => {
  const dir = makePluginFixture();
  withContext(dir);
  tiers(dir, [
    { family: "haiku", rank: 1, match: "haiku" },
    { family: "sonnet", rank: 2, match: "sonnet" },
  ]);
  assert.equal(runValidate(dir).status, 0, runValidate(dir).stderr);
});
