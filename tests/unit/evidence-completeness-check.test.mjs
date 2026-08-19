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

// Node --test green summary block, assembled from fragments (never a literal the redaction check flags).
const NODE_SUMMARY = ["ℹ pass 11", "ℹ fail 0", "ℹ duration_ms 42.0"].join("\n");

// The capture's command header (references/evidence.md §File-backed evidence) must be the
// exact command the report declares in cmd:. Derive it from the report body so every fixture
// is contract-faithful by construction — the check now compares each header against cmd:,
// not merely before against after.
function makeReportWithEvidence(reportBody, afterContent) {
  const dir = mkdtempSync(join(tmpdir(), "evidence-completeness-check-"));
  const file = join(dir, "report.md");
  const declaredCmd = (reportBody.match(/\bcmd:\s*(.+)/)?.[1] ?? "").trim();
  const header = `# devcycle-cmd: ${declaredCmd}\n`;
  writeFileSync(join(dir, "before.txt"), header + "before output\n", "utf8");
  if (afterContent !== null) writeFileSync(join(dir, "after.txt"), header + afterContent, "utf8");
  writeFileSync(file, reportBody, "utf8");
  return { dir, file };
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
  const body =
    `- Evidence: red-green | cmd: ${cmd}\n- Before: before.txt (exit 1)\n- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, ["ℹ pass 3", "ℹ fail 0"].join("\n"));
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

const GATE = "node scripts/validate.mjs && node scripts/redaction-check.mjs && node scripts/duplication-check.mjs && node --test tests/unit/*.test.mjs";

test("a red-green report with an after-file summary and exit statuses passes", () => {
  const body =
    `- Evidence: red-green | cmd: ${GATE}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a red-green report whose after-file lacks a runner summary fails", () => {
  const body =
    `- Evidence: red-green | cmd: ${GATE}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "AssertionError: boom\n  at Object.<anonymous>\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /runner summary|summary line/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a red-green report missing the After evidence line fails", () => {
  const body = `- Evidence: red-green | cmd: ${GATE}\n- Before: before.txt (exit 1)\n`;
  const { dir, file } = makeReportWithEvidence(body, null);
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /After/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Before line lacking an (exit <n>) status fails", () => {
  const body =
    `- Evidence: red-green | cmd: ${GATE}\n` +
    `- Before: before.txt\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /exit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second Before line lacking an (exit <n>) status fails, not just the first", () => {
  const body =
    `- Evidence: red-green | cmd: ${GATE}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n` +
    `- Before: before-second.txt\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /Before line is missing an \(exit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second After line lacking an (exit <n>) status fails, not just the first", () => {
  const body =
    `- Evidence: red-green | cmd: ${GATE}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n` +
    `- After: after-second.txt\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /After line is missing an \(exit/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects before/after evidence captured with non-identical commands", () => {
  const { dir, file } = makeReport(
    [
      "## Task report",
      "- Evidence: green-green | cmd: npm test",
      "- Before: before.txt (exit 0)",
      "- After: after.txt (exit 0)",
    ].join("\n"),
  );
  writeFileSync(join(dir, "before.txt"), "# devcycle-cmd: npm test -- --run foo\nPASS\nTests: 1 passed\n");
  writeFileSync(join(dir, "after.txt"), "# devcycle-cmd: npm test\nPASS\nTests: 42 passed\n");
  const r = run(file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /non-identical command|command.*mismatch/i);
});

test("rejects evidence files missing the # devcycle-cmd: header", () => {
  const { dir, file } = makeReport(
    [
      "## Task report",
      "- Evidence: green-green | cmd: npm test",
      "- Before: before.txt (exit 0)",
      "- After: after.txt (exit 0)",
    ].join("\n"),
  );
  writeFileSync(join(dir, "before.txt"), "PASS\nTests: 1 passed\n");
  writeFileSync(join(dir, "after.txt"), "PASS\nTests: 42 passed\n");
  const r = run(file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /devcycle-cmd|missing.*header/i);
});

test("accepts before/after evidence captured with identical command headers", () => {
  const { dir, file } = makeReport(
    [
      "## Task report",
      "- Evidence: green-green | cmd: npm test",
      "- Before: before.txt (exit 0)",
      "- After: after.txt (exit 0)",
    ].join("\n"),
  );
  writeFileSync(join(dir, "before.txt"), "# devcycle-cmd: npm test\nPASS\nTests: 42 passed\n");
  writeFileSync(join(dir, "after.txt"), "# devcycle-cmd: npm test\nPASS\nTests: 42 passed\n");
  const r = run(file);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});

test("rejects captures whose header is identical but narrower than the declared whole-gate cmd", () => {
  // The partial-gate false pass: both captures carry the SAME header (so the
  // before==after equality check is satisfied), yet that command is narrower than the
  // whole gate the report declares in cmd:. The declared cmd is a full, non-narrow gate,
  // so the narrow-selector guard on cmd sees nothing wrong either — only a header-vs-cmd
  // check catches it.
  const { dir, file } = makeReport(
    [
      "## Task report",
      `- Evidence: red-green | cmd: ${GATE}`,
      "- Before: before.txt (exit 1)",
      "- After: after.txt (exit 0)",
    ].join("\n"),
  );
  const narrower = "# devcycle-cmd: node --test tests/unit/*.test.mjs\n";
  writeFileSync(join(dir, "before.txt"), narrower + "ℹ pass 3\nℹ fail 0\n");
  writeFileSync(join(dir, "after.txt"), narrower + "ℹ pass 11\nℹ fail 0\n");
  try {
    const r = run(file);
    assert.notEqual(r.status, 0, `stdout: ${r.stdout}`);
    assert.match(r.stderr + r.stdout, /differ.*declared cmd|does not match.*declared/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a convention report with no runner summary still passes (class-gated check a)", () => {
  const body =
    `- Evidence: convention (grep -q banned agents/implementer.md) | cmd: grep -q banned agents/implementer.md\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "banned\n");
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
