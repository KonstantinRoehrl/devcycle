// scripts/claude-code-versions.mjs: the one reader of the Claude Code versions CI tests devcycle against.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { OWNER_FILE, PACKAGE, bumpCurrent, matrix, parseVersions, readVersions } from "../../scripts/claude-code-versions.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";

const owner = (floor, current) =>
  JSON.stringify({ private: true, description: "x", claudeCodeFloor: floor, devDependencies: { "@anthropic-ai/claude-code": current } }, null, 2) + "\n";

test("the owner file is .github/claude-code/package.json and names the npm package", () => {
  assert.equal(OWNER_FILE, ".github/claude-code/package.json");
  assert.equal(PACKAGE, "@anthropic-ai/claude-code");
});

test("parseVersions reads the floor and the current version", () => {
  assert.deepEqual(parseVersions(owner("2.1.287", "2.1.332")), { floor: "2.1.287", current: "2.1.332" });
});

test("parseVersions fails clearly on bad JSON, a missing field, a range, or a current below the floor", () => {
  assert.throws(() => parseVersions("{", "x.json"), /x\.json/);
  assert.throws(() => parseVersions(JSON.stringify({ devDependencies: { "@anthropic-ai/claude-code": "2.1.332" } })), /claudeCodeFloor/);
  assert.throws(() => parseVersions(owner("2.1", "2.1.332")), /claudeCodeFloor/);
  assert.throws(() => parseVersions(JSON.stringify({ claudeCodeFloor: "2.1.287" })), /@anthropic-ai\/claude-code/);
  assert.throws(() => parseVersions(owner("2.1.287", "^2.1.332")), /exact/);
  assert.throws(() => parseVersions(owner("2.1.300", "2.1.299")), /below the floor/);
});

test("matrix is the floor then the current version, each once", () => {
  assert.deepEqual(matrix({ floor: "2.1.287", current: "2.1.332" }), ["2.1.287", "2.1.332"]);
  assert.deepEqual(matrix({ floor: "2.1.300", current: "2.1.300" }), ["2.1.300"]);
});

test("bumpCurrent changes only the current version's string", () => {
  const before = owner("2.1.287", "2.1.332");
  const after = bumpCurrent(before, "2.1.340");
  assert.equal(after, before.replace('"2.1.332"', '"2.1.340"'));
  assert.deepEqual(parseVersions(after), { floor: "2.1.287", current: "2.1.340" });
  assert.throws(() => bumpCurrent(before, "latest"), /exact/);
});

test("readVersions reads the owner file under a root, and the repo's own owner file parses", () => {
  const root = makeTempDir("devcycle-cc-versions-");
  try {
    writeInto(root, ".github/claude-code/package.json", owner("2.1.287", "2.1.332"));
    assert.deepEqual(readVersions(root), { floor: "2.1.287", current: "2.1.332" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(readVersions().floor, "2.1.287");
});

test("the CLI prints the floor, the current version and the matrix JSON, and refuses anything else", () => {
  const run = (...args) => spawnSync(process.execPath, ["scripts/claude-code-versions.mjs", ...args], { encoding: "utf8" });
  const own = JSON.parse(readFileSync(".github/claude-code/package.json", "utf8"));
  assert.equal(run("floor").stdout.trim(), own.claudeCodeFloor);
  assert.equal(run("current").stdout.trim(), own.devDependencies["@anthropic-ai/claude-code"]);
  assert.deepEqual(JSON.parse(run("matrix").stdout), [own.claudeCodeFloor, own.devDependencies["@anthropic-ai/claude-code"]]);
  assert.equal(run("nope").status, 2);
});

test("validate.yml's matrix and Canary's pin re-run read the versions through the script", () => {
  const validate = readFileSync(".github/workflows/validate.yml", "utf8");
  assert.match(validate, /node scripts\/claude-code-versions\.mjs matrix/);
  assert.match(validate, /cli: \$\{\{ fromJSON\(needs\.versions\.outputs\.matrix\) \}\}/);
  assert.match(validate, /^ {4}needs: versions$/m);
  const canary = readFileSync(".github/workflows/canary.yml", "utf8");
  assert.match(canary, /pin="\$\(node scripts\/claude-code-versions\.mjs current\)"/);
  assert.doesNotMatch(canary, /canary-report\.mjs pin/);
});
