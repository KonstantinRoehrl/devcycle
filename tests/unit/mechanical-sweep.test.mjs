import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import sweep from "../../workflows/mechanical-sweep.js";
import { makeRepo, commitAll, makeFakeBin, runScript } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "workflows", "mechanical-sweep.js");

// The sweep's fixtures are the heaviest in this suite — a git repository plus a worktree per run —
// and nothing else ever deletes them, so every fixture a test below creates is removed when it ends.
function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}

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
function repoWithTargetsAndIgnores(names) {
  const repo = makeRepo();
  for (const f of names) writeFileSync(join(repo, f), `const ${f[0]} = 1;\n`);
  // Both ignore shapes: a wholly ignored directory (git status collapses it to `gen/`) and a
  // pattern that matches individual files (reported per file), so the snapshot is exercised at both
  // granularities.
  writeFileSync(join(repo, ".gitignore"), "gen/\n*.tmp\n");
  commitAll(repo, "add files, ignore gen/ and *.tmp");
  return repo;
}

function repoWithThreeTargetsAndIgnores() {
  return repoWithTargetsAndIgnores(["a.js", "b.js", "c.js"]);
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
  // it — is where its contents can be observed: every run appends a listing of gen/, and the last one
  // runs after the rejected attempt was reverted. The artifact ACCUMULATES one `x` per run instead of
  // being recreated, so a revert that wiped the ignored directory cannot hide behind the next run
  // making the file again: the survivor carries one `x` per run so far, a recreated file carries one.
  const listingDir = mkdtempSync(join(tmpdir(), "devcycle-sweep-gen-"));
  const listing = join(listingDir, "gen-listing.txt");
  try {
    const res = runScript(
      SCRIPT,
      {
        files: ["a.js", "b.js", "c.js"],
        instruction: "append marker",
        verifyCommand: `mkdir -p gen && printf x >> gen/build.out && { echo "== run"; ls gen; echo "build=$(cat gen/build.out)"; } >> ${JSON.stringify(listing)}`,
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
    assert.match(
      afterRevert,
      new RegExp(`build=${"x".repeat(runs.length)}\\b`),
      `the verify's own artifact must SURVIVE the revert, not be recreated by the next run: after ${runs.length} runs the next verify saw:\n${afterRevert}`
    );
  } finally {
    cleanup(repo, listingDir);
  }
});

// Branch review round 4 (M1/M5): the purity check charges an ignored path the agent OVERWROTE just as
// it charges one the agent created, but a delete-only remedy cannot revert an overwrite — it destroys
// the dependency, cache or artifact the verifyCommand needs instead of putting back what was there.
// The sweep deletes only what the attempt created, leaves what it cannot restore, and names it in the
// skip reason instead of claiming a revert that did not happen. Both ignored shapes are overwritten
// here — a file inside the collapsed `gen/` entry and an individually reported `*.tmp` file — because
// only the created-path arm of the comparison had coverage before.
const VERIFY_SEEDS_IGNORED_FILES = (listing) =>
  `mkdir -p gen; [ -e gen/.seeded ] || { echo original > gen/keep.txt; echo original > scratch.tmp; : > gen/.seeded; }; ` +
  `{ echo "== run"; echo "keep=$(cat gen/keep.txt 2>/dev/null)"; echo "scratch=$(cat scratch.tmp 2>/dev/null)"; } >> ${JSON.stringify(listing)}`;

// Edits its target, and while editing b.js overwrites two ignored files the verify seeded earlier.
const OVERWRITE_IGNORED_EDITOR = `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
if (target === "b.js") {
  fs.writeFileSync("gen/keep.txt", "clobbered\\n");
  fs.writeFileSync("scratch.tmp", "clobbered\\n");
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "edited" } }));
`;

// Branch review round 6 (F1) closes what the round-4 remedy left open. Leaving the overwrite in place
// keeps the tree contaminated, and the verifyCommand is the ONLY gate on copying a file into the
// user's real repository — so a run that continues asks a verify it cannot trust to authorize that
// write. The sweep now stops at the overwrite: the attempt is skipped with a reason that says what
// could not be restored, and every remaining target is reported as not attempted.
test("an ignored file the agent overwrites stops the sweep — no later verify, and no later apply, in a tree it cannot restore", () => {
  const repo = repoWithThreeTargetsAndIgnores();
  const bin = makeFakeBin("claude", OVERWRITE_IGNORED_EDITOR);
  const listingDir = mkdtempSync(join(tmpdir(), "devcycle-sweep-overwrite-"));
  const listing = join(listingDir, "seed-listing.txt");
  try {
    const res = runScript(
      SCRIPT,
      { files: ["a.js", "b.js", "c.js"], instruction: "append marker", verifyCommand: VERIFY_SEEDS_IGNORED_FILES(listing) },
      { cwd: repo, binDirs: [bin] }
    );
    assert.equal(res.status, 1, `an unrestorable worktree is a hard stop with a report on stdout: ${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(report.skipped[0].file, "b.js");
    // Charged: an overwritten ignored path is collateral whether the agent created it or not.
    assert.match(report.skipped[0].reason, /modified files other than the target \(b\.js, gen\/keep\.txt, scratch\.tmp\)/);
    // And the reason says what the revert could not undo, rather than implying it undid it.
    assert.match(report.skipped[0].reason, /cannot restore what they held: gen\/keep\.txt, scratch\.tmp/);
    // The run ends there: c.js is never edited, never verified, and never copied into the real repo.
    assert.deepEqual(report.applied, ["a.js"]);
    assert.equal(report.skipped.length, 2, `b.js and the untried remainder: ${JSON.stringify(report.skipped)}`);
    assert.equal(report.skipped[1].file, "c.js");
    assert.match(report.skipped[1].reason, /not attempted/);
    assert.ok(
      !readFileSync(join(repo, "c.js"), "utf8").includes("swept"),
      "a verify run in a contaminated tree must never gate a write to the real repository"
    );
    // The verifyCommand appends one block per run, so the file holds every verify the sweep ran.
    // None of them may have seen the clobbered content — that is what "no verify is attributed to an
    // unrestorable tree" means on disk. Before round 6 the LAST run saw keep=clobbered, and c.js was
    // applied on the strength of it.
    const runs = readFileSync(listing, "utf8");
    assert.ok(
      !runs.includes("keep=clobbered") && !runs.includes("scratch=clobbered"),
      `no verifyCommand may run after the overwrite; the runs recorded were:\n${runs}`
    );
  } finally {
    cleanup(repo, listingDir, bin);
  }
});

// Round 4's other invariant — a created ignored path is deleted by the revert, an overwritten one is
// left on disk — used to be observed through the verify that ran after the revert. Round 6 stops the
// run at an overwrite, so no such verify exists any more and the sweep's worktree is gone before the
// run returns. The invariant is asserted directly against the functions that carry it instead.
//
// It calls `revertAttempt`, the production entry point, and never restates its created-vs-overwrote
// filter: an earlier version computed `changed.filter((c) => c.ignored && c.created)` in the test and
// handed the result to `revertWorktree`, so the one production line that can delete a pre-existing
// dependency, cache or artifact was never executed by any test and could be broadened to
// `(c) => c.ignored` with the whole suite still green (branch review round 8, F3).
test("the revert deletes the ignored paths an attempt created and leaves on disk the ones it overwrote", () => {
  const repo = repoWithTargetsAndIgnores(["a.js"]);
  const marker = `${repo}.window`;
  try {
    mkdirSync(join(repo, "gen"), { recursive: true });
    writeFileSync(join(repo, "gen", "keep.txt"), "original\n"); // a pre-existing artifact, as a verify leaves
    const known = sweep.knownPaths(repo);
    assert.ok(known.has("gen/keep.txt"), `precondition — the pre-existing artifact is known: ${[...known].join(", ")}`);

    const since = sweep.openWindow(marker); // the attempt starts here
    writeFileSync(join(repo, "gen", "keep.txt"), "clobbered\n"); // overwritten by the agent
    writeFileSync(join(repo, "gen", "made.txt"), "collateral\n"); // created by the agent
    writeFileSync(join(repo, "a.js"), "const a = 2;\n"); // the tracked edit
    const { changed } = sweep.changedPaths(repo, { since, known });
    const flag = (p) => changed.find((c) => c.path === p);
    assert.equal(flag("gen/keep.txt").created, false, "a path the previous pass saw was overwritten, not created");
    assert.equal(flag("gen/made.txt").created, true, "a path no previous pass saw is the attempt's own creation");

    const residue = sweep.revertAttempt(repo, changed);
    assert.ok(!existsSync(join(repo, "gen", "made.txt")), "the attempt's own ignored collateral is deleted");
    assert.ok(
      existsSync(join(repo, "gen", "keep.txt")),
      "a pre-existing ignored file the attempt only overwrote must survive the revert — deleting it would destroy, not restore"
    );
    assert.equal(
      readFileSync(join(repo, "gen", "keep.txt"), "utf8"),
      "clobbered\n",
      "and it keeps what the agent left in it: the sweep never held the original contents to put back"
    );
    assert.equal(readFileSync(join(repo, "a.js"), "utf8"), "const a = 1;\n", "the tracked edit is reverted");
    // What the revert could not undo, read back off disk — this is what makes the run stop.
    assert.deepEqual(residue, ["gen/keep.txt"]);
  } finally {
    cleanup(repo, marker);
  }
});

// Branch review round 6 (F2): `known` — the path set that decides whether an ignored charge is one the
// attempt CREATED (deletable) or one it merely overwrote (not) — was taken from the purity pass, which
// runs BEFORE the verifyCommand. Anything the verify wrote after that pass was missing from the next
// attempt's `known`, so an agent overwriting it was read as having created it and the revert deleted a
// pre-existing artifact the sweep never held — the exact destruction the created/overwrote split
// exists to prevent — while the skip reason called the attempt "reverted".
test("an ignored artifact the verify wrote after the purity pass is not deleted as the next attempt's own creation", () => {
  const repo = repoWithTargetsAndIgnores(["a.js", "b.js", "c.js", "d.js", "e.js"]);
  const flagDir = mkdtempSync(join(tmpdir(), "devcycle-sweep-late-"));
  // The verify writes gen/late.txt on the first run after c.js's editor — i.e. after c.js's purity
  // pass and before d.js's attempt, which is the only window in which the stale `known` differs.
  const flag = join(flagDir, "seed-now");
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
if (target === "c.js") fs.writeFileSync(${JSON.stringify(flag)}, "");
if (target === "d.js") fs.writeFileSync("gen/late.txt", "clobbered\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "edited" } }));
`
  );
  try {
    const res = runScript(
      SCRIPT,
      {
        files: ["a.js", "b.js", "c.js", "d.js", "e.js"],
        instruction: "append marker",
        verifyCommand: `mkdir -p gen; [ -e ${JSON.stringify(flag)} ] && [ ! -e gen/late.txt ] && printf original > gen/late.txt; true`,
      },
      { cwd: repo, binDirs: [bin] }
    );
    const report = JSON.parse(res.stdout);
    const skipOf = (f) => report.skipped.find((s) => s.file === f) ?? { reason: "<not skipped>" };
    assert.match(
      skipOf("d.js").reason,
      /cannot restore what they held: gen\/late\.txt/,
      `gen/late.txt existed before d.js's attempt, so the attempt cannot be charged with creating it: ${JSON.stringify(report)}`
    );
    // Consequently the tree is unrestorable and the run stops rather than verifying e.js in it.
    assert.equal(res.status, 1, `stderr: ${res.stderr}`);
    assert.deepEqual(report.applied, ["a.js", "b.js", "c.js"]);
    assert.match(skipOf("e.js").reason, /not attempted/);
    assert.ok(!readFileSync(join(repo, "e.js"), "utf8").includes("swept"));
  } finally {
    cleanup(repo, flagDir, bin);
  }
});

// Branch review round 8 (F2): the editor-failure exit reverted without ever running the purity
// pass. `git clean -fd` leaves ignored paths alone, so an ignored file a failed editor wrote stayed
// in the worktree, nothing was charged, nothing set `stop`, and every later target's verifyCommand
// ran in a tree carrying content the agent wrote and the sweep never removed — then gated a copy
// into the user's real repository, reported as exit 0. A failed attempt is now swept exactly like a
// rejected one: what it created is deleted, and residue that cannot be deleted ends the run. The
// three tests below drive a failed editor's three residue shapes — one it created, one it
// overwrote, and one a later attempt writes again after the sweep removed it.

// Editor that writes `body` and then fails on d.js, and appends the sweep marker (plus `others`)
// everywhere else. Six targets, so d.js lands after the pilot — post-pilot is where an editor
// failure skips one file and the run would otherwise carry on.
const EDITOR_FAILING_AFTER = (body, others = "") => `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
if (target === "d.js") {
  ${body}
  process.stdout.write(JSON.stringify({ is_error: true, result: "model refused" }));
} else {
  fs.appendFileSync(target, "// swept\\n");
  ${others}
  process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "edited" } }));
}
`;

const SIX_TARGETS = ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"];

test("an ignored file a failed editor created is deleted, so no later verify runs in a tree carrying it", () => {
  const repo = repoWithTargetsAndIgnores(SIX_TARGETS);
  const bin = makeFakeBin("claude", EDITOR_FAILING_AFTER(`fs.writeFileSync("gen/agent-junk.txt", "junk\\n");`));
  const listingDir = mkdtempSync(join(tmpdir(), "devcycle-sweep-failed-created-"));
  const listing = join(listingDir, "gen-listing.txt");
  try {
    const res = runScript(
      SCRIPT,
      {
        files: SIX_TARGETS,
        instruction: "append marker",
        // The verifyCommand owns `gen/`, so the failed editor's file lands inside a directory git
        // already collapses to one ignored entry — and every run appends what it can see in there.
        verifyCommand: `mkdir -p gen; { echo "== run"; ls gen; } >> ${JSON.stringify(listing)}`,
      },
      { cwd: repo, binDirs: [bin] }
    );
    const report = JSON.parse(res.stdout);
    const skipOf = (f) => report.skipped.find((s) => s.file === f) ?? { reason: "<not skipped>" };
    assert.match(
      skipOf("d.js").reason,
      /editor agent failed: editor agent error: model refused/,
      `precondition — d.js's editor fails after writing into gen/: ${JSON.stringify(report)}`
    );
    const runs = readFileSync(listing, "utf8");
    assert.ok(
      !runs.includes("agent-junk.txt"),
      `no verify may run in a tree still holding what the failed editor wrote; the runs recorded were:\n${runs}`
    );
    // Deleting it restores the tree, so the sweep may go on — and the later applies are honest.
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.deepEqual(report.applied, ["a.js", "b.js", "c.js", "e.js", "f.js"]);
  } finally {
    cleanup(repo, listingDir, bin);
  }
});

test("an ignored file a failed editor overwrote stops the sweep — the untried targets never reach the real repository", () => {
  const repo = repoWithTargetsAndIgnores(SIX_TARGETS);
  const bin = makeFakeBin("claude", EDITOR_FAILING_AFTER(`fs.writeFileSync("gen/keep.txt", "clobbered\\n");`));
  const listingDir = mkdtempSync(join(tmpdir(), "devcycle-sweep-failed-overwrote-"));
  const listing = join(listingDir, "seed-listing.txt");
  try {
    const res = runScript(
      SCRIPT,
      { files: SIX_TARGETS, instruction: "append marker", verifyCommand: VERIFY_SEEDS_IGNORED_FILES(listing) },
      { cwd: repo, binDirs: [bin] }
    );
    const report = JSON.parse(res.stdout);
    const skipOf = (f) => report.skipped.find((s) => s.file === f) ?? { reason: "<not skipped>" };
    assert.match(
      skipOf("d.js").reason,
      /editor agent failed: editor agent error: model refused/,
      `precondition — d.js's editor fails after clobbering gen/keep.txt: ${JSON.stringify(report)}`
    );
    // The sweep never held gen/keep.txt's contents, so it cannot put them back — and says so.
    assert.match(skipOf("d.js").reason, /cannot restore what they held: gen\/keep\.txt/, JSON.stringify(report));
    assert.equal(res.status, 1, `an unrestorable worktree is a hard stop with a report on stdout: ${res.stderr}`);
    assert.deepEqual(report.applied, ["a.js", "b.js", "c.js"]);
    assert.match(skipOf("e.js").reason, /not attempted/);
    assert.match(skipOf("f.js").reason, /not attempted/);
    for (const f of ["e.js", "f.js"]) {
      assert.ok(
        !readFileSync(join(repo, f), "utf8").includes("swept"),
        `${f} must never be copied into the real repository on the strength of a verify run in a contaminated tree`
      );
    }
    const runs = readFileSync(listing, "utf8");
    assert.ok(
      !runs.includes("keep=clobbered"),
      `no verifyCommand may run after the overwrite; the runs recorded were:\n${runs}`
    );
  } finally {
    cleanup(repo, listingDir, bin);
  }
});

// This test asserted the opposite of what it asserts now, and that inversion is the point of F2's
// fix. Before: the failed editor's `gen/orphan.txt` survived the revert, `processFile`'s refresh
// absorbed it into the next attempt's `known`, and the assertion was that e.js gets charged with
// OVERWRITING it and the run stops there. The stop was the only thing keeping the residue from
// reaching the real repository, and it fired only because e.js happened to touch that same path.
// Now the failed attempt's own creation is deleted before the next attempt opens its window, so
// e.js writing the same path CREATES it, is charged as ordinary collateral, and the revert removes
// it — the run continues because the tree really was restored.
test("a failed editor's ignored residue is gone before the next attempt, which is charged with creating the same path", () => {
  const repo = repoWithTargetsAndIgnores(SIX_TARGETS);
  const bin = makeFakeBin(
    "claude",
    EDITOR_FAILING_AFTER(
      `fs.mkdirSync("gen", { recursive: true });\n  fs.writeFileSync("gen/orphan.txt", "orphan\\n");`,
      `if (target === "e.js") { fs.mkdirSync("gen", { recursive: true }); fs.writeFileSync("gen/orphan.txt", "clobbered\\n"); }`
    )
  );
  try {
    const res = runScript(
      SCRIPT,
      { files: SIX_TARGETS, instruction: "append marker", verifyCommand: "true" },
      { cwd: repo, binDirs: [bin] }
    );
    const report = JSON.parse(res.stdout);
    const skipOf = (f) => report.skipped.find((s) => s.file === f) ?? { reason: "<not skipped>" };
    assert.match(
      skipOf("d.js").reason,
      /editor agent failed/,
      `precondition — d.js's editor fails after creating gen/orphan.txt: ${JSON.stringify(report)}`
    );
    // `gen/` is wholly ignored, so git names the directory rather than the file inside it.
    assert.match(
      skipOf("e.js").reason,
      /modified files other than the target \(e\.js, gen\/\); reverted/,
      `e.js created what it wrote, so the revert deletes it and the reason says "reverted": ${JSON.stringify(report)}`
    );
    assert.doesNotMatch(skipOf("e.js").reason, /cannot restore what they held/);
    assert.equal(res.status, 0, `nothing is left unrestorable, so the sweep runs to the end: ${res.stderr}`);
    assert.deepEqual(report.applied, ["a.js", "b.js", "c.js", "f.js"]);
    assert.match(readFileSync(join(repo, "f.js"), "utf8"), /\/\/ swept/);
    assert.ok(!readFileSync(join(repo, "e.js"), "utf8").includes("swept"), "the reverted attempt is not applied");
  } finally {
    cleanup(repo, bin);
  }
});

// Branch review round 4 (M2): git C-quotes any path outside the printable-ASCII range
// (`"caf\303\251/"`), and those octal escapes are not JSON — so a non-ASCII ignored DIRECTORY kept
// its quotes, stopped looking like a directory, and its contents were never inspected. That is
// exactly the cloak the collapsed-directory work existed to remove, for any repo that ignores a
// directory with a non-ASCII name.
function repoWithNonAsciiIgnoredDir() {
  const repo = makeRepo();
  for (const f of ["a.js", "b.js", "c.js"]) writeFileSync(join(repo, f), `const ${f[0]} = 1;\n`);
  writeFileSync(join(repo, ".gitignore"), "café/\n");
  commitAll(repo, "add files, ignore café/");
  return repo;
}

test("collateral inside an ignored directory with a non-ASCII name is caught, not cloaked by git's quoting", () => {
  const repo = repoWithNonAsciiIgnoredDir();
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
const target = prompt.match(/^file: (.+)$/m)[1];
fs.appendFileSync(target, "// swept\\n");
if (target === "b.js") fs.writeFileSync("café/collateral.js", "collateral\\n");
process.stdout.write(JSON.stringify({ is_error: false, structured_output: { changed: true, note: "edited" } }));
`
  );
  try {
    const res = runScript(
      SCRIPT,
      { files: ["a.js", "b.js", "c.js"], instruction: "append marker", verifyCommand: "mkdir -p café && touch café/build.out" },
      { cwd: repo, binDirs: [bin] }
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const report = JSON.parse(res.stdout);
    assert.equal(
      report.skipped.length,
      1,
      `the attempt that wrote into the non-ASCII ignored directory must be skipped: ${JSON.stringify(report.skipped)}`
    );
    assert.equal(report.skipped[0].file, "b.js");
    assert.match(report.skipped[0].reason, /modified files other than the target \(b\.js, café\/collateral\.js\); reverted/);
    assert.deepEqual(report.applied, ["a.js", "c.js"]);
  } finally {
    cleanup(repo);
  }
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
