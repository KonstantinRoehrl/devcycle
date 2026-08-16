import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/lint-plan-code-blocks.mjs");

// realpath: on macOS the temp dir is a symlink, which would otherwise make every
// reported path a chain of `../` when the script is run with cwd set to the fixture.
function makeFixture(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lint-plan-")));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

const PIPE = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };

test("neither docs/superpowers/plans nor docs/superpowers/specs exists: exits 0 with a one-line message", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lint-plan-")));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE);
    assert.match(out, /no plan\/spec files found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid js code block in a plan file passes with exit 0", () => {
  const dir = makeFixture({
    "docs/superpowers/plans/2026-01-01-thing.md":
      "# Plan\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE);
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a syntactically broken mjs code block in a spec file fails with exit 1 and names the block", () => {
  const dir = makeFixture({
    "docs/superpowers/specs/2026-01-01-thing.md":
      "# Spec\n\n```mjs\nconst x = ;\n```\n",
  });
  try {
    let stderr = "";
    let stdout = "";
    assert.throws(() => {
      stdout = execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE);
    }, (err) => {
      stderr = (err.stdout ?? "") + (err.stderr ?? "");
      return err.status === 1;
    });
    assert.match(stderr, /2026-01-01-thing\.md: block 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-js code block (e.g. bash) is ignored even if it is broken syntax", () => {
  const dir = makeFixture({
    "docs/superpowers/plans/2026-01-01-thing.md":
      "# Plan\n\n```bash\nthis is not valid js at all ((((\n```\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE);
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("javascript info-string (not just js/mjs) is also linted", () => {
  const dir = makeFixture({
    "docs/superpowers/plans/2026-01-01-thing.md":
      "# Plan\n\n```javascript\nconst y = ;\n```\n",
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE),
      (err) => err.status === 1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plans dir exists but has no js/mjs blocks at all: exits 0 with ok", () => {
  const dir = makeFixture({
    "docs/superpowers/plans/2026-01-01-thing.md": "# Plan\n\nJust prose, no code blocks.\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE);
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default --dir is process.cwd() when the flag is omitted", () => {
  const dir = makeFixture({
    "docs/superpowers/plans/2026-01-01-thing.md": "# Plan\n\nJust prose, no code blocks.\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir });
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
