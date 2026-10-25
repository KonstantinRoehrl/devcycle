import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { claudeConfigHome, EFFORT_LEVELS, resolveEffort } from "../../scripts/claude-settings.mjs";

const MODEL = "claude-sonnet-5-5";
const LEVELS = "not one of low, medium, high, xhigh, max";
const FILE_LEVELS = "not one of low, medium, high, xhigh";

// A checkout and a config home, both temp, with whichever settings files the test names; a string is
// written as is (a torn file), anything else as JSON. CLAUDE_CONFIG_DIR always points at the temp home,
// so nothing here reads the real ~/.claude.
function world({ local, project, user } = {}) {
  const cwd = makeTempDir("devcycle-settings-cwd-");
  const config = makeTempDir("devcycle-settings-home-");
  const files = { local: join(cwd, ".claude", "settings.local.json"), project: join(cwd, ".claude", "settings.json"), user: join(config, "settings.json") };
  for (const [name, value] of Object.entries({ local, project, user })) {
    if (value === undefined) continue;
    mkdirSync(dirname(files[name]), { recursive: true });
    writeFileSync(files[name], typeof value === "string" ? value : JSON.stringify(value));
  }
  return { cwd, files, env: { CLAUDE_CONFIG_DIR: config } };
}
const effortIn = (w, env = {}, model = MODEL) => resolveEffort({ env: { ...w.env, ...env }, cwd: w.cwd, model });
const perModel = (level, model = MODEL) => ({ modelSettings: { [model]: { effortLevel: level } } });

test("EFFORT_LEVELS are the five levels claude --effort accepts", () => {
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
});

test("claudeConfigHome is CLAUDE_CONFIG_DIR when set, and ~/.claude when it is unset or empty", () => {
  assert.equal(claudeConfigHome({ CLAUDE_CONFIG_DIR: "/elsewhere/config" }), "/elsewhere/config");
  assert.equal(claudeConfigHome({}), join(homedir(), ".claude"));
  assert.equal(claudeConfigHome({ CLAUDE_CONFIG_DIR: "" }), join(homedir(), ".claude"));
});

test("CLAUDE_EFFORT beats every settings file; an empty one counts as unset", () => {
  const w = world({ local: { ...perModel("xhigh"), effortLevel: "low" } });
  assert.deepEqual(effortIn(w, { CLAUDE_EFFORT: "medium" }), { effort: "medium", source: "env" });
  assert.deepEqual(effortIn(w, { CLAUDE_EFFORT: "" }), { effort: "xhigh", source: "modelSettings" });
});

// A settings file's "max" is a value Claude Code drops (its schema takes low|medium|high|xhigh there), so
// the fixtures below use xhigh, the highest level a file can carry.
test("the model's modelSettings entry beats effortLevel in any file, read local → project → user", () => {
  const spread = world({ local: { effortLevel: "low" }, project: perModel("xhigh"), user: perModel("high") });
  assert.deepEqual(effortIn(spread), { effort: "xhigh", source: "modelSettings" });
  assert.deepEqual(effortIn(world({ local: perModel("medium"), project: perModel("xhigh") })), { effort: "medium", source: "modelSettings" });
  assert.deepEqual(effortIn(world({ user: perModel("xhigh") })), { effort: "xhigh", source: "modelSettings" });
  assert.deepEqual(effortIn(world({ user: { ...perModel("xhigh", "claude-opus-5-5"), effortLevel: "high" } })),
    { effort: "high", source: "effortLevel" }, "another model's entry was used");
});

test("effortLevel is read local → project → user, and nothing set anywhere is Claude Code's default", () => {
  assert.deepEqual(effortIn(world({ project: { effortLevel: "medium" }, user: { effortLevel: "high" } })), { effort: "medium", source: "effortLevel" });
  assert.deepEqual(effortIn(world({ local: { effortLevel: "low" }, project: { effortLevel: "medium" } })), { effort: "low", source: "effortLevel" });
  assert.deepEqual(effortIn(world()), { effort: "default", source: "default" });
});

test("a missing, unparseable or non-object settings file is skipped", () => {
  assert.deepEqual(effortIn(world({ local: "{ torn", project: "[]", user: "null" })), { effort: "default", source: "default" });
  assert.deepEqual(effortIn(world({ local: "{ torn", project: { effortLevel: "high" } })), { effort: "high", source: "effortLevel" });
});

test("max reaches the driver from CLAUDE_EFFORT, which reports the active turn's effort", () => {
  assert.deepEqual(effortIn(world(), { CLAUDE_EFFORT: "max" }), { effort: "max", source: "env" });
});

test("a max in a settings file is dropped as Claude Code drops it, so the next source decides and nothing refuses", () => {
  assert.deepEqual(effortIn(world({ user: { effortLevel: "max" } })), { effort: "default", source: "default" });
  assert.deepEqual(effortIn(world({ project: perModel("max"), user: { effortLevel: "high" } })), { effort: "high", source: "effortLevel" });
  assert.deepEqual(effortIn(world({ local: { effortLevel: "max" }, project: { effortLevel: "medium" } })), { effort: "medium", source: "effortLevel" });
  assert.deepEqual(effortIn(world({ local: perModel("max"), user: perModel("low") })), { effort: "low", source: "modelSettings" });
});

test("a value outside the levels is unresolvable, naming where it was found, and is never passed over for a later one", () => {
  assert.deepEqual(effortIn(world(), { CLAUDE_EFFORT: "turbo" }),
    { effort: null, source: "env", problem: `CLAUDE_EFFORT is "turbo", ${LEVELS}` });
  const project = world({ project: perModel("auto"), user: { effortLevel: "high" } });
  assert.deepEqual(effortIn(project),
    { effort: null, source: "modelSettings", problem: `modelSettings["${MODEL}"].effortLevel in ${project.files.project} is "auto", ${FILE_LEVELS}` });
  const user = world({ user: { effortLevel: 3 } });
  assert.deepEqual(effortIn(user), { effort: null, source: "effortLevel", problem: `effortLevel in ${user.files.user} is 3, ${FILE_LEVELS}` });
  assert.equal(effortIn(world({ local: { effortLevel: "low" }, user: perModel("turbo") })).effort, null,
    "a later file's valid effortLevel stood in for the first modelSettings value found");
});
