import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePatch, anchorFinding } from "../../scripts/pr-diff-anchor.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/pr-diff-anchor.mjs", import.meta.url));

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

test("CLI partitions an in-hunk finding into anchored (RIGHT) and out-of-hunk / file-only findings into degraded", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-diff-anchor-cli-"));
  const diffFile = join(dir, "diff.patch");
  const findingsFile = join(dir, "findings.json");
  writeFileSync(diffFile, TWO_FILE_DIFF);
  writeFileSync(
    findingsFile,
    JSON.stringify([
      { path: "src/a.js", line: 3 }, // on an added line -> anchored, side RIGHT
      { path: "src/a.js", line: 99 }, // outside every hunk -> degraded
      { path: "src/a.js" }, // file-only finding (no line) -> degraded
    ])
  );

  const res = spawnSync("node", [SCRIPT, "--diff-file", diffFile, "--findings-file", findingsFile], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.anchored, [{ index: 0, path: "src/a.js", line: 3, side: "RIGHT" }]);
  assert.equal(out.degraded.length, 2);
  assert.deepEqual(
    out.degraded.map((d) => d.index).sort((a, b) => a - b),
    [1, 2]
  );
  for (const d of out.degraded) assert.ok(d.reason, "a degraded finding must carry a reason");
});

test("CLI accepts a review-panel-shaped finding (file, no path) and anchors it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-diff-anchor-cli-"));
  const diffFile = join(dir, "diff.patch");
  const findingsFile = join(dir, "findings.json");
  writeFileSync(diffFile, TWO_FILE_DIFF);
  writeFileSync(
    findingsFile,
    // Mirrors workflows/review-panel.js's FINDINGS_SCHEMA output shape (file, not path) --
    // not imported, since that file is a CommonJS workflow script with real side effects at
    // load (require("./lib/agent-cli.js"), logger setup, process.env reads).
    JSON.stringify([
      { file: "src/b.js", line: 11, claim: "off-by-one", severity: "medium", measuredAgainst: "unstated", lens: "correctness" },
    ])
  );

  const res = spawnSync("node", [SCRIPT, "--diff-file", diffFile, "--findings-file", findingsFile], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.anchored, [{ index: 0, path: "src/b.js", line: 11, side: "RIGHT" }]);
  assert.equal(out.degraded.length, 0);
});

test("CLI degrades a finding with neither path nor file, with a named reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-diff-anchor-cli-"));
  const diffFile = join(dir, "diff.patch");
  const findingsFile = join(dir, "findings.json");
  writeFileSync(diffFile, TWO_FILE_DIFF);
  writeFileSync(findingsFile, JSON.stringify([{ line: 3, claim: "no path or file field" }]));

  const res = spawnSync("node", [SCRIPT, "--diff-file", diffFile, "--findings-file", findingsFile], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.anchored.length, 0);
  assert.equal(out.degraded.length, 1);
  assert.equal(out.degraded[0].reason, "finding missing path/file");
});

test("CLI reports malformed findings JSON through its own pr-diff-anchor: error, not a raw stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-diff-anchor-cli-"));
  const diffFile = join(dir, "diff.patch");
  const findingsFile = join(dir, "findings.json");
  writeFileSync(diffFile, TWO_FILE_DIFF);
  writeFileSync(findingsFile, "{ not valid json");

  const res = spawnSync("node", [SCRIPT, "--diff-file", diffFile, "--findings-file", findingsFile], {
    encoding: "utf8",
  });
  assert.notEqual(res.status, 0, "malformed findings JSON must fail");
  assert.match(res.stderr, /^pr-diff-anchor: /m, "the error must use the script's own message prefix");
});

test("CLI rejects an unrecognised flag rather than silently ignoring it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-diff-anchor-cli-"));
  const diffFile = join(dir, "diff.patch");
  const findingsFile = join(dir, "findings.json");
  writeFileSync(diffFile, TWO_FILE_DIFF);
  writeFileSync(findingsFile, JSON.stringify([{ path: "src/a.js", line: 3 }]));

  const res = spawnSync(
    "node",
    [SCRIPT, "--diff-file", diffFile, "--findings-file", findingsFile, "--bogus", "x"],
    { encoding: "utf8" }
  );
  assert.notEqual(res.status, 0, "an unrecognised flag must fail rather than be ignored");
  assert.match(res.stderr, /unrecognised flag --bogus/);
});
