import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { field, fieldText, readRecordDir, recordTitle } from "../../scripts/md-field.mjs";

test("field returns the trimmed value of a present key", () => {
  assert.equal(field("- stage: brainstorm\n- kind: bug", "stage"), "brainstorm");
});

test("field returns null for an absent key", () => {
  assert.equal(field("- stage: x", "root"), null);
});

test("field on a blank field does NOT cross into the next line", () => {
  // Regression for 581e1153: `\\s*` would let a blank value read the next line back.
  assert.equal(field("- request:\n- root: /repo", "request"), "");
});

test("fieldText returns '' for an absent key", () => {
  assert.equal(fieldText("- stage: x", "root"), "");
});

test("fieldText returns the value for a present key", () => {
  assert.equal(fieldText("- root: /repo", "root"), "/repo");
});

test("recordTitle reads the first # heading, blank when absent or empty", () => {
  assert.equal(recordTitle("# A title \n- k: v\n"), "A title");
  assert.equal(recordTitle("# \n- k: v\n"), "");
  assert.equal(recordTitle("- k: v\n"), "");
});

test("readRecordDir returns [] for a directory that does not exist", () => {
  assert.deepEqual(readRecordDir(join(makeTempDir("recdir-"), "absent")), []);
});

test("readRecordDir reads every .md but README.md, in name order, with its title", () => {
  const dir = makeTempDir("recdir-");
  writeFileSync(join(dir, "b.md"), "# Bee\n");
  writeFileSync(join(dir, "a.md"), "# Ay\n");
  writeFileSync(join(dir, "README.md"), "# Readme\n");
  writeFileSync(join(dir, "notes.txt"), "# Not a record\n");
  assert.deepEqual(readRecordDir(dir), [
    { file: "a.md", text: "# Ay\n", title: "Ay" },
    { file: "b.md", text: "# Bee\n", title: "Bee" },
  ]);
});
