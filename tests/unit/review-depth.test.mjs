import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { commitAll, makeRepo, sh, writeInto } from "./helpers.mjs";
import {
  PANEL_FILE_THRESHOLD, PANEL_LINE_THRESHOLD, isExcluded, measureRange, pickDepth,
} from "../../scripts/review-depth.mjs";

const SCRIPT = join(process.cwd(), "scripts/review-depth.mjs");
const run = (args, cwd) => spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

// main gains a file after topic is cut, so a diff taken from main itself rather than the merge
// base would count that file as a deletion on topic.
function branchRepo(topicFiles) {
  const dir = makeRepo();
  writeInto(dir, "old.txt", lines(5));
  commitAll(dir, "base");
  sh("git", ["checkout", "-qb", "topic"], { cwd: dir });
  for (const [path, text] of Object.entries(topicFiles)) writeInto(dir, path, text);
  commitAll(dir, "topic work");
  sh("git", ["checkout", "-q", "main"], { cwd: dir });
  writeInto(dir, "main-only.txt", lines(10));
  commitAll(dir, "main moves on");
  return dir;
}

test("isExcluded: lockfiles by basename and generated files by name or directory", () => {
  for (const path of ["package-lock.json", "web/yarn.lock", "go.sum", "Cargo.lock", "app.min.js", "site.min.css",
    "bundle.js.map", "api/schema.generated.ts", "dist/index.js", "pkg/build/out.o", "vendor/lib.rb", "node_modules/x/i.js"])
    assert.equal(isExcluded(path), true, path);
  for (const path of ["src/index.js", "src/builder.ts", "docs/dist.md", "lockfile.md", "minimal.js", "build.gradle"])
    assert.equal(isExcluded(path), false, path);
});

test("pickDepth: lean and thorough are fixed whatever the size", () => {
  assert.deepEqual(pickDepth({ profile: "lean", changedLines: 5000, changedFiles: 90 }), { depth: "single", reason: "profile lean" });
  assert.deepEqual(pickDepth({ profile: "thorough", changedLines: 1, changedFiles: 1 }), { depth: "panel", reason: "profile thorough" });
});

test("pickDepth: standard goes to panel only past a threshold", () => {
  assert.equal(PANEL_LINE_THRESHOLD, 400);
  assert.equal(PANEL_FILE_THRESHOLD, 15);
  assert.deepEqual(pickDepth({ profile: "standard", changedLines: 400, changedFiles: 15 }),
    { depth: "single", reason: "400 changed lines, 15 files" });
  assert.deepEqual(pickDepth({ profile: "standard", changedLines: 401, changedFiles: 1 }),
    { depth: "panel", reason: "401 changed lines > 400" });
  assert.deepEqual(pickDepth({ profile: "standard", changedLines: 10, changedFiles: 16 }),
    { depth: "panel", reason: "16 changed files > 15" });
  assert.throws(() => pickDepth({ profile: "deep", changedLines: 1, changedFiles: 1 }), /unknown profile "deep"/);
});

test("measureRange: diffs from the merge base and leaves out lockfiles and generated files", () => {
  const dir = branchRepo({ "src/a.js": lines(3), "package-lock.json": lines(50), "dist/bundle.js": lines(20), "img.bin": "\0\x01\x02" });
  sh("git", ["checkout", "-q", "topic"], { cwd: dir });
  sh("git", ["mv", "old.txt", "new.txt"], { cwd: dir });
  commitAll(dir, "rename");
  sh("git", ["checkout", "-q", "main"], { cwd: dir });
  // src/a.js (3 lines), img.bin (binary, 0 lines) and the pure rename (0 lines) count.
  assert.deepEqual(measureRange({ base: "main", branch: "topic", cwd: dir }), { changedLines: 3, changedFiles: 3, excludedFiles: 2 });
});

test("measureRange: a name only origin/ resolves is spelled origin/<name>", () => {
  const dir = branchRepo({ "src/a.js": lines(3) });
  sh("git", ["update-ref", "refs/remotes/origin/feature", "topic"], { cwd: dir });
  assert.deepEqual(measureRange({ base: "main", branch: "feature", cwd: dir }), { changedLines: 3, changedFiles: 1, excludedFiles: 0 });
});

test("measureRange: a bad ref or unrelated histories throw instead of measuring zero", () => {
  const dir = branchRepo({ "src/a.js": lines(3) });
  assert.throws(() => measureRange({ base: "main", branch: "nope", cwd: dir }), /neither "nope" nor "origin\/nope" resolves/);
  assert.throws(() => measureRange({ base: "main;rm", branch: "topic", cwd: dir }), /"main;rm" is not a valid ref name/);
  assert.throws(() => measureRange({ base: "-x", branch: "topic", cwd: dir }), /"-x" is not a valid ref name/);
  sh("git", ["checkout", "-q", "--orphan", "lonely"], { cwd: dir });
  writeInto(dir, "alone.txt", lines(2));
  commitAll(dir, "unrelated root");
  assert.throws(() => measureRange({ base: "main", branch: "lonely", cwd: dir }), /git merge-base main lonely failed/);
});

test("CLI: lean and thorough print their fixed depth without touching git", () => {
  const notARepo = makeTempDir("review-depth-");
  const lean = run(["--base", "nope", "--branch", "nope", "--profile", "lean"], notARepo);
  assert.equal(lean.status, 0, lean.stderr);
  assert.equal(lean.stdout, "single (profile lean)\n");
  const thorough = run(["--profile", "thorough", "--json"], notARepo);
  assert.equal(thorough.status, 0, thorough.stderr);
  assert.deepEqual(JSON.parse(thorough.stdout), {
    depth: "panel", reason: "profile thorough", profile: "thorough", changedLines: null, changedFiles: null, excludedFiles: null,
  });
});

test("CLI: standard measures the range and names its reason", () => {
  const small = branchRepo({ "src/a.js": lines(3) });
  const r = run(["--base", "main", "--branch", "topic", "--profile", "standard"], small);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "single (3 changed lines, 1 file; profile standard)\n");
  const big = branchRepo({ "src/big.js": lines(401) });
  const json = run(["--base", "main", "--branch", "topic", "--profile", "standard", "--json"], big);
  assert.deepEqual(JSON.parse(json.stdout), {
    depth: "panel", reason: "401 changed lines > 400", profile: "standard", changedLines: 401, changedFiles: 1, excludedFiles: 0,
  });
  assert.equal(run(["--base", "main", "--branch", "topic", "--profile", "standard"], big).stdout,
    "panel (401 changed lines > 400; profile standard)\n");
});

test("CLI: every failure exits 1 with what failed and what to do", () => {
  const dir = branchRepo({ "src/a.js": lines(3) });
  const cases = [
    [["--base", "main", "--branch", "nope", "--profile", "standard"], /^review-depth: measuring main\.\.nope failed: .* — fetch the missing ref, or take the profile's branch-review row\n$/],
    [["--base", "main", "--profile", "standard"], /^review-depth: profile standard measures a diff, so it needs --base and --branch — run review-depth\.mjs/],
    [["--base", "main", "--branch", "topic", "--profile", "deep"], /^review-depth: --profile must be one of lean, standard, thorough, got "deep" — pass the knobs: line's profile\n$/],
    [["--depth", "panel", "--profile", "lean"], /^review-depth: unrecognised flag --depth — run review-depth\.mjs/],
    [["--base", "", "--branch", "topic", "--profile", "standard"], /^review-depth: --base requires a value — run review-depth\.mjs/],
  ];
  for (const [args, stderr] of cases) {
    const r = run(args, dir);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, stderr);
  }
});
