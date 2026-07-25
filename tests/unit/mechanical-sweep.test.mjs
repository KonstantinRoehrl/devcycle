import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, commitAll, makeFakeBin, runScript } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "workflows", "mechanical-sweep.js");

// Fake editor that appends a marker line to exactly the target file named in
// the prompt — the behavior of a well-behaved editor agent.
const WELL_BEHAVED_EDITOR = `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "appended marker" } }));
`;

function repoWithJsFiles() {
  const repo = makeRepo();
  writeFileSync(join(repo, "a.js"), "const a = 1;\n");
  writeFileSync(join(repo, "b.js"), "const b = 2;\n");
  commitAll(repo, "add files");
  return repo;
}

const SYNTAX_VERIFY = 'for f in *.js; do node --check "$f" || exit 1; done';

test("sweep applies verified edits back to the real tree", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    { files: ["a.js", "b.js"], instruction: "append marker", verifyCommand: SYNTAX_VERIFY },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, ["a.js", "b.js"]);
  assert.deepEqual(report.skipped, []);
  assert.match(readFileSync(join(repo, "a.js"), "utf8"), /\/\/ swept/);
  assert.match(readFileSync(join(repo, "b.js"), "utf8"), /\/\/ swept/);
});

test("pilot verification failure hard-stops the sweep and leaves the real tree untouched", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  // Baseline green (no marker anywhere); after the first edit the marker
  // exists in the worktree and verification fails.
  const res = runScript(
    SCRIPT,
    { files: ["a.js", "b.js"], instruction: "append marker", verifyCommand: "! grep -q swept a.js" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, []);
  assert.equal(report.skipped.length, 2);
  assert.match(report.skipped[0].reason, /verification failed/);
  assert.match(report.skipped[1].reason, /not attempted: pilot hard-stopped/);
  assert.ok(!readFileSync(join(repo, "a.js"), "utf8").includes("swept"), "real tree must be untouched");
});

test("file-list normalization: duplicates, missing files, and paths outside the repo are skipped with reasons", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    {
      files: ["a.js", "a.js", "missing.js", "../outside.js"],
      instruction: "append marker",
      verifyCommand: "true",
    },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, ["a.js"]);
  const reasons = Object.fromEntries(report.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons["a.js"], /duplicate/);
  assert.match(reasons["missing.js"], /not found/);
  assert.match(reasons["../outside.js"], /outside the repository/);
});

test("an editor that touches a non-target file is reverted and skipped", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
fs.writeFileSync("other.js", "collateral\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "oops" } }));
`
  );
  const res = runScript(
    SCRIPT,
    { files: ["a.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, []);
  assert.match(report.skipped[0].reason, /modified files other than the target/);
  assert.ok(!readFileSync(join(repo, "a.js"), "utf8").includes("swept"));
});

test("deletions are never applied", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.unlinkSync(target);
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "deleted it" } }));
`
  );
  const res = runScript(
    SCRIPT,
    { files: ["a.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, []);
  assert.match(report.skipped[0].reason, /deletions are not applied/);
  assert.ok(readFileSync(join(repo, "a.js"), "utf8").includes("const a = 1;"), "real file must survive");
});
