// Cross-reference checks in scripts/validate.mjs, exercised against throwaway
// plugin trees. Every test starts from a green fixture and breaks one thing.
import test from "node:test";
import assert from "node:assert/strict";
import { makePluginFixture, writeInto, runValidate } from "./helpers.mjs";

// Replaces the fixture playbook's body. Playbooks have no frontmatter.
const playbook = (dir, body) => writeInto(dir, "playbooks/demoing-things.md", "# Demoing things\n\n" + body);

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
