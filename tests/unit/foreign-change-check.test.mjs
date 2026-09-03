// #167: distinguish a sibling's uncommitted edit from the task's own dirt in a shared checkout.
// Builds a throwaway git repo per case (no dependence on this repo's own tree), dirties files, and
// asserts the exit code and the named foreign paths.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "foreign-change-check.mjs");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fcc-"));
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a0\n");
  writeFileSync(join(dir, "b.txt"), "b0\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, git };
}
function run(dir, files) {
  return spawnSync("node", [SCRIPT, ...files], { cwd: dir, encoding: "utf8" });
}

test("only the task's own files dirty → clean, exit 0", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const r = run(dir, ["a.txt"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /clean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a modified file outside the task's set → non-zero, names the foreign path", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeFileSync(join(dir, "b.txt"), "b1\n"); // sibling's edit
    const r = run(dir, ["a.txt"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /b\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an untracked foreign file → non-zero, names it", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "c.txt"), "c\n"); // untracked, not in the task set
    const r = run(dir, ["a.txt"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /c\.txt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normalization: backtick/punctuation-wrapped task tokens still match", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const r = run(dir, ["`a.txt`,"]); // planners wrap paths in code spans / punctuation
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /clean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a clean tree → clean, exit 0", () => {
  const { dir } = makeRepo();
  try {
    const r = run(dir, ["a.txt"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Regression (QC2, review round 1): a real dirty path whose basename collides with the plan
// grammar — a file literally named `Test`/`Create`/`Modify` or the `-` placeholder sentinel —
// must NOT be silently dropped and reported "clean". normalizeFileToken returns null for those
// tokens (correct for parsing a task's **Files:** prose, wrong for classifying real fs paths).
test("a foreign untracked file named `Test` → non-zero, names it (not silently dropped)", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "Test"), "sibling\n"); // untracked, collides with a plan LABEL
    const r = run(dir, ["a.txt"]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok((r.stdout + r.stderr).split("\n").includes("foreign-change-check: Test"),
      r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a foreign untracked file named `-` → non-zero, names it (not silently dropped)", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "-"), "sibling\n"); // untracked, collides with the placeholder sentinel
    const r = run(dir, ["a.txt"]);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok((r.stdout + r.stderr).split("\n").includes("foreign-change-check: -"),
      r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a TASK file named `Test` dirty → clean, exit 0 (its own dirt, not foreign)", () => {
  const { dir } = makeRepo();
  try {
    writeFileSync(join(dir, "Test"), "own\n"); // this task's own file, passed as a task arg
    const r = run(dir, ["a.txt", "Test"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /clean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
