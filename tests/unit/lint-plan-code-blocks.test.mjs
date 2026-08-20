import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
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

// --- C2: the linter lints the plan it is handed ---

const runFail = (args, opts = {}) => {
  let out = "";
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, ...args], { ...PIPE, ...opts }),
    (err) => {
      out = (err.stdout ?? "") + (err.stderr ?? "");
      return err.status === 1;
    }
  );
  return out;
};

test("an explicit plan path outside the scan dirs is linted, and a broken block fails", () => {
  const dir = makeFixture({ "elsewhere/my-plan.md": "# Plan\n\n```js\nconst x = ;\n```\n" });
  try {
    const out = runFail([join(dir, "elsewhere/my-plan.md")], { cwd: dir });
    assert.match(out, /my-plan\.md: block 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit plan path with a valid block passes", () => {
  const dir = makeFixture({ "elsewhere/my-plan.md": "# Plan\n\n```js\nconst x = 1;\n```\n" });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, join(dir, "elsewhere/my-plan.md")], { ...PIPE, cwd: dir });
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit plan path with no lintable blocks passes", () => {
  const dir = makeFixture({ "elsewhere/my-plan.md": "# Plan\n\nProse only.\n" });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, join(dir, "elsewhere/my-plan.md")], { ...PIPE, cwd: dir });
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit plan path that names nothing exits 1 naming the path", () => {
  const dir = makeFixture({});
  try {
    const out = runFail([join(dir, "nope.md")], { cwd: dir });
    assert.match(out, /nope\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit plan path is linted alone, ignoring a broken block in the scan dirs", () => {
  const dir = makeFixture({
    "elsewhere/my-plan.md": "# Plan\n\n```js\nconst x = 1;\n```\n",
    "docs/superpowers/plans/broken.md": "# Plan\n\n```js\nconst y = ;\n```\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, join(dir, "elsewhere/my-plan.md")], { ...PIPE, cwd: dir });
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit plan path that is a directory exits 1 naming the path, with no stack trace", () => {
  const dir = makeFixture({ "elsewhere/my-plan.md": "# Plan\n" });
  try {
    const out = runFail([join(dir, "elsewhere")], { cwd: dir });
    assert.ok(out.includes(join(dir, "elsewhere")), `expected the path in the message, got: ${out}`);
    assert.doesNotMatch(out, /^\s+at /m, `expected a clean message, got a stack trace: ${out}`);
    assert.doesNotMatch(out, /EISDIR/, `expected a clean message, got a raw errno: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// mode 0o000 is not enforced for root, so the read would succeed and the test could not discriminate.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
test("an explicit plan path that exists but cannot be read exits 1 naming the path, with no stack trace", { skip: isRoot ? "mode 0o000 is not enforced for root" : false }, () => {
  const dir = makeFixture({ "elsewhere/my-plan.md": "# Plan\n\n```js\nconst x = 1;\n```\n" });
  const plan = join(dir, "elsewhere/my-plan.md");
  try {
    chmodSync(plan, 0o000);
    const out = runFail([plan], { cwd: dir });
    assert.ok(out.includes(plan), `expected the path in the message, got: ${out}`);
    assert.doesNotMatch(out, /^\s+at /m, `expected a clean message, got a stack trace: ${out}`);
    assert.doesNotMatch(out, /EACCES/, `expected a clean message, got a raw errno: ${out}`);
  } finally {
    chmodSync(plan, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty --dir sweep still exits 0, and names the directory it swept", () => {
  const dir = makeFixture({});
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], PIPE);
    assert.match(out, /no plan\/spec files found under /);
    assert.ok(out.includes(dir), `expected the swept dir in the message, got: ${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dir with no value is a usage error", () => {
  const out = runFail(["--dir"]);
  assert.match(out, /usage/i);
});

test("a positional path combined with --dir is a usage error", () => {
  const dir = makeFixture({ "elsewhere/my-plan.md": "# Plan\n" });
  try {
    const out = runFail([join(dir, "elsewhere/my-plan.md"), "--dir", dir]);
    assert.match(out, /usage/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
