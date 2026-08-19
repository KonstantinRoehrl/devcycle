import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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

// `references/sweep-execution.md:38-39` makes the caller branch on two different
// exit-1 shapes: a hard stop is "exit 1 with a stdout report" (the coordinator
// ledgers a rejected verdict) and a fatal is "exit 1 without a report" (it
// ledgers no verdict at all). Both are pinned here so the distinction cannot be
// erased by accident.

test("baseline verification failure hard-stops before any edit: exit 1 WITH a stdout report", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    { files: ["a.js", "b.js"], instruction: "append marker", verifyCommand: "false" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, []);
  assert.equal(report.skipped.length, 2, "every target is reported, not just the one that tripped it");
  for (const s of report.skipped) {
    assert.match(s.reason, /baseline verification failed before any edits \(exit 1\)/);
  }
  assert.ok(!readFileSync(join(repo, "a.js"), "utf8").includes("swept"), "real tree must be untouched");
});

test("an argument error is a fatal exit 1 with NO stdout report", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    { files: [], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 1);
  assert.equal(res.stdout, "", "a fatal prints no report — the caller logs no verdict for it");
  assert.match(res.stderr, /args\.files must be a non-empty array of strings/);
});

// Every editor failure is `hard`, so hitting one inside the pilot hard-stops the
// sweep: exit 1 with a report that names which branch failed and marks the
// untried remainder. One test per branch of runEditorAgent's failure ladder.

for (const c of [
  {
    name: "an is_error envelope",
    body: `process.stdout.write(JSON.stringify({ is_error: true, result: "model refused" }))`,
    reason: /editor agent failed: editor agent error: model refused/,
  },
  {
    name: "unparseable output",
    body: `process.stdout.write("not json at all")`,
    reason: /editor agent failed: unparseable editor output: not json at all/,
  },
]) {
  test(`editor failure — ${c.name}: hard stop, exit 1, report names the reason`, () => {
    const repo = repoWithJsFiles();
    const bin = makeFakeBin("claude", c.body);
    const res = runScript(
      SCRIPT,
      { files: ["a.js", "b.js"], instruction: "append marker", verifyCommand: "true" },
      { cwd: repo, binDirs: [bin] }
    );
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    assert.deepEqual(report.applied, []);
    assert.match(report.skipped[0].reason, c.reason);
    assert.match(report.skipped[1].reason, /not attempted: pilot hard-stopped/);
  });
}

test("editor failure — the claude CLI cannot be spawned: reported as not runnable, never a silent skip", () => {
  const repo = repoWithJsFiles();
  // No fake bin AND an isolated PATH, so `claude` is genuinely absent. Prepending
  // a non-executable fake would NOT reach this branch: PATH lookup skips it and
  // finds the developer's real CLI instead.
  const res = runScript(
    SCRIPT,
    { files: ["a.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [], isolatePath: true }
  );
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, []);
  assert.match(report.skipped[0].reason, /editor agent failed: claude CLI not runnable: .*ENOENT/);
});

test("an editor that reports no change skips the file with its reason and does not hard-stop", () => {
  const repo = repoWithJsFiles();
  const bin = makeFakeBin(
    "claude",
    `process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: false, note: "does not apply" } }))`
  );
  const res = runScript(
    SCRIPT,
    { files: ["a.js", "b.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, []);
  assert.equal(report.skipped.length, 2, "a benign no-change skip must not trip the pilot gate");
  assert.match(report.skipped[0].reason, /agent made no change: does not apply/);
});

// The remaining runEditorAgent branch — the agent timing out — is not reachable
// from here: the timeout is a 15-minute module constant with no injection point,
// and adding a production knob to test it would be worse than the gap. It is
// covered directly in tests/unit/agent-cli.test.mjs, which drives run() with a
// short timeoutMs and claudeStructured() with a shortened clock, for both the
// single-attempt and the retried shape.

// The claude CLI's --tools is a VARIADIC option: in the two-element form it
// greedily consumes following positionals, so the prompt gets swallowed into
// the tools list. review-panel.js has documented and used the equals form since
// it was written; the sweep's copied subprocess layer had silently reverted to
// the two-element form, surviving only because --permission-mode happened to
// follow it. This test makes the invariant hold for the sweep by assertion, not
// by argument order.
test("the editor agent is invoked with the equals form of --tools", () => {
  const repo = repoWithJsFiles();
  const argvLog = join(mkdtempSync(join(tmpdir(), "devcycle-sweep-argv-")), "argv.json");
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "ok" } }));
`
  );
  const res = runScript(
    SCRIPT,
    { files: ["a.js"], instruction: "append marker", verifyCommand: SYNTAX_VERIFY },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const argv = JSON.parse(readFileSync(argvLog, "utf8"));
  assert.ok(
    argv.includes("--tools=Read,Grep,Glob,Edit,Write"),
    `--tools must use the equals form or the variadic flag swallows the prompt; got: ${argv.join(" ")}`
  );
  assert.ok(!argv.includes("--tools"), "the bare two-element --tools form must never come back");
  // The whole point of the equals form: the prompt survives as the final positional.
  assert.match(argv[argv.length - 1], /^You are performing one step of a mechanical sweep/);
});
