import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const SCRIPT = join(process.cwd(), "scripts/evidence-completeness-check.mjs");

function makeReport(content) {
  const dir = makeTempDir("evidence-completeness-check-");
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
  const dir = makeTempDir("evidence-completeness-check-");
  const file = join(dir, "report.md");
  const declaredCmd = (reportBody.match(/\bcmd:\s*(.+)/)?.[1] ?? "").trim();
  const header = `# devcycle-cmd: ${declaredCmd}\n`;
  writeFileSync(join(dir, "before.txt"), header + "before output\n", "utf8");
  if (afterContent !== null) writeFileSync(join(dir, "after.txt"), header + afterContent, "utf8");
  writeFileSync(file, reportBody, "utf8");
  return { dir, file };
}

test("a report file that does not exist fails naming the missing path", () => {
  const dir = makeTempDir("evidence-completeness-check-");
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
  // A convention report under an absent manifest isolates the unconditional exit-status check
  // from the runner-summary and required-checks checks.
  const body =
    "- Evidence: convention | cmd: true\n" +
    "- Before: before.txt (exit 1, expected failure)\n" +
    "- After: after.txt (exit 0, whole gate green)\n";
  const { dir, file } = makeReportWithEvidence(body, "output\n");
  try {
    const res = run(file, ["--required-checks", join(dir, "absent.json")]);
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

// --- branch-fix-4-1 Defect 1: a test runner invoked behind a launcher/wrapper prefix
// (python -m, poetry run, npx, time, an env assignment) is still a test-runner invocation,
// so its narrow selector/single-file capture must be flagged. ---

test("a python -m pytest -k selector is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: python -m pytest -k foo\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a poetry run pytest single-file positional is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: poetry run pytest tests/unit/foo_test.py\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an npx vitest -t selector is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: npx vitest -t foo\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an npx jest single-file positional is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: npx jest tests/unit/foo.test.js\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a time-prefixed pytest -k selector is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: time pytest -k foo\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an env-assignment-prefixed pytest -k selector is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: FOO=1 pytest -k foo\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- branch-fix-4-1 Defect 2: an equals-form selector flag is recognized like the
// space-separated form. ---

test("an equals-form --grep=foo selector is flagged narrow even alongside a glob", () => {
  const { dir, file } = makeReport(
    "- Evidence: red-green | cmd: node --test --grep=foo tests/unit/*.test.mjs\n"
  );
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- branch-fix-4-1 Defect 3: a selector flag as the final token (its value elided in the
// report) is still a selector signal. ---

test("a trailing bare -k selector flag as the last token is flagged narrow", () => {
  const { dir, file } = makeReport("- Evidence: red-green | cmd: pytest -k\n");
  try {
    const res = run(file);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /narrow/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- branch-fix-4-1: the launcher/wrapper strip must NOT turn a non-test command into a
// test runner — rg -t md stays a convention grep, never read as a test selector. ---

test("branch-fix-4-1: rg -t md is still not read as a test selector after the launcher-strip fix", () => {
  // A convention gate whose only test-runner-looking token is ripgrep's -t file-type flag.
  // It satisfies the required-checks manifest, so the only way it can fail is a wrong
  // narrow-selector flag — assert that specific error text never appears.
  const cmd = "rg -t md banned playbooks/ && node scripts/validate.mjs && node scripts/redaction-check.mjs";
  const body =
    `- Evidence: convention (rg -t md banned playbooks/) | cmd: ${cmd}\n` +
    `- Before: before.txt (exit 0)\n` +
    `- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, "banned\n");
  try {
    const res = run(file);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /narrow selector|test-name filter/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branch-fix-4-1: a whole jest suite via npx with no selector or positional is broad", () => {
  const cmd = "npx jest";
  const body =
    `- Evidence: red-green | cmd: ${cmd}\n- Before: before.txt (exit 1)\n- After: after.txt (exit 0)\n`;
  const { dir, file } = makeReportWithEvidence(body, ["ℹ pass 3", "ℹ fail 0"].join("\n"));
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

// --- #283: dotnet's vstest summary; MTP's multi-line summary already matches ---

const VSTEST_PASS = "Passed!  - Failed:     0, Passed:    98, Skipped:     0, Total:    98, Duration: 1 s - Tests.dll (net8.0)";
const VSTEST_FAIL = "Failed!  - Failed:     2, Passed:    96, Skipped:     0, Total:    98, Duration: 1 s - Tests.dll (net8.0)";
const MTP_SUMMARY = ["Test run summary: Passed! - bin/Debug/net9.0/Tests.dll (net9.0|x64)", "  total: 98", "  failed: 0",
  "  succeeded: 98", "  skipped: 0", "  duration: 1s 204ms"].join("\n");
const DOTNET_REPORT = "## Task report\n- Evidence: green-green | cmd: dotnet test\n- Before: before.txt (exit 0)\n- After: after.txt (exit 0)\n";

for (const [name, after] of [["vstest pass", VSTEST_PASS], ["vstest fail", VSTEST_FAIL], ["MTP", MTP_SUMMARY]]) {
  test(`a dotnet ${name} summary counts as a test-runner summary`, () => {
    const { dir, file } = makeReportWithEvidence(DOTNET_REPORT, `${after}\n`);
    try {
      const res = run(file);
      assert.equal(res.status, 0, res.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("dotnet build output with no test summary still fails", () => {
  const { dir, file } = makeReportWithEvidence(DOTNET_REPORT, "Build succeeded.\n    0 Warning(s)\n    0 Error(s)\n");
  try {
    const res = run(file);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /has no test-runner summary line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- #282/#337: --task holds cmd: to the task's resolved gate ---

// A checkout as the execution stage lays it out: ledger → plan → evidence → report, task 4. The
// test context removes it once the test ends.
function gatedCheckout(t, { cmd = "npm run gate", header = cmd, beforeHeader = header, narrowing = null, extra = [], plan = true, gate = "npm run gate",
  evidence = "red-green", reportClass = evidence.split(" ")[0], git = false } = {}) {
  const dir = makeTempDir("evidence-completeness-gate-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (git) spawnSync("git", ["init", "-q"], { cwd: dir });
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  write(".devcycle/ledger.md", "Plan: `docs/plan.md`\n");
  if (plan)
    write("docs/plan.md", ["# P", "", `**Verification gate:** \`${gate}\``, "",
      "### Task 4: T", "**Files:**", "- Modify: a.mjs", `**Evidence:** ${evidence}`, "**Quality constraints:** none", "",
      "## Dispatch Map", "", "- Wave 1: Task 4", ""].join("\n"));
  write(".devcycle/evidence/4-before.txt", `# devcycle-cmd: ${beforeHeader}\nnot ok 1 - adds\n`);
  write(".devcycle/evidence/4-after.txt", `# devcycle-cmd: ${header}\n${NODE_SUMMARY}\n`);
  write(".devcycle/reports/4.md", ["## Task report", `- Evidence: ${reportClass} | cmd: ${cmd}`,
    "- Before: .devcycle/evidence/4-before.txt (exit 1)", "- After: .devcycle/evidence/4-after.txt (exit 0)",
    ...(narrowing ? [`- Narrowing: ${narrowing}`] : []), ...extra, ""].join("\n"));
  return { dir, write };
}
const runIn = (dir, args = ["--task", "4"], { report = ".devcycle/reports/4.md", cwd = dir } = {}) =>
  spawnSync(process.execPath, [SCRIPT, report, ...args], { cwd, encoding: "utf8" });

test("--task: a cmd: equal to the task's gate passes", (t) => {
  const { dir } = gatedCheckout(t);
  const res = runIn(dir);
  assert.equal(res.status, 0, res.stderr);
});

test("--task: a cmd: differing from the gate fails naming the gate, the cmd: and the capture header", (t) => {
  const { dir } = gatedCheckout(t, { cmd: "npm test" });
  const res = runIn(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cmd: is not the task's gate command — gate: npm run gate \| cmd: npm test \| capture header: npm test — .*references\/evidence\.md § File-backed evidence/);
});

test("--task: a differing cmd: with a valid Narrowing line passes", (t) => {
  const { dir } = gatedCheckout(t, { cmd: "npm test", narrowing: "npm test only — sibling task 3's uncommitted edit reddens the whole gate" });
  assert.equal(runIn(dir).status, 0);
});

test("--task: no plan, or no --task, skips the gate comparison", (t) => {
  assert.equal(runIn(gatedCheckout(t, { cmd: "npm test", plan: false }).dir).status, 0);
  assert.equal(runIn(gatedCheckout(t, { cmd: "npm test" }).dir, []).status, 0);
});

test("--task with no resolvable gate prints a one-line notice that the comparison was skipped", (t) => {
  const res = runIn(gatedCheckout(t, { cmd: "npm test", plan: false }).dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^evidence-completeness-check: notice — no gate command resolves for task 4 .*the gate comparison is skipped/m);
  assert.doesNotMatch(runIn(gatedCheckout(t).dir).stdout, /notice/);
});

test("--task run from a subdirectory finds the ledger at the work-tree root and still compares the gate", (t) => {
  const { dir } = gatedCheckout(t, { cmd: "npm test", git: true });
  mkdirSync(join(dir, "src"));
  const res = runIn(dir, ["--task", "4"], { report: "../.devcycle/reports/4.md", cwd: join(dir, "src") });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cmd: is not the task's gate command — gate: npm run gate \| cmd: npm test/);
});

test("--task: a convention task's report may declare the plan's whole Verification gate as its cmd:", (t) => {
  const gate = "node scripts/validate.mjs && node scripts/redaction-check.mjs";
  const evidence = "convention (`node scripts/validate.mjs`)";
  const manifest = ["--required-checks", join(process.cwd(), "tests/fixtures/required-gate-checks.json")];
  const res = runIn(gatedCheckout(t, { gate, evidence, cmd: gate }).dir, ["--task", "4", ...manifest]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(runIn(gatedCheckout(t, { gate, evidence, cmd: "node scripts/validate.mjs" }).dir).status, 0, "the parenthetical itself still matches");
  const other = runIn(gatedCheckout(t, { gate, evidence, cmd: "npm test" }).dir);
  assert.match(other.stderr, /cmd: is not the task's gate command — gate: node scripts\/validate\.mjs or the plan's Verification gate/);
});

test("--task: a cmd: equal to a single-file plan gate is not flagged as a narrow selector", (t) => {
  const gate = "node --test tests/all.test.mjs";
  const res = runIn(gatedCheckout(t, { gate, cmd: gate }).dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(runIn(gatedCheckout(t, { cmd: gate }).dir).stderr, /narrow selector/);
});

test("a report whose class is not one of the evidence classes fails, the helper's <class> placeholder included", (t) => {
  for (const reportClass of ["<class>", "manual-check"]) {
    const res = runIn(gatedCheckout(t, { reportClass }).dir);
    assert.equal(res.status, 1, reportClass);
    assert.match(res.stderr, /- Evidence: names no evidence class \(red-green \| green-green \| convention\), got ".*" — .*references\/evidence\.md § The three evidence classes/, reportClass);
  }
});

test("--task: the subset red capture is exempt from the gate comparison", (t) => {
  const { dir, write } = gatedCheckout(t, { extra: ["- Red: .devcycle/evidence/4-red.txt (exit 1)"] });
  write(".devcycle/evidence/4-red.txt", "# devcycle-cmd: node --test tests/unit/a.test.mjs\nnot ok 1 - adds\n");
  assert.equal(runIn(dir).status, 0);
});

// --- #333: a red explained away needs its reproduction artifact ---

const ATTRIBUTION = "- Deviations: the parser test fails on clean HEAD too, a pre-existing flake";

test("a failure attributed as pre-existing with no artifact fails, naming the task's flaky file", (t) => {
  const res = runIn(gatedCheckout(t, { extra: [ATTRIBUTION] }).dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /attributed as pre-existing, flaky, unrelated or environmental with no reproduction artifact — line \d+: .*\.devcycle\/evidence\/4-flaky\.txt/);
});

test("an attribution citing a non-empty flaky file passes; citing a missing one fails", (t) => {
  const cited = `${ATTRIBUTION} (.devcycle/evidence/4-flaky.txt)`;
  const present = gatedCheckout(t, { extra: [cited] });
  present.write(".devcycle/evidence/4-flaky.txt", "clean 20/20; change 20/20\n");
  assert.equal(runIn(present.dir).status, 0);
  const missing = runIn(gatedCheckout(t, { extra: [cited] }).dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cites \.devcycle\/evidence\/4-flaky\.txt, which is missing or empty/);
});

test("the attribution finding asks for the citation on that line or an adjacent line", (t) => {
  assert.match(runIn(gatedCheckout(t, { extra: [ATTRIBUTION] }).dir).stderr, /cite \.devcycle\/evidence\/4-flaky\.txt on that line or an adjacent line,/);
});

// Each line sits in a report that is otherwise valid, so its exit status is the attribution verdict alone.
// The rule is deliberately conservative: a failure word and an attribution word on one line, or a
// flake word alone, bounce unless a negator sits directly before the attribution word or a
// colon-form "none" ends the line after it. Lines that merely mention a failure beside an
// attribution word ("this task fixes the pre-existing failure", "Error handling for the unrelated
// legacy path") bounce too; that cost is accepted and the report writer rephrases, because every
// smarter exemption let a failure through.
const ATTRIBUTION_CASES = {
  pass: [
    "No pre-existing failures; the whole gate was green before and after.",
    "Nothing flaky observed across three runs, zero failures.",
    "The before run is red as expected; no unrelated files were touched.",
    "Flakes: none.",
    "flaky: none observed",
    "Flakes: none observed.",
    "- flaky: none",
  ],
  fail: [
    "The 2 failures are pre-existing.",
    "test X is flaky, not caused by this change",
    "the red in foo.test is unrelated to this task",
    "environmental failure on CI, pre-existing",
    "2 tests failed; both are pre-existing.",
    "2 tests failed, both pre-existing.",
    "2 tests failed — both pre-existing.",
    "1 failure (pre-existing)",
    "The red is caused by an unrelated sibling change.",
    "I did not fix the pre-existing failure in parseDate.",
    "The pre-existing failure in parseDate was not fixed by this task.",
    "2 failures remain. They are pre-existing.",
    "foo.test fails for unrelated reasons.",
    "The crash is a known pre-existing issue.",
    "Gate red due to an environmental issue.",
    "The gate is red because of unrelated tests.",
    "The 2 failures, both pre-existing, predate this branch.",
    "the failure appears pre-existing",
    "the red is pre-existing and I did not fix it",
    "no new failures, the one remaining failure is pre-existing",
    "the 3 errors are not caused by this task; they are pre-existing",
    "foo.test flaked once and passed on rerun",
    "The failure is a pre-existing regression on main.",
    "The red comes from an unrelated sibling change.",
    "the failure is a flaky timeout",
    "the failure is in unrelated code",
    "failure: flaky test",
    "Fixing the pre-existing failure in parseDate is out of scope.",
    "None of my changes touch the pre-existing failure in parseDate.",
    "nobody fixed the pre-existing failure; it remains",
    "this task fixes the pre-existing failure in parseDate that the spec names",
    "Error handling for the unrelated legacy path is unchanged.",
    "None of the tests are flaky.",
    "Updated the docs section on flaky tests.",
    "The failure is pre-existing and none of my changes touch it.",
    "the failing test is flaky since none of the reruns reproduce it",
    "The failure is pre-existing: none of my changes touch parseDate.",
    "the failure is environmental because none of the reruns reproduce it",
    "the failure is pre-existing so none of ours",
    "Flaky tests: none found, 3 reruns",
  ],
};

test("a line fires only when something on it explains a failure away", (t) => {
  for (const [verdict, lines] of Object.entries(ATTRIBUTION_CASES)) {
    for (const line of lines) {
      for (const field of ["- Claims:", "- Deviations:"]) {
        const res = runIn(gatedCheckout(t, { extra: [`${field} ${line}`] }).dir);
        assert.equal(res.status, verdict === "pass" ? 0 : 1, `${verdict}: ${field} ${line}\n${res.stderr}`);
        if (verdict === "fail") assert.match(res.stderr, /with no reproduction artifact/, line);
      }
    }
  }
});

test("an (assumption) marker does not clear an unbacked attribution", (t) => {
  assert.equal(runIn(gatedCheckout(t, { extra: [`${ATTRIBUTION} (assumption)`] }).dir).status, 1);
});

test("the Narrowing line, red-green, unrelated whitespace and the Tail body are not attributions", (t) => {
  const res = runIn(gatedCheckout(t, {
    narrowing: "the whole gate — sibling task 3's unrelated edit makes it fail",
    extra: ["- Deviations: reflowed unrelated whitespace; the red-green pair is in the evidence files",
      "- Tail (after, last 2 lines):", "  not ok 3 - flaky retry failed", "  pre-existing failure"],
  }).dir);
  assert.equal(res.status, 0, res.stderr);
});

test("without --task the flaky file is named from the Before path's task id", (t) => {
  const res = runIn(gatedCheckout(t, { extra: [ATTRIBUTION] }).dir, []);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /\.devcycle\/evidence\/4-flaky\.txt/);
});

test("a gate mismatch and an unbacked attribution are reported together, in one run", (t) => {
  const res = runIn(gatedCheckout(t, { cmd: "npm test", extra: [ATTRIBUTION] }).dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cmd: is not the task's gate command/);
  assert.match(res.stderr, /with no reproduction artifact/);
});

// #382: real Karma 6.4.4 captures (progress, dots, a focused run, --no-colors, a failing run).
const karma = (name) => readFileSync(new URL(`../fixtures/karma/${name}.txt`, import.meta.url), "utf8");
function karmaReport(capture) {
  const cmd = capture.split("\n", 1)[0].replace(/^# devcycle-cmd: /, "");
  const body = `- Evidence: green-green | cmd: ${cmd}\n- Before: before.txt (exit 0)\n- After: after.txt (exit 0)\n`;
  return makeReportWithEvidence(body, capture.slice(capture.indexOf("\n") + 1));
}

for (const name of ["pass", "passdots", "focus", "pass-nocolor", "fail"])
  test(`#382: a Karma ${name} capture carries a test-runner summary`, () => {
    const { dir, file } = karmaReport(karma(name));
    try {
      const res = run(file);
      assert.equal(res.status, 0, res.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

test("#382: a Karma capture cut off at its Executed 0 of 4 line, or mid-run, has no summary", () => {
  const lines = karma("pass").split("\n");
  for (const marker of ["Executed 0 of 4", "Executed 2 of 4"]) {
    const cut = lines.slice(0, lines.findIndex((line) => line.includes(marker)) + 1).join("\n") + "\n";
    const { dir, file } = karmaReport(cut);
    try {
      const res = run(file);
      assert.equal(res.status, 1, marker);
      assert.match(res.stderr, /has no test-runner summary line/, marker);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// #382 × #391: the one before/after rule — identical headers, or a whole-gate before and a declared
// narrowed after (references/evidence.md § File-backed evidence).
const WHOLE = "node --test tests/unit/*.test.mjs";
const MINE = "node --test tests/unit/mine.test.mjs";
const SIBLING_RED = "sibling task 3's uncommitted edit reddens the whole gate";

test("#382: a whole-gate before with a declared narrowed after passes", (t) => {
  const { dir } = gatedCheckout(t, { gate: WHOLE, cmd: MINE, header: MINE, beforeHeader: WHOLE, narrowing: `${MINE} — ${SIBLING_RED}` });
  const res = runIn(dir);
  assert.equal(res.status, 0, res.stderr);
});

test("#382: every other narrowed pair is still refused, naming the half that failed", (t) => {
  const pair = { gate: "npm run gate", cmd: "npm run gate:unit", header: "npm run gate:unit", beforeHeader: "npm run gate" };
  for (const [name, opts, half, args] of [
    ["no declaration", pair, /no - Narrowing: line declared/],
    ["the after lacks the scope", { ...pair, narrowing: `npm run gate:other — ${SIBLING_RED}` }, /after does not carry the declared scope/],
    ["the halves swapped", { gate: "npm run gate", cmd: "npm run gate", header: "npm run gate", beforeHeader: "npm run gate:unit", narrowing: `npm run gate:unit — ${SIBLING_RED}` }, /before is not the task's gate/],
    ["no resolvable gate", { ...pair, plan: false, narrowing: `npm run gate:unit — ${SIBLING_RED}` }, /no gate resolves for the task/],
    ["no --task", { ...pair, narrowing: `npm run gate:unit — ${SIBLING_RED}` }, /no gate resolves for the task/, []],
    ["a convention report", { ...pair, evidence: "convention (`npm run gate`)", narrowing: `npm run gate:unit — ${SIBLING_RED}` }, /a convention capture's before and after must be identical/],
  ]) {
    const res = runIn(gatedCheckout(t, opts).dir, args);
    assert.equal(res.status, 1, name);
    assert.match(res.stderr, /before\/after captured with non-identical commands — before: .* \| after: .* — /, name);
    assert.match(res.stderr, half, name);
  }
});

test("#382: a declared narrowed after that differs from cmd: is still refused", (t) => {
  const { dir } = gatedCheckout(t, { gate: "npm run gate", cmd: "npm run gate:unit --x", header: "npm run gate:unit", beforeHeader: "npm run gate",
    narrowing: `npm run gate:unit — ${SIBLING_RED}` });
  const res = runIn(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /capture command differs from the declared cmd:/);
});
