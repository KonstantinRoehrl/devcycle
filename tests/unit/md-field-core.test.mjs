import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { field } from "../../scripts/md-field-core.mjs";
import * as mdField from "../../scripts/md-field.mjs";

test("md-field re-exports the core parser's own binding, so every importer reads one implementation", () => {
  assert.equal(mdField.field, field);
});

test("field reads a value, misses as null, and never reads the next line back for a blank field", () => {
  const text = "# devcycle state\n- stage: planning\n- run:\n- branch: topic\n";
  assert.equal(field(text, "stage"), "planning");
  assert.equal(field(text, "run"), "");
  assert.equal(field(text, "plan"), null);
});

test("md-field-core imports nothing — the hooks module, which has no Node, loads it", () => {
  const src = readFileSync(new URL("../../scripts/md-field-core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
});
