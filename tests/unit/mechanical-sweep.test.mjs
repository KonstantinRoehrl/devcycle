import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
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

// Audit 2026-09-05 L4 (1): `git add -A` honoured .gitignore, so an ignored target never entered the
// sweep-base commit, its edit was invisible to `git status`, and the file was reported "agent made
// no change". The target is now force-added, so its edit shows and is applied.
function repoWithIgnoredTarget() {
  const repo = repoWithJsFiles();
  writeFileSync(join(repo, ".gitignore"), "gen/\n");
  commitAll(repo, "ignore gen/");
  mkdirSync(join(repo, "gen"));
  writeFileSync(join(repo, "gen", "c.js"), "const c = 3;\n"); // ignored, never committed
  return repo;
}

test("a gitignored target is edited and applied like any other", () => {
  const repo = repoWithIgnoredTarget();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    { files: ["gen/c.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.applied, ["gen/c.js"]);
  assert.deepEqual(report.skipped, []);
  assert.match(readFileSync(join(repo, "gen", "c.js"), "utf8"), /\/\/ swept/);
});

// L4 (2): a collateral file the editor creates under an ignored path was invisible to the purity
// check; `--ignored=matching` makes it a foreign change that reverts the attempt.
test("a collateral file the editor creates under an ignored path reverts the attempt", () => {
  const repo = repoWithIgnoredTarget();
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
fs.mkdirSync("gen", { recursive: true });
fs.writeFileSync("gen/collateral.js", "collateral\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "also wrote scratch" } }));
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

// Branch review round 1, finding B: `--ignored=matching` also sees the gitignored artifacts the
// sweep's OWN verifyCommand writes (coverage/, dist/, a node_modules/ from an install), and
// `git clean -fd` cannot remove them — so without a per-attempt ignored baseline the first purity
// check blamed the editor for them and every remaining target skipped the same way. Both tests
// below are multi-target on purpose: the single-file test above stops after the first revert and
// therefore cannot see the poisoning.
function repoWithThreeTargetsAndIgnores() {
  const repo = makeRepo();
  for (const f of ["a.js", "b.js", "c.js"]) writeFileSync(join(repo, f), `const ${f[0]} = 1;\n`);
  // Both ignore shapes: a wholly ignored directory (git status collapses it to `gen/`) and a
  // pattern that matches individual files (reported per file), so the snapshot is exercised at both
  // granularities.
  writeFileSync(join(repo, ".gitignore"), "gen/\n*.tmp\n");
  commitAll(repo, "add files, ignore gen/ and *.tmp");
  return repo;
}

test("gitignored output written by the verify command itself never counts as the editor's collateral", () => {
  const repo = repoWithThreeTargetsAndIgnores();
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    {
      files: ["a.js", "b.js", "c.js"],
      instruction: "append marker",
      // A fresh ignored artifact per run ($$ is the verify shell's pid), like a build or coverage
      // step: the baseline run leaves one behind and so does every per-file run, so passing this
      // needs the snapshot retaken after each verify, not only after the baseline one.
      verifyCommand: 'mkdir -p gen && touch gen/out && touch "scratch.$$.tmp"',
    },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.skipped, [], "the verify command's own ignored output is not a foreign change");
  assert.deepEqual(report.applied, ["a.js", "b.js", "c.js"]);
  for (const f of ["a.js", "b.js", "c.js"]) {
    assert.match(readFileSync(join(repo, f), "utf8"), /\/\/ swept/);
  }
});

test("agent collateral under an ignored path reverts that attempt only — the remaining targets still apply", () => {
  const repo = repoWithThreeTargetsAndIgnores();
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
if (target === "a.js") {
  fs.mkdirSync("gen", { recursive: true });
  fs.writeFileSync("gen/collateral.js", "collateral\\n");
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "edited" } }));
`
  );
  const res = runScript(
    SCRIPT,
    { files: ["a.js", "b.js", "c.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.skipped.length, 1, `only the attempt that created the collateral is skipped: ${res.stderr}`);
  assert.equal(report.skipped[0].file, "a.js");
  // `gen/` is wholly ignored, so git status names the directory rather than the file inside it.
  assert.match(report.skipped[0].reason, /modified files other than the target \(a\.js, gen\/\); reverted/);
  assert.deepEqual(report.applied, ["b.js", "c.js"]);
  assert.ok(!readFileSync(join(repo, "a.js"), "utf8").includes("swept"), "the reverted attempt is not applied");
  assert.match(readFileSync(join(repo, "b.js"), "utf8"), /\/\/ swept/);
});

// Branch review round 2: the baseline is compared per git-status entry, and git reports a wholly
// ignored directory as ONE collapsed entry (`gen/`). A verifyCommand that builds, tests or measures
// coverage creates exactly such a directory, so from the second target onward every file the editor
// writes inside it arrives under that same already-baselined entry. Comparing entry paths therefore
// waved the collateral through and reopened L4 in its most common form; the two tests below drive
// that exact combination, which no test above does.
const VERIFY_MAKES_IGNORED_DIR = "mkdir -p gen && touch gen/build.out";

// Edits its target, and while editing b.js also drops a file INSIDE the directory the verify made.
const COLLATERAL_INTO_VERIFY_DIR_EDITOR = `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
if (target === "b.js") fs.writeFileSync("gen/collateral.js", "collateral\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "edited" } }));
`;

test("collateral written inside a verify-created ignored directory is caught, not hidden by the baselined directory", () => {
  const repo = repoWithThreeTargetsAndIgnores();
  const bin = makeFakeBin("claude", COLLATERAL_INTO_VERIFY_DIR_EDITOR);
  const res = runScript(
    SCRIPT,
    { files: ["a.js", "b.js", "c.js"], instruction: "append marker", verifyCommand: VERIFY_MAKES_IGNORED_DIR },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(
    report.skipped.length,
    1,
    `the attempt that wrote into the baselined ignored directory must be skipped: ${JSON.stringify(report.skipped)}`
  );
  assert.equal(report.skipped[0].file, "b.js");
  // The reason must name the file inside the directory. `gen/` alone is the collapsed entry the
  // baseline already holds, so reporting it would mean the check never looked inside.
  assert.match(report.skipped[0].reason, /modified files other than the target \(b\.js, gen\/collateral\.js\); reverted/);
  assert.deepEqual(report.applied, ["a.js", "c.js"]);
  assert.ok(!readFileSync(join(repo, "b.js"), "utf8").includes("swept"), "the rejected attempt is not applied");
  assert.match(readFileSync(join(repo, "a.js"), "utf8"), /\/\/ swept/);
  assert.match(readFileSync(join(repo, "c.js"), "utf8"), /\/\/ swept/);
});

test("a rejected attempt's ignored collateral is deleted while the verify command's own artifact survives", () => {
  const repo = repoWithThreeTargetsAndIgnores();
  const bin = makeFakeBin("claude", COLLATERAL_INTO_VERIFY_DIR_EDITOR);
  // The sweep worktree is removed before the run returns, so the verify command — which runs inside
  // it — is where its contents can be observed: every run appends a listing of gen/, and the last
  // one runs after the rejected attempt was reverted.
  const listing = join(mkdtempSync(join(tmpdir(), "devcycle-sweep-gen-")), "gen-listing.txt");
  const res = runScript(
    SCRIPT,
    {
      files: ["a.js", "b.js", "c.js"],
      instruction: "append marker",
      verifyCommand: `${VERIFY_MAKES_IGNORED_DIR} && { echo "== run"; ls gen; } >> ${JSON.stringify(listing)}`,
    },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.skipped.length, 1, `precondition — b.js is rejected: ${JSON.stringify(report.skipped)}`);
  const runs = readFileSync(listing, "utf8").split("== run").slice(1);
  const afterRevert = runs[runs.length - 1];
  assert.ok(
    !afterRevert.includes("collateral.js"),
    `the rejected attempt's collateral must be deleted from the worktree; the next verify still saw:\n${afterRevert}`
  );
  assert.ok(
    afterRevert.includes("build.out"),
    `deleting the collateral must not take the verify command's own artifact with it; the next verify saw:\n${afterRevert}`
  );
});

// L4 (3): a previous sweep SIGKILLed mid-run leaves a worktree registration whose directory is gone;
// `git worktree prune` before `worktree add` removes it instead of tripping over it.
test("a stale worktree registration from a killed sweep is pruned, not tripped over", () => {
  const repo = repoWithJsFiles();
  const staleParent = mkdtempSync(join(tmpdir(), "devcycle-stale-wt-"));
  const stale = join(staleParent, "wt");
  execFileSync("git", ["worktree", "add", "--detach", stale, "HEAD"], { cwd: repo, stdio: "ignore" });
  rmSync(stale, { recursive: true, force: true });
  const bin = makeFakeBin("claude", WELL_BEHAVED_EDITOR);
  const res = runScript(
    SCRIPT,
    { files: ["a.js"], instruction: "append marker", verifyCommand: "true" },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.deepEqual(JSON.parse(res.stdout).applied, ["a.js"]);
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" });
  assert.ok(!list.includes(basename(staleParent)), `the stale registration must be pruned:\n${list}`);
});
