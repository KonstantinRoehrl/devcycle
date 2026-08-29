import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, anchorFinding } from "../../scripts/pr-diff-anchor.mjs";

// Two-file diff fixture from the task brief. For src/a.js the new-side numbers are:
// line 1 (context "const x = 1;"), line 2 (added "const y = 3;"), line 3 (added "const z = 4;"),
// line 4 (context "export { x };") -- all in rightLines. For src/b.js: lines 10, 11, 12.
const TWO_FILE_DIFF = `diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x };
diff --git a/src/b.js b/src/b.js
index 333..444 100644
--- a/src/b.js
+++ b/src/b.js
@@ -10,2 +10,3 @@
 a();
+b();
 c();
`;

test("parsePatch keys both files of a multi-file diff by their new-side (b/) path", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  assert.deepEqual([...map.keys()].sort(), ["src/a.js", "src/b.js"]);
});

test("parsePatch tracks new-side line numbers across added/context/removed lines", () => {
  const map = parsePatch(TWO_FILE_DIFF);

  const aHunks = map.get("src/a.js");
  assert.equal(aHunks.length, 1);
  assert.equal(aHunks[0].newStart, 1);
  assert.equal(aHunks[0].newLines, 4);
  assert.deepEqual([...aHunks[0].rightLines].sort((x, y) => x - y), [1, 2, 3, 4]);

  const bHunks = map.get("src/b.js");
  assert.equal(bHunks.length, 1);
  assert.equal(bHunks[0].newStart, 10);
  assert.equal(bHunks[0].newLines, 3);
  assert.deepEqual([...bHunks[0].rightLines].sort((x, y) => x - y), [10, 11, 12]);
});

test("anchorFinding anchors a finding on an added line", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  const result = anchorFinding({ path: "src/a.js", line: 3 }, 0, map);
  assert.deepEqual(result, {
    anchorable: true,
    path: "src/a.js",
    line: 3,
    side: "RIGHT",
    index: 0,
  });
});

test("anchorFinding anchors a finding on a context line inside a hunk", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  const result = anchorFinding({ path: "src/a.js", line: 1 }, 1, map);
  assert.deepEqual(result, {
    anchorable: true,
    path: "src/a.js",
    line: 1,
    side: "RIGHT",
    index: 1,
  });
});

test("anchorFinding rejects a line outside every hunk on the file", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  const result = anchorFinding({ path: "src/a.js", line: 99 }, 2, map);
  assert.equal(result.anchorable, false);
  assert.match(result.reason, /line 99 is not on the PR-head diff/);
  assert.equal(result.index, 2);
});

test("anchorFinding rejects a file-only finding (no line to anchor)", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  const result = anchorFinding({ path: "src/a.js", line: null }, 3, map);
  assert.equal(result.anchorable, false);
  assert.match(result.reason, /file-only finding \(no line to anchor\)/);
  assert.equal(result.index, 3);
});

test("anchorFinding rejects a path absent from the PR diff", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  const result = anchorFinding({ path: "src/missing.js", line: 5 }, 4, map);
  assert.equal(result.anchorable, false);
  assert.match(result.reason, /file not in the PR diff/);
  assert.equal(result.index, 4);
});

test("anchorFinding anchors a finding in the second file of a multi-file diff", () => {
  const map = parsePatch(TWO_FILE_DIFF);
  const result = anchorFinding({ path: "src/b.js", line: 11 }, 5, map);
  assert.deepEqual(result, {
    anchorable: true,
    path: "src/b.js",
    line: 11,
    side: "RIGHT",
    index: 5,
  });
});
