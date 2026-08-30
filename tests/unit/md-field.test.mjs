import { test } from "node:test";
import assert from "node:assert/strict";
import { field, fieldText } from "../../scripts/md-field.mjs";

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
