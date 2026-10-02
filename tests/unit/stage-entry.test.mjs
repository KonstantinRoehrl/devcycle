// scripts/stage-entry.mjs: each stage's entry and re-entry note, read from references/stages.json.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { PLUGIN_ROOT, loadStages, stageEntry, entryLines } from "../../scripts/stage-entry.mjs";

const stageEnum = () =>
  readFileSync(join(PLUGIN_ROOT, "commands/cycle.md"), "utf8").match(/stage:\s*<([a-z|-]+)>/)[1].split("|");

test("the shipped table has an entry for every stage in the enum except done", () => {
  const keys = Object.keys(loadStages()).sort();
  assert.deepEqual(keys, stageEnum().filter((s) => s !== "done").sort());
});

test("a playbook entry prints as an absolute path that exists, with an empty note shown as none", () => {
  const e = stageEntry("planning");
  assert.ok(e.entry.endsWith(join("playbooks", "planning-waves.md")));
  assert.ok(existsSync(e.entry), e.entry);
  assert.deepEqual(entryLines(e), [`entry: ${e.entry}`, "note: none"]);
});

test("a skill entry prints verbatim and a surface path in the note prints absolute", () => {
  const e = stageEntry("brainstorm");
  assert.equal(e.entry, "superpowers:brainstorming");
  assert.ok(e.note.includes(join(PLUGIN_ROOT, "commands/cycle.md")), e.note);
});

test("an unknown stage, and done, have no entry", () => {
  assert.throws(() => stageEntry("nope"), /no entry for stage "nope"/);
  assert.throws(() => stageEntry("done"), /no entry for stage "done"/);
});

test("a missing, malformed, or mis-shaped table throws with its reason", () => {
  const dir = makeTempDir("stage-entry-");
  try {
    assert.throws(() => loadStages(join(dir, "absent.json")), /cannot read/);
    const bad = writeInto(dir, "bad.json", "{ not json");
    assert.throws(() => loadStages(bad), /is not valid JSON/);
    const arr = writeInto(dir, "arr.json", "[]");
    assert.throws(() => loadStages(arr), /must be a JSON object/);
    const entry = writeInto(dir, "entry.json", JSON.stringify({ planning: { entry: "planning-waves.md", note: "" } }));
    assert.throws(() => loadStages(entry), /"planning"\.entry must be playbooks\/<file>\.md or superpowers:<skill>/);
    const note = writeInto(dir, "note.json", JSON.stringify({ planning: { entry: "playbooks/planning-waves.md" } }));
    assert.throws(() => loadStages(note), /"planning"\.note must be a string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
