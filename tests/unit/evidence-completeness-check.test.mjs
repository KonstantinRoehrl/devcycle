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

function run(reportPath, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, reportPath, ...extraArgs], { encoding: "utf8" });
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
    assert.match(res.stderr, /no .*Evidence.* line found/i);
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
  // No glob token here: a cmd that also runs a broad glob is now exempted by the
  // broad-run guard (hasBroadTestRun) even with a --grep flag present, so this fixture
  // stays narrow on both signals to keep discriminating the --grep-flag check itself.
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: node --test --grep \"a session id\" tests/unit/foo.test.mjs\n"
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
  // The cmd also runs the default required-gate-checks.json entries (validate.mjs,
  // redaction-check.mjs) alongside the grep this test actually demonstrates, so it
  // satisfies the required-checks manifest gate without changing what check (a) covers.
  const body =
    `- Evidence: convention (grep -q banned agents/implementer.md) | cmd: grep -q banned agents/implementer.md && node scripts/validate.mjs && node scripts/redaction-check.mjs\n` +
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

// --- C2 / F30: the three exit-1 branches no test reached ---

test("no argument at all fails with a usage message", () => {
  const res = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(res.status, 1, `stdout: ${res.stdout}`);
  assert.match(res.stderr, /usage/i);
});

test("a red-green report missing the Before evidence line fails", () => {
  const body = `- Evidence: red-green | cmd: ${GATE}\n- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /Before/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a red-green report whose Before evidence file is missing fails naming the path", () => {
  const body =
    `- Evidence: red-green | cmd: ${GATE}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    rmSync(join(dir, "before.txt"));
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /before-evidence file not found: before\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Tolerant parsing: backticks around the class/cmd/paths and prose inside the exit
// parens are cosmetic report-authoring variation, not a different command or a missing
// status, so the checker resolves them the same as their plain forms. ---

test("backtick-wrapped class, cmd, and Before path, plus prose inside the After exit parens, all resolve to a clean pass", () => {
  const cmd = "node scripts/validate.mjs && node --test tests/unit/*.test.mjs";
  const body =
    "- Evidence: `red-green` | cmd: `" + cmd + "`\n" +
    "- Before: `before.txt` (exit 1)\n" +
    "- After: after.txt (exit 0, whole gate green)\n";
  const { dir, file } = makeReport(body);
  const header = `# devcycle-cmd: ${cmd}\n`;
  writeFileSync(join(dir, "before.txt"), header + "before output\n", "utf8");
  writeFileSync(join(dir, "after.txt"), header + NODE_SUMMARY + "\n", "utf8");
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an (exit <n>, ...) status carrying trailing prose inside the parens is tolerated", () => {
  // A class that is neither red-green/green-green nor convention isolates the
  // unconditional exit-status check from the is-test-class and required-checks blocks.
  const body =
    "- Evidence: manual-check | cmd: true\n" +
    "- Before: before.txt (exit 1, expected failure)\n" +
    "- After: after.txt (exit 0, whole gate green)\n";
  const { dir, file } = makeReport(body);
  writeFileSync(join(dir, "before.txt"), "output\n", "utf8");
  writeFileSync(join(dir, "after.txt"), "output\n", "utf8");
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a compound cmd that also runs the whole suite via a bare test directory is not flagged narrow, even though a single test file also appears", () => {
  const cmd = "node --test tests/unit/foo.test.mjs && node --test tests/unit/";
  const body = `- Evidence: green-green (behavior-preserving) | cmd: ${cmd}\n- Before: before.txt (exit 0)\n- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The narrowing escape hatch: a declared "<selector/scope> — <reason>" is accepted
// instead of blind-rejected; a reasonless declaration is a hard error. ---

test("a narrow selector with a valid Narrowing declaration passes and echoes the reason", () => {
  const cmd = "node --test tests/unit/foo.test.mjs";
  const body =
    `- Evidence: red-green | cmd: ${cmd}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n` +
    `- Narrowing: tests/unit/foo.test.mjs — concurrent wave; whole suite red from sibling edits\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /narrowing declared.*concurrent wave; whole suite red from sibling edits/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a narrow selector with no Narrowing declaration still fails (unchanged behavior)", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: node --test tests/unit/foo.test.mjs\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reasonless Narrowing declaration (no em-dash) is a hard error", () => {
  const cmd = "node --test tests/unit/foo.test.mjs";
  const body =
    `- Evidence: red-green | cmd: ${cmd}\n` +
    `- Before: before.txt (exit 1)\n` +
    `- After: after.txt (exit 0)\n` +
    `- Narrowing: tests/unit/foo.test.mjs\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /malformed narrowing declaration/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Required-checks manifest + staleness-aware header error. ---

test("a convention cmd missing a required gate check fails naming it (default manifest)", () => {
  const body =
    `- Evidence: convention (repo gate) | cmd: node scripts/validate.mjs\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "ok\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /omits required gate check "redaction-check\.mjs"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a convention cmd carrying every required gate check passes the manifest gate (default manifest)", () => {
  const body =
    `- Evidence: convention (repo gate) | cmd: node scripts/validate.mjs && node scripts/redaction-check.mjs\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "ok\n");
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--required-checks pointing at a custom manifest with a missing entry fails naming it", () => {
  const body =
    `- Evidence: convention (repo gate) | cmd: node scripts/validate.mjs\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "ok\n");
  const manifest = join(dir, "custom-required-checks.json");
  writeFileSync(manifest, JSON.stringify(["duplication-check.mjs"]), "utf8");
  try {
    const res = run(file, ["--required-checks", manifest]);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /omits required gate check "duplication-check\.mjs"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--required-checks pointing at a nonexistent manifest is a no-op", () => {
  const body =
    `- Evidence: convention (repo gate) | cmd: node scripts/validate.mjs\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "ok\n");
  try {
    const res = run(file, ["--required-checks", join(dir, "does-not-exist.json")]);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing '# devcycle-cmd:' header on a test-class report names the contract version and tells the author to reinstall", () => {
  const body =
    `- Evidence: green-green (behavior-preserving) | cmd: npm test\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReport(body);
  writeFileSync(join(dir, "before.txt"), "PASS\nTests: 1 passed\n", "utf8");
  writeFileSync(join(dir, "after.txt"), "PASS\nTests: 1 passed\n", "utf8");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /contract version 1/);
    assert.match(res.stderr, /reinstall/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Defect A: narrow-selector detection is invocation-aware. The heuristic is applied
// only to the actual test-runner sub-command(s), not to every whitespace token in the line. ---

test("a convention cmd whose non-test sub-command carries an -t flag (ripgrep file-type) is not flagged narrow", () => {
  // `-t` is ripgrep's file-type flag, not a test-runner selector; `rg …` is not a
  // test-runner invocation, so its flags must not read as test selectors.
  const cmd = "rg -t md banned playbooks/ && node scripts/validate.mjs && node scripts/redaction-check.mjs";
  const body =
    `- Evidence: convention (rg -t md banned playbooks/) | cmd: ${cmd}\n` +
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

test("a name-filter selector on the test-runner invocation is narrow even when a glob is also present", () => {
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: node --test --grep \"foo\" tests/unit/*.test.mjs\n"
  );
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-test sub-command's tests/ token does not mask a genuinely narrow single-file test run", () => {
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: rm -rf tests/tmp && node --test tests/unit/one.test.mjs\n"
  );
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a --require value that looks like a test dir does not reclassify a single-file run as broad", () => {
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: node --test tests/unit/foo.test.mjs --require ./tests/setup.mjs\n"
  );
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a genuine whole-suite node --test glob run is not flagged narrow", () => {
  const cmd = "node --test tests/unit/*.test.mjs";
  const body =
    `- Evidence: red-green | cmd: ${cmd}\n- Before: before.txt (exit 1)\n- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, NODE_SUMMARY);
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Defect B: convention captures are verified against their # devcycle-cmd: header,
// so a truncated capture cannot hide behind a full declared cmd:. ---

test("a convention report whose capture headers omit a required check fails naming it, even though the declared cmd: carries it", () => {
  const { dir, file } = makeReport(
    [
      "## Task report",
      "- Evidence: convention (repo gate) | cmd: node scripts/validate.mjs && node scripts/redaction-check.mjs",
      "- Before: before.txt (exit 0)",
      "- After: after.txt (exit 0)",
    ].join("\n"),
  );
  const truncated = "# devcycle-cmd: node scripts/validate.mjs\n";
  writeFileSync(join(dir, "before.txt"), truncated + "ok\n");
  writeFileSync(join(dir, "after.txt"), truncated + "ok\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /omits required gate check "redaction-check\.mjs"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a convention report whose capture headers match the declared full gate passes", () => {
  const cmd = "node scripts/validate.mjs && node scripts/redaction-check.mjs";
  const body =
    `- Evidence: convention (repo gate) | cmd: ${cmd}\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "ok\n");
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a convention report whose before/after capture headers differ from each other fails", () => {
  const { dir, file } = makeReport(
    [
      "## Task report",
      "- Evidence: convention (repo gate) | cmd: node scripts/validate.mjs && node scripts/redaction-check.mjs",
      "- Before: before.txt (exit 0)",
      "- After: after.txt (exit 0)",
    ].join("\n"),
  );
  writeFileSync(join(dir, "before.txt"), "# devcycle-cmd: node scripts/validate.mjs && node scripts/redaction-check.mjs\nok\n");
  writeFileSync(join(dir, "after.txt"), "# devcycle-cmd: node scripts/validate.mjs\nok\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr + res.stdout, /non-identical command|command.*mismatch/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Defect C: a present `- Evidence:` line missing its `| cmd:` suffix gets its own
// message, distinct from a wholly absent Evidence line. ---

test("an Evidence line present but missing the | cmd: suffix reports the missing suffix, not a missing line", () => {
  const { dir, file } = makeReport("## Task report\n- Evidence: red-green\n- Files changed: a.mjs\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /present but missing the .*cmd.*suffix/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report with no Evidence line at all reports the absent line, distinct from the missing-suffix case", () => {
  const { dir, file } = makeReport("## Task report\n- Files changed: a.mjs\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /no .*Evidence.* line found/i);
    assert.doesNotMatch(res.stderr, /missing the .*cmd.*suffix/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
