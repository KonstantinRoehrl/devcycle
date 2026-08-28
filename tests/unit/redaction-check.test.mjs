import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { makeRepo, sh } from "./helpers.mjs";

const SCRIPT = join(process.cwd(), "scripts/redaction-check.mjs");
const HASHES = join(process.cwd(), "scripts/redaction-hashes.txt");

// Every leaky fixture below is assembled from fragments so this file — which is itself
// tracked and scanned by the real run — never carries a literal a pattern would match.
const SLASH = "/";
const MAC_HOME = `${SLASH}Users${SLASH}someone`;
const LINUX_HOME = `${SLASH}home${SLASH}someone`;
const WINDOWS_HOME = "C:\\Users\\someone";
const SESSION_ID = ["0f9a1b2c", "3d4e", "5f60", "7a8b", "9c0d1e2f3a4b"].join("-");
const TRANSCRIPT_SLUG = `projects${SLASH}-Users-someone-Programming-thing`;

function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "redaction-check-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content, "utf8");
  return dir;
}

function run(dir, extra = []) {
  return execFileSync("node", [SCRIPT, "--dir", dir, ...extra], { encoding: "utf8" });
}

function assertFlags(files, expected, extra = []) {
  const dir = makeFixture(files);
  try {
    let stderr = "";
    assert.throws(
      () => run(dir, extra),
      (err) => {
        stderr = err.stderr ?? "";
        return true;
      },
    );
    assert.match(stderr, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertPasses(files, extra = []) {
  const dir = makeFixture(files);
  try {
    assert.match(run(dir, extra), /redaction: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("flags an absolute macOS home path", () => {
  assertFlags({ "a.md": `See ${MAC_HOME}/Programming/thing for details.\n` }, /home-directory path/);
});

test("flags an absolute Linux home path", () => {
  assertFlags({ "a.md": `Ran from ${LINUX_HOME}/work/thing last night.\n` }, /home-directory path/);
});

test("flags an absolute Windows home path", () => {
  assertFlags({ "a.md": `Ran from ${WINDOWS_HOME}\\work\\thing last night.\n` }, /home-directory path/);
});

test("flags a session id", () => {
  assertFlags({ "a.md": `Session ${SESSION_ID} carried the run.\n` }, /session id/);
});

test("flags a transcript path carrying an escaped project directory", () => {
  assertFlags({ "a.md": `Mined .claude/${TRANSCRIPT_SLUG}/x.jsonl\n` }, /local project directory/);
});

test("names the file and the class but never echoes the matched text", () => {
  const dir = makeFixture({ "leaky.md": `Session ${SESSION_ID}\n` });
  try {
    let stderr = "";
    assert.throws(
      () => run(dir),
      (err) => {
        stderr = err.stderr ?? "";
        return true;
      },
    );
    assert.match(stderr, /leaky\.md/);
    assert.ok(!stderr.includes(SESSION_ID), "the failure message must not reprint the leaked value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes placeholder forms that carry no machine identity", () => {
  assertPasses({
    "a.md": "Run it from ~/.claude/plugins and set $HOME/.config as the target.\n",
    "b.md": "The transcript lives under .claude/projects/<escaped-cwd>/<session-id>.jsonl\n",
  });
});

test("passes hex strings that are not session ids", () => {
  assertPasses({
    "a.md": "Pinned to 3d3c42e5aac5ba805825da76410c181273ba90b1 (v7.0.1), released 2026-08-06.\n",
    "b.md": "Version 0.11.1 shipped; the tag is devcycle--v0.11.1.\n",
  });
});

// The no-argument path: a `git archive` extraction or an unpacked tarball is not a git
// checkout, and the gate has to keep working there rather than dying on `git ls-files`.
const runInCwd = (cwd) =>
  spawnSync(process.execPath, [SCRIPT, "--hashes", HASHES], { encoding: "utf8", cwd });

test("scans the working tree when run outside a git checkout, and still catches a leak", () => {
  const dir = makeFixture({ "a.md": `See ${MAC_HOME}/Programming/thing for details.\n` });
  try {
    const res = runInCwd(dir);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.doesNotMatch(res.stderr, /not a git repository/);
    assert.match(res.stderr, /home-directory path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outside a git checkout it discloses the fallback and still skips node_modules", () => {
  const dir = makeFixture({ "a.md": "Run it from ~/.claude/plugins.\n" });
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "leaky.md"), `Session ${SESSION_ID}\n`, "utf8");
  try {
    const res = runInCwd(dir);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /redaction: ok/);
    assert.match(res.stderr, /not a git checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inside a git checkout it still scans git's file list, not the whole tree", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "tracked.md"), "Nothing sensitive here at all.\n", "utf8");
  sh("git", ["add", "tracked.md"], { cwd: repo });
  // Untracked, so git's own file list excludes it: a tree walk would flag it.
  writeFileSync(join(repo, "untracked.md"), `Session ${SESSION_ID}\n`, "utf8");
  try {
    const res = runInCwd(repo);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /redaction: ok/);
    assert.doesNotMatch(res.stderr, /not a git checkout/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a run that scanned no file at all fails instead of reporting ok", () => {
  const dir = makeFixture({});
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--hashes", HASHES], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /no files to scan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --file: the same engine, one more caller. An untracked draft has no place in `git ls-files`
// and is not under any --dir, so without this flag the issue-draft screen could not run at all.
function runFile(path) {
  return execFileSync("node", [SCRIPT, "--file", path], { encoding: "utf8" });
}

test("--file flags a single file carrying a home-directory path", () => {
  const dir = makeFixture({ "draft.md": `body\n${MAC_HOME}${SLASH}notes\n` });
  try {
    let stderr = "";
    assert.throws(
      () => runFile(join(dir, "draft.md")),
      (err) => { stderr = err.stderr ?? ""; return true; },
    );
    assert.match(stderr, /contains an absolute home-directory path/);
    // The failure names the class and never reprints what it matched.
    assert.ok(!stderr.includes("someone"), "the failure message reprinted the match");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--file passes a clean file", () => {
  const dir = makeFixture({ "draft.md": "plugin version 0.12.0, profile thorough, 4 events\n" });
  try {
    assert.match(runFile(join(dir, "draft.md")), /redaction: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--file on a missing path fails rather than reporting a clean scan", () => {
  const dir = makeFixture({});
  try {
    let stderr = "";
    assert.throws(
      () => runFile(join(dir, "does-not-exist.md")),
      (err) => { stderr = err.stderr ?? ""; return true; },
    );
    assert.match(stderr, /no files to scan|cannot read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--file takes precedence over --dir rather than silently scanning both", () => {
  const dir = makeFixture({ "clean.md": "nothing here\n", "dirty.md": `${MAC_HOME}${SLASH}x\n` });
  try {
    assert.match(
      execFileSync("node", [SCRIPT, "--file", join(dir, "clean.md"), "--dir", dir], { encoding: "utf8" }),
      /redaction: ok/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The playbook invokes this script by an absolute ${CLAUDE_PLUGIN_ROOT} path from inside the
// *user's own repo*, so cwd is never this repo's root. The default deny-list path must resolve
// against the script's own location, not cwd, or every such invocation dies on ENOENT.
test("--file works when the caller's cwd is not this repo (default --hashes path)", () => {
  const dir = makeFixture({ "draft.md": "plugin version 0.12.0, profile thorough, 4 events\n" });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--file", join(dir, "draft.md")], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /redaction: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A valueless --file (it was the last token on the command line) must not silently widen the
// scan to the whole git corpus and report a clean draft that was never actually read.
test("--file with no value fails naming the missing argument, rather than scanning the whole corpus", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--file"], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--file/);
});

// --dir is the playbook's privacy gate over gitignored files that `git ls-files` cannot see
// (playbooks/finishing-the-cycle.md uses `--dir .devcycle`). A silent fallback to the whole
// git corpus there would report success over a file set that structurally excludes the very
// files the gate exists to screen.
test("--dir with no value fails naming the missing argument, rather than scanning the whole corpus", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir"], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--dir/);
});

test("--dir immediately followed by another flag fails naming the missing argument", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir", "--hashes", HASHES], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--dir/);
});

// --auto-redact takes no value, but while the parser treated every flag as value-taking it
// swallowed whatever followed. `--dir <clean> --auto-redact <leaky>` therefore scanned only the
// clean dir and printed `redaction: ok` while the named leaky corpus was never opened -- a false
// green on the privacy gate itself. The token must fall through to the positional refusal.
test("a valueless flag never swallows a corpus, leaving it unscanned under a green report", () => {
  const clean = makeFixture({ "a.md": "Nothing sensitive here at all.\n" });
  const leaky = makeFixture({ "b.md": `Session ${SESSION_ID} carried the run.\n` });
  try {
    const res = spawnSync(
      process.execPath,
      [SCRIPT, "--dir", clean, "--hashes", HASHES, "--auto-redact", leaky],
      { encoding: "utf8", cwd: process.cwd() },
    );
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.doesNotMatch(res.stdout, /redaction: ok/);
    assert.match(res.stderr, /unexpected argument/);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(leaky, { recursive: true, force: true });
  }
});

// The same slip with no --dir alongside errors today only because --auto-redact refuses to rewrite
// an unnamed corpus -- and it then sends the operator looking for the --dir they did type.
test("a bare corpus after --auto-redact is named as the unexpected token", () => {
  const dir = makeFixture({ "a.md": "Nothing sensitive here at all.\n" });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--auto-redact", dir], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /unexpected argument/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --hashes, by contrast, does take a path and must keep doing so: the playbook invokes this script
// from inside the user's own repo and names the shipped deny-list explicitly.
test("--hashes still takes its path, and is not swept up as a valueless flag", () => {
  const dir = makeFixture({ "a.md": "Nothing sensitive here at all.\n" });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--hashes", HASHES], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /redaction: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --hashes with no value falls back to the shipped deny-list today, which is benign, but it is
// the same silent widening as --file/--dir and must fail the same way for consistency.
test("--hashes with no value fails naming the missing argument, rather than falling back silently", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir", process.cwd(), "--hashes"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--hashes/);
});

// `--file "$draft"` for an unset shell variable expands to `--file ""` — an empty string, not a
// missing argument — and must fail the same way a missing value does rather than falling through
// to the whole-corpus scan.
test("--file with an empty-string value fails the same way a missing value does", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--file", ""], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--file/);
});

test("--file with a whitespace-only value fails the same way a missing value does", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--file", "   "], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--file/);
});

test("--dir with an empty-string value fails the same way a missing value does", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir", ""], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--dir/);
});

test("--hashes with an empty-string value fails the same way a missing value does", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir", process.cwd(), "--hashes", ""], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--hashes/);
});

// --flag=value form: the same guard as the space form, not a separate code path. `--file=/tmp/x`
// is a single token that must still be recognised as --file, not silently widened to the whole
// git corpus (the bug this task fixes).
test("--dir=<path> (equals form) is recognised and scans the named directory", () => {
  const dir = makeFixture({ "a.md": `See ${MAC_HOME}/Programming/thing for details.\n` });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, `--dir=${dir}`, "--hashes", HASHES], { encoding: "utf8" });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /home-directory path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--file=<path> (equals form) is recognised and flags a leak", () => {
  const dir = makeFixture({ "draft.md": `body\n${MAC_HOME}${SLASH}notes\n` });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, `--file=${join(dir, "draft.md")}`], { encoding: "utf8" });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /contains an absolute home-directory path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--hashes=<path> (equals form) is recognised and uses the named deny-list", () => {
  const term = "forbiddenword";
  const dir = makeFixture({
    "a.md": `This mentions ${term} once.\n`,
    "hashes.txt": `${createHash("sha256").update(term).digest("hex")}\n`,
  });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--dir", dir, `--hashes=${join(dir, "hashes.txt")}`], {
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /deny-listed term/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--file=<clean path> (equals form) passes", () => {
  const dir = makeFixture({ "draft.md": "plugin version 0.12.0, profile thorough, 4 events\n" });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, `--file=${join(dir, "draft.md")}`], { encoding: "utf8" });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /redaction: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--file= with an empty value (equals form) fails naming --file, rather than scanning the whole corpus", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--file="], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--file/);
});

test("--file=<whitespace> (equals form) fails naming --file", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--file=   "], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--file/);
});

test("--dir= with an empty value (equals form) fails naming --dir", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir="], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--dir/);
});

test("--hashes= with an empty value (equals form) fails naming --hashes", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--dir", process.cwd(), "--hashes="], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /--hashes/);
});

// An unrecognised flag (a typo such as `--fil` for `--file`) must not fall through to scanning
// the whole git corpus and reporting a false green — the same silent-widening class the guard
// above fixes, reached by a different mistake. See the task report for why this is a hard error.
test("an unrecognised flag fails naming the flag, rather than falling through to the whole corpus", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--fil", "x"], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /unrecognised flag --fil$/m,
    "the message must name the flag the caller actually typed — /--fil/ alone is satisfied by --file");
});

test("an unrecognised flag in equals form fails naming the flag", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--fil=x"], { encoding: "utf8", cwd: process.cwd() });
  assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /unrecognised flag --fil$/m,
    "the message must name the flag the caller actually typed — /--fil/ alone is satisfied by --file");
});

// Dropping the flag name entirely is the same false green with nothing misspelled to notice:
// `redaction-check.mjs .devcycle` is the natural slip for `--dir .devcycle`, and this is the
// privacy gate — the bare token used to be discarded, so the run silently scanned `git ls-files`
// (which cannot see gitignored `.devcycle/`) and printed `redaction: ok` about a corpus it never
// opened.
test("a bare path fails naming the token, rather than scanning git ls-files and printing ok", () => {
  const dir = makeFixture({ "leaky.md": `path ${MAC_HOME}/secret/notes.md\n` });
  try {
    const res = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", cwd: process.cwd() });
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.doesNotMatch(res.stdout, /redaction: ok/);
    assert.ok(
      res.stderr.includes(`redaction-check: unexpected argument "${dir}"`),
      `stderr must name the token it refused, got: ${res.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --auto-redact: the same scan engine, but it first rewrites every detected class in place,
// then re-scans so the run's exit code proves the POST-rewrite state is clean.
test("--auto-redact rewrites every detected class in place, then the dir scans clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "redact-"));
  const f = join(dir, "artifact.md");
  // Fixtures assembled from the fragment constants above, never literal patterns, so this test
  // file does not itself trip the tracked-tree redaction screen CI runs.
  writeFileSync(f, [
    `path ${MAC_HOME}/secret/notes.md`,
    `session ${SESSION_ID}`,
    `dir ${TRANSCRIPT_SLUG}`,
    "",
  ].join("\n"));
  const runCP = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const red = runCP(["--auto-redact", "--dir", dir]);
  assert.equal(red.status, 0, red.stderr);
  const after = readFileSync(f, "utf8");
  assert.ok(!after.includes(MAC_HOME));
  assert.ok(!after.includes(SESSION_ID));
  assert.ok(!after.includes(TRANSCRIPT_SLUG));
  assert.match(after, /<redacted-path>/);
  assert.match(after, /<redacted-session>/);
  assert.match(after, /<redacted-project>/);
  const rescan = runCP(["--dir", dir]);
  assert.equal(rescan.status, 0, rescan.stdout + rescan.stderr);
  rmSync(dir, { recursive: true, force: true });
});

test("--auto-redact leaves a clean file byte-identical (no gratuitous rewrites)", () => {
  const dir = mkdtempSync(join(tmpdir(), "redact-"));
  const f = join(dir, "clean.md");
  const original = "plugin version 0.12.0, profile thorough, 4 events\n";
  writeFileSync(f, original);
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--auto-redact", "--dir", dir], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(f, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--auto-redact redacts a deny-listed term in place without ever printing it, then scans clean", () => {
  const term = "forbiddenword";
  const dir = makeFixture({
    "a.md": `This mentions ${term} once.\n`,
    "hashes.txt": `${createHash("sha256").update(term).digest("hex")}\n`,
  });
  try {
    const hashes = join(dir, "hashes.txt");
    const red = spawnSync(process.execPath, [SCRIPT, "--auto-redact", "--dir", dir, "--hashes", hashes], { encoding: "utf8" });
    assert.equal(red.status, 0, red.stderr);
    const after = readFileSync(join(dir, "a.md"), "utf8");
    assert.ok(!after.includes(term), "the deny-listed term must be rewritten out of the file");
    assert.match(after, /<redacted-term>/);
    assert.ok(!red.stderr.includes(term), "the summary must never reprint the deny-listed term");
    const rescan = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--hashes", hashes], { encoding: "utf8" });
    assert.equal(rescan.status, 0, rescan.stdout + rescan.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--auto-redact without --dir or --file is refused (never rewrites the whole tracked tree)", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--auto-redact"], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--auto-redact requires an explicit --dir or --file/);
});

test("--auto-redact reports the spans it rewrote, per file, so a false-positive rewrite is visible", () => {
  const dir = mkdtempSync(join(tmpdir(), "redact-"));
  writeFileSync(join(dir, "artifact.md"), `path ${MAC_HOME}/x and session ${SESSION_ID}\n`);
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--auto-redact", "--dir", dir], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /auto-redacted \d+ span\(s\) across 1 file\(s\)/);
    assert.match(res.stderr, /artifact\.md \(\d+\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A --dir that names nothing, or names a file rather than a directory, must fail with this
// script's own diagnostic — not a raw ENOENT/ENOTDIR stack thrown out of readdirSync in walk().
test("redaction-check: --dir on a nonexistent path prints a named diagnostic, not a stack", () => {
  const res = spawnSync(
    process.execPath,
    [SCRIPT, "--dir", join(tmpdir(), "c9-redaction-does-not-exist-xyz"), "--hashes", HASHES],
    { encoding: "utf8", cwd: process.cwd() },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /redaction-check: --dir .* is not a directory/);
  assert.doesNotMatch(res.stderr, /at \w+.*\(.*:\d+:\d+\)/); // no Node stack frame
});

test("redaction-check: --dir naming a file (not a directory) prints the named diagnostic", () => {
  const base = mkdtempSync(join(tmpdir(), "c9-redaction-"));
  const f = join(base, "afile.txt");
  writeFileSync(f, "hello\n");
  try {
    const res = spawnSync(process.execPath, [SCRIPT, "--dir", f, "--hashes", HASHES], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /redaction-check: --dir .* is not a directory/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("--advisory-identity: machine identity is reported to stderr but does not fail", () => {
  const dir = makeFixture({ "ev.txt": `ran in ${MAC_HOME}/proj\n` });
  try {
    const out = spawnSync("node", [SCRIPT, "--dir", dir, "--advisory-identity"], { encoding: "utf8" });
    assert.equal(out.status, 0, "advisory machine identity must not fail the gate");
    assert.match(out.stderr, /advisory/i);
    assert.match(out.stderr, /absolute home-directory path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--advisory-identity does NOT downgrade a deny-listed term", () => {
  const token = "denyword";
  const hdir = mkdtempSync(join(tmpdir(), "rh-"));
  const hashesFile = join(hdir, "h.txt");
  writeFileSync(hashesFile, createHash("sha256").update(token).digest("hex") + "\n");
  const dir = makeFixture({ "a.md": `contains ${token} here\n` });
  try {
    const out = spawnSync("node", [SCRIPT, "--dir", dir, "--hashes", hashesFile, "--advisory-identity"], { encoding: "utf8" });
    assert.equal(out.status, 1, "a deny-listed term must hard-fail even under --advisory-identity");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(hdir, { recursive: true, force: true });
  }
});

test("inline `redaction-allow` exempts a single line from machine-identity classes", () => {
  const dir = makeFixture({ "doc.md": `example ${MAC_HOME}/x <!-- redaction-allow -->\nreal ${MAC_HOME}/y\n` });
  try {
    const out = spawnSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" });
    assert.equal(out.status, 1, "the un-marked second line must still flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const clean = makeFixture({ "doc.md": `example ${MAC_HOME}/x <!-- redaction-allow -->\n` });
  try {
    const out2 = spawnSync("node", [SCRIPT, "--dir", clean], { encoding: "utf8" });
    assert.equal(out2.status, 0, "a lone allow-marked line must pass");
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
});

test("inline `redaction-allow` never exempts a deny-listed term", () => {
  const term = "quarantineword";
  const hdir = mkdtempSync(join(tmpdir(), "rh-"));
  const hashesFile = join(hdir, "h.txt");
  writeFileSync(hashesFile, createHash("sha256").update(term).digest("hex") + "\n");
  const dir = makeFixture({ "a.md": `contains ${term} here <!-- redaction-allow -->\n` });
  try {
    const out = spawnSync("node", [SCRIPT, "--dir", dir, "--hashes", hashesFile], { encoding: "utf8" });
    assert.equal(out.status, 1, "a deny-listed term must still fail even on a redaction-allow-marked line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(hdir, { recursive: true, force: true });
  }
});

test("still flags a deny-listed term, read from the hashes file", () => {
  const term = "forbiddenword";
  const dir = makeFixture({
    "a.md": `This mentions ${term} once.\n`,
    "hashes.txt": `${createHash("sha256").update(term).digest("hex")}\n`,
  });
  try {
    let stderr = "";
    assert.throws(
      () => execFileSync("node", [SCRIPT, "--dir", dir, "--hashes", join(dir, "hashes.txt")], {
        encoding: "utf8",
      }),
      (err) => {
        stderr = err.stderr ?? "";
        return true;
      },
    );
    assert.match(stderr, /deny-listed term/);
    assert.ok(!stderr.includes(term), "the failure message must not reprint the deny-listed term");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
