import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { intake, isCulpritBracketTitle } from "../../scripts/issue-intake.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fixture = (name) => JSON.parse(readFileSync(join(here, "..", "fixtures", "maintain", "issues", name), "utf8"));

const fakeGh = (issues) => (args) => {
  if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues);
  throw new Error(`unexpected gh call: ${args.join(" ")}`);
};
const noRedact = () => "";

test("culprit- and doctor-bracket issues are excluded before decomposition and counted", () => {
  const issues = [fixture("issue-culprit-bracket.json"), fixture("issue-doctor-bracket.json"), fixture("issue-44-multibug.json")];
  const r = intake({ repo: "o/r", ghRunner: fakeGh(issues), redactRunner: noRedact });
  assert.equal(r.available, true);
  assert.deepEqual(r.excludedCulprit.map((x) => x.number).sort((a, b) => a - b), [117, 200]);
  assert.deepEqual(r.issues.map((x) => x.number), [44]);
  assert.equal(r.counts.excludedCulprit, 2);
  assert.equal(r.counts.screened, 1);
  assert.equal(r.counts.fetched, 3);
});

test("isCulpritBracketTitle recognizes both prefixes and rejects ordinary titles", () => {
  assert.equal(isCulpritBracketTitle("[culprit:re-dispatch:execution] x"), true);
  assert.equal(isCulpritBracketTitle("[doctor:excess-cost:branch-review] x"), true);
  assert.equal(isCulpritBracketTitle("fix(pipeline): a real defect"), false);
  assert.equal(isCulpritBracketTitle("[wip] not a culprit issue"), false);
});

test("a throwing gh runner degrades to available:false with a reason, never throwing", () => {
  const throwing = () => { throw new Error("gh: command not found"); };
  const r = intake({ repo: "o/r", ghRunner: throwing, redactRunner: noRedact });
  assert.equal(r.available, false);
  assert.match(r.reason, /gh/);
  assert.deepEqual(r.issues, []);
  assert.equal(r.counts.screened, 0);
});

test("the recorded live backlog snapshot screens to 8 ordinary issues + 4 excluded culprits", () => {
  const r = intake({ repo: "o/r", ghRunner: fakeGh(fixture("backlog-snapshot.json")), redactRunner: noRedact });
  assert.equal(r.counts.fetched, 12);
  assert.equal(r.counts.excludedCulprit, 4);
  assert.equal(r.counts.screened, 8);
});

test("redaction is invoked on the kept bodies when a scratch dir is given", () => {
  let called = null;
  const spyRedact = (dir) => { called = dir; return ""; };
  const scratch = join(root, ".devcycle", "issue-intake", "test-scratch");
  intake({ repo: "o/r", ghRunner: fakeGh([fixture("issue-44-multibug.json")]), redactRunner: spyRedact, scratchDir: scratch });
  assert.equal(called, scratch);
});

test("the redaction round-trip does not fold the title into body (regression)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "issue-intake-title-dup-"));
  try {
    const noopRedact = () => ""; // simulates redaction that changes nothing in the file
    const r = intake({
      repo: "o/r",
      ghRunner: fakeGh([fixture("issue-44-multibug.json")]),
      redactRunner: noopRedact,
      scratchDir: scratch,
    });
    const { title, body } = r.issues[0];
    assert.doesNotMatch(body, new RegExp(`^# ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(body, /^#\s/, "body should never start with a markdown heading from the title");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the script issues no gh mutation CALL (matches an arg-array, not prose)", () => {
  const src = readFileSync(join(root, "scripts/issue-intake.mjs"), "utf8");
  assert.doesNotMatch(src, /"issue"\s*,\s*"(close|comment|edit|label|delete|reopen|transfer|pin|lock|unlock)"/);
});
