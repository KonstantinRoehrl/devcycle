// Cross-reference checks in scripts/validate.mjs, exercised against throwaway
// plugin trees. Every test starts from a green fixture and breaks one thing.
import test from "node:test";
import assert from "node:assert/strict";
import { makePluginFixture, writeInto, runValidate, FIXTURE_PLAYBOOK_HEAD } from "./helpers.mjs";

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
  writeInto(
    dir,
    "references/routing.md",
    "# Routing\n\n| intent | entry point | consequence | model-invocable |\n| --- | --- | --- | --- |\n| run the pipeline | `cycle` | confirm-first | yes |\n| set up a repo | `onboard` | side-effectful | no |\n"
  );
  writeInto(dir, "commands/onboard.md", '---\ndescription: "o"\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /onboard\.md.*disable-model-invocation/);
});

test("routing check: a read-only command carrying the guard fails", () => {
  const dir = makePluginFixture();
  writeInto(
    dir,
    "references/routing.md",
    "# Routing\n\n| intent | entry point | consequence | model-invocable |\n| --- | --- | --- | --- |\n| run the pipeline | `cycle` | confirm-first | yes |\n| review code | `review` | read-only | yes |\n"
  );
  writeInto(dir, "commands/review.md", '---\ndescription: "r"\ndisable-model-invocation: true\n---\n');
  const { status, stderr } = runValidate(dir);
  assert.equal(status, 1);
  assert.match(stderr, /review\.md.*forbids disable-model-invocation/);
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
