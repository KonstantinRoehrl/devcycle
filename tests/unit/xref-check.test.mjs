import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/xref-check.mjs");

function makeFixture(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "xref-")));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });

test("flags a dangling template path, passes a resolving one", () => {
  const dir = makeFixture({
    "references/target.md": "# Target\n",
    "playbooks/p.md":
      "See `${CLAUDE_PLUGIN_ROOT}/references/target.md` and `${CLAUDE_PLUGIN_ROOT}/references/gone.md`.\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /1 broken reference/);
    assert.match(res.stdout, /references\/gone\.md/);
    assert.doesNotMatch(res.stdout, /target\.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("flags a dangling relative markdown link and a bad anchor", () => {
  const dir = makeFixture({
    "a.md": "# Heading One\n\n## Sub Section\n",
    "b.md": "[ok](a.md#sub-section) [badfile](missing.md) [badanchor](a.md#nope)\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2 broken reference/);
    assert.match(res.stdout, /missing\.md \(missing file\)/);
    assert.match(res.stdout, /a\.md#nope \(missing anchor #nope\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("flags a §M citation with no definition, passes a defined one (#13's shape)", () => {
  const dir = makeFixture({
    "playbooks/owner.md": "# Owner\n\n8. **Persistence across passes (§M5) — after.**\n",
    "references/citer.md": "See `/devcycle:maintain` §M5 for persistence and §M10 for nothing.\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /1 broken reference/);
    assert.match(res.stdout, /§M10 \(no definition in surface\)/);
    assert.doesNotMatch(res.stdout, /§M5/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a clean surface reports 0 broken with exit 0", () => {
  const dir = makeFixture({
    "references/a.md": "# A\n",
    "playbooks/b.md": "Link to `${CLAUDE_PLUGIN_ROOT}/references/a.md`.\n",
  });
  try {
    const res = run(["--dir", dir], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /xref-check: ok \(/);
    assert.match(res.stdout, /0 broken/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no .md files aborts non-zero instead of reporting clean", () => {
  const dir = makeFixture({ "scripts/a.mjs": "export const x = 1;\n" });
  try {
    const res = run(["--dir", dir], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /xref-check: no \.md files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a --dir with no value fails instead of scanning the cwd", () => {
  const dir = makeFixture({ "a.md": "# A\n" });
  try {
    const res = run(["--dir"], dir);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /--dir requires a path argument/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
