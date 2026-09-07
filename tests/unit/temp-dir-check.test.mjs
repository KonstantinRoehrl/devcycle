import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const CHECK = fileURLToPath(new URL("../../scripts/temp-dir-check.mjs", import.meta.url));

function fixture(files) {
  const root = makeTempDir("tdcheck-");
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [CHECK, "--dir", root], { encoding: "utf8" });
}

// The root is spliced in rather than written literally, so that this file does not itself
// contain the call shape the check rejects: a literal one would make the check report its own
// test as a violation every time it scans this repository.
const rootedCall = (root) => `const d = mkdtempSync(join(${root}, "x-"));\n`;
const RAW = rootedCall("tmpdir()");

test("a raw tmpdir-rooted call site fails the check and is named", () => {
  const root = fixture({ "tests/unit/leaky.test.mjs": `import x from "y";\n${RAW}` });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /tests\/unit\/leaky\.test\.mjs:2/);
});

test("the os.tmpdir() spelling is caught too", () => {
  const root = fixture({ "scripts/leaky.mjs": rootedCall("os.tmpdir()") });
  assert.equal(run(root).status, 1);
});

test("the helper itself is allowed to make the call", () => {
  const root = fixture({ "scripts/temp-dir.mjs": RAW });
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /temp-dir-check: ok/);
});

test("a nested mkdtempSync is not a violation", () => {
  const root = fixture({ "tests/unit/nested.test.mjs": 'const s = mkdtempSync(join(dir, "repo-"));\n' });
  assert.equal(run(root).status, 0);
});

test("makeTempDir call sites are not violations", () => {
  const root = fixture({ "tests/unit/clean.test.mjs": 'const d = makeTempDir("x-");\n' });
  assert.equal(run(root).status, 0);
});

// A rooted call split across lines, and the `path.join` spelling: both create exactly the
// unowned directory the check exists to forbid, so neither may pass. The root is spliced in
// for the same reason as above.
const wrappedCall = (root) => `const d = mkdtempSync(\n  join(${root}, "x-")\n);\n`;
const dotJoinCall = (root) => `const b = mkdtempSync(path.join(${root}, "y-"));\n`;

test("a rooted call split across lines is caught and named at its mkdtempSync line", () => {
  const root = fixture({ "tests/unit/wrapped.test.mjs": `import x from "y";\n${wrappedCall("tmpdir()")}` });
  const r = run(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /tests\/unit\/wrapped\.test\.mjs:2/);
});

test("the path.join spelling is caught", () => {
  const root = fixture({ "scripts/dotjoin.mjs": dotJoinCall("os.tmpdir()") });
  assert.equal(run(root).status, 1);
});

// Scanning nothing is not a pass: without these guards the documented `node
// scripts/temp-dir-check.mjs` reports ok from any directory that holds no scannable surface.
test("a --dir that does not exist fails with this script's own diagnostic", () => {
  const r = run(join(fixture({}), "no-such-place"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /temp-dir-check: --dir .* is not a directory/);
});

test("a --dir that names a regular file fails with the same diagnostic", () => {
  const root = fixture({ "scripts/plain.mjs": "export const x = 1;\n" });
  const r = run(join(root, "scripts", "plain.mjs"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /temp-dir-check: --dir .* is not a directory/);
});

test("a tree with no scannable .mjs files aborts instead of reporting ok", () => {
  const r = run(fixture({ "docs/notes.md": "nothing here\n" }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no \.mjs files under .* nothing was checked/);
});

// golden-path C3 leg 2 decides "this module has a non-test importer" with the substring test
// read(consumer).includes('/temp-dir.mjs"'). The check script is not an importer, so carrying
// that substring would make a reverted migration look alive to the dead-module guard.
test("the check does not read as an importer of the module it exempts", () => {
  const src = readFileSync(CHECK, "utf8");
  assert.equal(
    /import[^\n]*temp-dir\.mjs/.test(src),
    false,
    "precondition: the check does not import scripts/temp-dir.mjs"
  );
  assert.equal(src.includes('/temp-dir.mjs"'), false, "leg 2's importer predicate must not match a non-importer");
});
