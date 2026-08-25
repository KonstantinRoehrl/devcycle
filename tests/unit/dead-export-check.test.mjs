import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/dead-export-check.mjs");

function makeFixture(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dead-export-")));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });

test("flags an export imported by no module", () => {
  const dir = makeFixture({
    "scripts/a.mjs": "export const used = 1;\nexport const orphan = 2;\n",
    "scripts/b.mjs": "import { used } from './a.mjs';\nconsole.log(used);\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /1 export\(s\) with no non-test importer/);
    assert.match(res.stdout, /a\.mjs:orphan/);
    assert.doesNotMatch(res.stdout, /a\.mjs:used/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an export used only by a test is flagged (tests do not count)", () => {
  const dir = makeFixture({
    "scripts/a.mjs": "export const tested = 1;\n",
    "tests/a.test.mjs": "import { tested } from '../scripts/a.mjs';\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /a\.mjs:tested/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a namespace import marks all target exports used", () => {
  const dir = makeFixture({
    "scripts/a.mjs": "export const x = 1;\nexport const y = 2;\n",
    "scripts/b.mjs": "import * as a from './a.mjs';\nconsole.log(a);\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0 dead/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a static dynamic import marks all target exports used", () => {
  const dir = makeFixture({
    "scripts/a.mjs": "export const x = 1;\n",
    "scripts/b.mjs": "const m = await import('./a.mjs');\nconsole.log(m);\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /0 dead/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a non-static dynamic import is noted, not silently attributed", () => {
  const dir = makeFixture({
    "scripts/a.mjs": "export const x = 1;\n",
    "scripts/b.mjs": "const name = './a.mjs';\nconst m = await import(name);\nconsole.log(m);\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /unresolved dynamic import/);
    assert.match(res.stdout, /a\.mjs:x/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a fully-used corpus reports 0 dead with exit 0", () => {
  const dir = makeFixture({
    "scripts/a.mjs": "export function f() { return 1; }\n",
    "scripts/b.mjs": "import { f } from './a.mjs';\nf();\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /dead-export-check: ok \(/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an empty corpus aborts non-zero instead of reporting clean", () => {
  const dir = makeFixture({ "README.md": "# nothing here\n" });
  try {
    const res = run(["--dir", dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /dead-export-check: no exporting modules/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a --dir with no value fails instead of scanning the cwd", () => {
  const dir = makeFixture({ "scripts/a.mjs": "export const x = 1;\n" });
  try {
    const res = run(["--dir"], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--dir requires a path argument/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
