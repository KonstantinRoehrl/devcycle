import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFileToken,
  extractFiles,
  parseFileList,
  taskBlocks,
  taskFileMap,
  parseDispatchMap,
} from "../../scripts/task-files.mjs";

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

test("parseFileList keeps a top-level extensionless file the caller explicitly named", () => {
  // The --files CSV is caller-asserted: these ARE files, so the path-shape gate must not drop
  // Dockerfile/Makefile/LICENSE, or their lessons are silently withheld.
  assert.deepEqual(parseFileList("Dockerfile"), ["Dockerfile"]);
  assert.deepEqual(parseFileList("Dockerfile, Makefile, scripts/a.mjs"),
    ["Dockerfile", "Makefile", "scripts/a.mjs"]);
  // Labels and bare dashes are still dropped even on the trusted path.
  assert.deepEqual(parseFileList("Modify, -, LICENSE"), ["LICENSE"]);
});

test("extractFiles still rejects a bare extensionless token as prose (the asymmetry the fix preserves)", () => {
  // The **Files:**-block parse path stays strict: an extensionless word with no slash reads as
  // surrounding prose, so wave-disjointness parity is unchanged.
  assert.deepEqual([...extractFiles("Dockerfile is the build entrypoint")], []);
});

const PLAN = [
  "### Task 1: First",
  "",
  "**Files:**",
  "- Modify: `scripts/a.mjs`",
  "",
  "**Evidence:** red-green",
  "",
  "### Task 2: Second",
  "",
  "**Files:**",
  "- Modify: `scripts/b.mjs`",
  "",
  "## Dispatch Map",
  "- Wave 1: Task 1, Task 2 (file-disjoint)",
  "- Wave 2: Task 3 (needs Task 1 and Task 2)",
  "",
].join("\n");

test("taskBlocks numbers each block and slices to the next heading", () => {
  const blocks = taskBlocks(PLAN);
  assert.deepEqual(blocks.map((b) => b.num), [1, 2]);
  assert.ok(blocks[0].text.includes("scripts/a.mjs"));
  assert.ok(!blocks[0].text.includes("scripts/b.mjs"), "block 1 must stop at the next heading");
});

test("taskFileMap maps each task number to its declared files", () => {
  const map = taskFileMap(PLAN);
  assert.deepEqual([...map.get(1)], ["scripts/a.mjs"]);
  assert.deepEqual([...map.get(2)], ["scripts/b.mjs"]);
});

test("parseDispatchMap reads only the text before the first paren", () => {
  const waves = parseDispatchMap(PLAN);
  assert.deepEqual(waves.get(1), [1, 2]);
  assert.deepEqual(waves.get(3), undefined);
  assert.deepEqual(waves.get(2), [3], "a dependency parenthetical is not a wave assignment");
});

test("parseDispatchMap returns null when no Dispatch Map heading exists", () => {
  assert.equal(parseDispatchMap("### Task 1: Only\n"), null);
});

test("taskBlocks returns an empty array for a document with no task headings", () => {
  assert.deepEqual(taskBlocks("# Not a plan\n\nProse only.\n"), []);
});
