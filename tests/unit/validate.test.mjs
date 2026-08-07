// Cross-reference checks in scripts/validate.mjs, exercised against throwaway
// plugin trees. Every test starts from a green fixture and breaks one thing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { makePluginFixture as makeBaseFixture, writeInto, runValidate, FIXTURE_PLAYBOOK_HEAD } from "./helpers.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// The routing table check 6 reads. `cycle` is confirm-first, so the table has to
// name its justification; helpers.mjs's base table predates that arm and is owned
// elsewhere, so every fixture tree gets the table from here instead.
const ROUTING_HEAD = "# Routing\n\n| intent | entry point | consequence | model-invocable |\n| --- | --- | --- | --- |\n";
const CYCLE_ROW = "| run the pipeline | `cycle` | confirm-first | yes |\n";
const CYCLE_JUSTIFICATION =
  "\n**`cycle`'s justification.** Model-invocable by deliberate exception so a wrapper can drive the\n" +
  "pipeline programmatically: it creates no branch and makes no commit before its first user\n" +
  "confirmation, and it surfaces a state-file collision rather than overwriting one.\n";
const routing = (...rows) => ROUTING_HEAD + CYCLE_ROW + rows.join("") + CYCLE_JUSTIFICATION;

const makePluginFixture = () => {
  const dir = makeBaseFixture();
  writeInto(dir, "references/routing.md", routing());
  return dir;
};

// Replaces the fixture playbook's body, keeping the head that consumes
// references/routing.md. Playbooks have no frontmatter.
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

// --- check 6: commands against the routing table in references/routing.md ---

test("routing check: a command missing from the routing table fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "commands/verify.md", '---\ndescription: "v"\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /verify\.md.*routing table/);
});

test("routing check: a side-effectful command without the guard fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/routing.md", routing("| set up a repo | `onboard` | side-effectful | no |\n"));
  writeInto(dir, "commands/onboard.md", '---\ndescription: "o"\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /onboard\.md.*disable-model-invocation/);
});

test("routing check: a read-only command carrying the guard fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/routing.md", routing("| review code | `review` | read-only | yes |\n"));
  writeInto(dir, "commands/review.md", '---\ndescription: "r"\ndisable-model-invocation: true\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /review\.md.*forbids disable-model-invocation/);
});

// The third clause of the consequence contract: `confirm-first` is the deliberate
// exception class, and every member names its justification inline.

test("routing check: a confirm-first command whose justification is missing fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/routing.md", ROUTING_HEAD + CYCLE_ROW);
  failsWith(runValidate(dir), /references\/routing\.md/, /cycle.*confirm-first.*justification/);
});

test("routing check: a confirm-first justification that is only a label fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/routing.md", ROUTING_HEAD + CYCLE_ROW + "\n**`cycle`'s justification.**\n");
  failsWith(runValidate(dir), /references\/routing\.md/, /cycle.*confirm-first.*justification/);
});

test("routing check: a justification naming another command does not cover this one", () => {
  const dir = makePluginFixture();
  writeInto(
    dir,
    "references/routing.md",
    ROUTING_HEAD +
      CYCLE_ROW +
      "| plan a change | `sketch` | confirm-first | yes |\n" +
      CYCLE_JUSTIFICATION
  );
  writeInto(dir, "commands/sketch.md", '---\ndescription: "s"\n---\n');
  failsWith(runValidate(dir), /references\/routing\.md/, /sketch.*confirm-first.*justification/);
});

test("routing check: a command listed twice in the routing table fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/routing.md", ROUTING_HEAD + CYCLE_ROW + CYCLE_ROW + CYCLE_JUSTIFICATION);
  failsWith(runValidate(dir), /references\/routing\.md.*cycle appears more than once/);
});

test("routing check: a routing row naming no command fails", () => {
  const dir = makePluginFixture();
  writeInto(dir, "references/routing.md", routing("| do the thing | `ghost` | read-only | yes |\n"));
  failsWith(runValidate(dir), /references\/routing\.md.*"ghost" names no command/);
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
  assert.match(stderr, /commands\/cycle\.md: \d+ lines > 100/);
});

// Pads the surface with `count` gerund-named playbooks of 100 lines each — each
// one under the 150-line per-file ceiling, so only the total arm can fire.
const padSurface = (dir, count) => {
  for (let i = 0; i < count; i++) writeInto(dir, `playbooks/padding-${i}.md`, "x\n".repeat(100));
};

test("budget check: a surface over 3500 lines in total fails", () => {
  const dir = makePluginFixture();
  padSurface(dir, 40); // 4000 lines
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /runtime surface \d+ lines > 3500/);
  assert.doesNotMatch(stderr, /lines > 150/); // the total arm fired, not the per-file arm
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
  assert.match(stderr, /playbooks\/padding-things\.md: \d+ lines > 150/);
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
