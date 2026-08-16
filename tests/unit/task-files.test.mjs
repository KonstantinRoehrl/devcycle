import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFileToken, extractFiles, parseFileList } from "../../scripts/task-files.mjs";

test("normalizeFileToken strips ranges, backticks, and rejects non-paths", () => {
  assert.equal(normalizeFileToken("`scripts/a.mjs:12-20`"), "scripts/a.mjs");
  assert.equal(normalizeFileToken("Modify"), null);
  assert.equal(normalizeFileToken("-"), null);
  assert.equal(normalizeFileToken("prose"), null);
  assert.equal(normalizeFileToken("a.mjs"), "a.mjs");
});

test("extractFiles pulls path tokens out of a Files block", () => {
  const block = "- Create: `scripts/x.mjs`\n- Modify: `refs/y.md:3-9` (a note)\n";
  assert.deepEqual([...extractFiles(block)].sort(), ["refs/y.md", "scripts/x.mjs"]);
});

test("parseFileList normalizes a CSV --files argument", () => {
  assert.deepEqual(parseFileList("scripts/a.mjs:1-9, `b/c.md` , Modify"), ["scripts/a.mjs", "b/c.md"]);
});
