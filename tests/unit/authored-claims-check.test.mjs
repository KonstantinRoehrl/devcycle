// Coverage for scripts/authored-claims-check.mjs — the authored-claims lint (references/evidence.md
// § Authored claims). Fixtures live under an out-of-repo TMPDIR per tests/unit/helpers.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/authored-claims-check.mjs");

function run(text) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acc-")));
  const file = join(dir, "artifact.md");
  writeFileSync(file, text);
  const r = spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), file };
}

// --- Step 1: true positives ---

test("a line reference with no marker is flagged and exits non-zero", () => {
  const { code, out, file } = run("See scripts/validate.mjs:311 for the budget path.\n");
  assert.equal(code, 1);
  assert.match(out, /unverified line-reference claim "scripts\/validate\.mjs:311"/);
  assert.match(out, new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1:`));
});

test("a count claim with no marker is flagged and exits non-zero", () => {
  const { code, out } = run("This pattern recurs in 38 sessions across the corpus.\n");
  assert.equal(code, 1);
  assert.match(out, /unverified count claim "38 sessions"/);
});

// --- Step 2: cleared by markers ---

test("a line reference cleared by a same-line (verified: ...) marker exits 0", () => {
  const { code, out } = run(
    "See scripts/validate.mjs:311 (verified: grep -n BUDGET_PATH scripts/validate.mjs).\n"
  );
  assert.equal(code, 0, out);
  assert.match(out, /ok/);
});

test("a count claim cleared by a same-line (assumption) marker exits 0", () => {
  const { code, out } = run("This recurs in 38 sessions (assumption).\n");
  assert.equal(code, 0, out);
  assert.match(out, /ok/);
});

test("a marker on the immediately following line clears the claim", () => {
  const { code, out } = run(
    "See scripts/validate.mjs:311 for the budget path.\n(verified: grep -n BUDGET_PATH scripts/validate.mjs)\n"
  );
  assert.equal(code, 0, out);
});

test("a marker on the immediately preceding line clears the claim", () => {
  const { code, out } = run(
    "(verified: grep -n BUDGET_PATH scripts/validate.mjs)\nSee scripts/validate.mjs:311 for the budget path.\n"
  );
  assert.equal(code, 0, out);
});

test("a marker two lines away does NOT clear the claim (not adjacent)", () => {
  const { code, out } = run(
    "See scripts/validate.mjs:311 for the budget path.\nsome unrelated line\n(verified: grep -n BUDGET_PATH scripts/validate.mjs)\n"
  );
  assert.equal(code, 1, out);
});

// --- Step 3: false-positive guards (QC4) ---

test("a file:line pattern inside a fenced code block is NOT flagged", () => {
  const { code, out } = run("```\nconst x = foo.mjs:12\n```\n");
  assert.equal(code, 0, out);
});

test("a file:line pattern in inline code is NOT flagged", () => {
  const { code, out } = run("Note: `scripts/foo.mjs:42` is just an example.\n");
  assert.equal(code, 0, out);
});

test("a URL with a port is NOT flagged", () => {
  const { code, out } = run("Open http://localhost:8080 in a browser.\n");
  assert.equal(code, 0, out);
});

test("an HH:MM timestamp is NOT flagged", () => {
  const { code, out } = run("The run started at 21:06.\n");
  assert.equal(code, 0, out);
});

test("a semver version is NOT flagged", () => {
  const { code, out } = run("Shipped in 0.18.2.\n");
  assert.equal(code, 0, out);
});

test("an ISO date is NOT flagged", () => {
  const { code, out } = run("Filed on 2026-09-04.\n");
  assert.equal(code, 0, out);
});

// --- Step 4: report-template structural field labels (not state claims) ---

test("the canonical Tail field label with a bare N is NOT flagged", () => {
  const { code, out } = run("- Tail (after, last 50 lines):\n");
  assert.equal(code, 0, out);
  assert.match(out, /ok/);
});

test("a genuine count claim in report body text is still flagged", () => {
  const { code, out } = run("We touched 5 files during this refactor.\n");
  assert.equal(code, 1, out);
  assert.match(out, /unverified count claim "5 files"/);
});

test("a real claim written after the Tail label on the same line is still flagged", () => {
  const { code, out } = run("- Tail (after, last 50 lines): see src/foo.mjs:42 for detail\n");
  assert.equal(code, 1, out);
  assert.match(out, /unverified line-reference claim "src\/foo\.mjs:42"/);
});

// --- CLI shape ---

test("a clean file exits 0 and prints ok", () => {
  const { code, out } = run("Nothing unverified here.\n");
  assert.equal(code, 0);
  assert.match(out, /authored-claims-check: ok/);
});

test("missing arg prints usage and exits 1", () => {
  const r = spawnSync("node", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match((r.stdout || "") + (r.stderr || ""), /usage: node scripts\/authored-claims-check\.mjs <file>/);
});
