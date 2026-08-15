import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/evidence-completeness-check.mjs");

function makeReport(content) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-completeness-check-"));
  const file = join(dir, "report.md");
  writeFileSync(file, content, "utf8");
  return { dir, file };
}

function run(reportPath) {
  return spawnSync(process.execPath, [SCRIPT, reportPath], { encoding: "utf8" });
}

test("a report file that does not exist fails naming the missing path", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-completeness-check-"));
  const missing = join(dir, "does-not-exist.md");
  try {
    const res = run(missing);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /does-not-exist\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report with no Evidence line fails naming that", () => {
  const { dir, file } = makeReport("## Task report\n- Files changed: a.mjs\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /no evidence line found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an Evidence line whose cmd is empty fails", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: \n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /empty/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a full whole-gate glob-style cmd passes", () => {
  const cmd =
    "node scripts/validate.mjs && node scripts/redaction-check.mjs && node scripts/duplication-check.mjs && node --test tests/unit/*.test.mjs";
  const { dir, file } = makeReport(`- Evidence: red-green | cmd: ${cmd}\n`);
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, new RegExp(cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cmd naming a single .test.mjs file as a positional arg fails as a narrow selector", () => {
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: node --test tests/unit/evidence-completeness-check.test.mjs\n"
  );
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cmd carrying a --grep flag fails as a narrow selector", () => {
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: node --test --grep \"a session id\" tests/unit/*.test.mjs\n"
  );
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cmd naming a single _test.py file fails as a narrow selector", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: pytest tests/unit/foo_test.py\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
