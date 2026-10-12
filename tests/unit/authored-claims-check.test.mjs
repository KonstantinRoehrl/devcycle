// Coverage for scripts/authored-claims-check.mjs — the authored-claims lint (references/evidence.md
// § Authored claims). Fixtures live under an out-of-repo TMPDIR per tests/unit/helpers.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { proseLines } from "../../scripts/authored-claims-check.mjs";

const SCRIPT = join(process.cwd(), "scripts/authored-claims-check.mjs");

function run(text) {
  const dir = realpathSync(makeTempDir("acc-"));
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

// --- #281: the lines under a report's Tail field are captured tool output, not prose ---

const tailReport = (after = []) => [
  "## Task report",
  "- Evidence: red-green | cmd: `node --test tests/unit/*.test.mjs`",
  "- Tail (after, last 3 lines):",
  "  ran 98 tests in 1.2s",
  "",
  "  2 files changed, 10 insertions(+)",
  "- Deviations: none",
  ...after,
  "",
].join("\n");

test("count claims in an indented Tail body, across a blank line, are not linted", () => {
  const { code, out } = run(tailReport());
  assert.equal(code, 0, out);
});

test("a count claim in prose after the Tail body still trips", () => {
  const { code, out } = run(tailReport(["- Claims: rewrote 3 files beyond the brief"]));
  assert.equal(code, 1);
  assert.match(out, /:8: unverified count claim "3 files"/);
});

test("an indented Tail field's body ends at its next sibling field", () => {
  const { code, out } = run([
    "- Report:",
    "  - Tail (after, last 1 lines):",
    "    ran 98 tests",
    "  - Deviations: rewrote 4 files",
    "",
  ].join("\n"));
  assert.equal(code, 1);
  assert.match(out, /unverified count claim "4 files"/);
  assert.doesNotMatch(out, /98 tests/);
});

test("proseLines blanks guarded spans and nulls fences, fenced lines and the Tail body", () => {
  const text = ["a `x` b", "```", "code 3 files", "```", "- Tail (after, last 1 lines):", "  5 tests", "end"].join("\n");
  const tailHeader = "- Tail (after, last 1 lines".replace(/./g, " ") + "):";
  assert.deepEqual(proseLines(text), ["a " + " ".repeat(3) + " b", null, null, null, tailHeader, null, "end"]);
});

// A fence opened inside a Tail body belongs to the Tail until it closes, wherever its markers are
// indented — otherwise a stray marker leaves every later line read as code and silences the lint.
const fencedTailReport = (fenceLines) => [
  "- Tail (after, last 2 lines):",
  ...fenceLines,
  "- Deviations: touched 12 files",
  "",
].join("\n");

test("a Tail fence closed flush-left still leaves the prose after it linted", () => {
  const { code, out } = run(fencedTailReport(["  ```", "  ran 98 tests", "```"]));
  assert.equal(code, 1);
  assert.match(out, /:5: unverified count claim "12 files"/);
  assert.doesNotMatch(out, /98 tests/);
});

test("flush-left output inside an indented Tail fence is not linted, and the prose after it is", () => {
  const { code, out } = run(fencedTailReport(["  ```", "ran 98 tests", "  ```"]));
  assert.equal(code, 1);
  assert.match(out, /:5: unverified count claim "12 files"/);
  assert.doesNotMatch(out, /98 tests/);
});

test("a well-formed fenced Tail body yields no findings", () => {
  const { code, out } = run(fencedTailReport(["  ```", "  ran 98 tests", "  ```"]).replace("touched 12 files", "none"));
  assert.equal(code, 0, out);
});
