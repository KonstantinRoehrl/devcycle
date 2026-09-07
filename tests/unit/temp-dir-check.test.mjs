import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
