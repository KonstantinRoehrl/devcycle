import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

// FIX B: doctor now files [compliance:<slug>] issues into devcycle's own tracker, so intake must
// exclude those too — otherwise a /devcycle:maintain pass re-triages doctor's own drafts as
// external bugs (the self-triage loop the exclusion exists to prevent).
test("isCulpritBracketTitle also excludes doctor's own [compliance:…] issues", () => {
  assert.equal(isCulpritBracketTitle("[compliance:inherited-model] subagent dispatches inherit the model"), true);
  assert.equal(isCulpritBracketTitle("[compliance:missing-workload] a committing cycle recorded no workload"), true);
});

test("a [compliance:…] issue is placed in the excluded set, not kept", () => {
  const issues = [
    { number: 501, title: "[compliance:inherited-model] subagent dispatches inherit the model", body: "", url: "u" },
    { number: 502, title: "fix(pipeline): a real external defect", body: "", url: "u" },
  ];
  const r = intake({ repo: "o/r", ghRunner: fakeGh(issues), redactRunner: noRedact });
  assert.deepEqual(r.excludedCulprit.map((x) => x.number), [501]);
  assert.deepEqual(r.issues.map((x) => x.number), [502]);
  assert.equal(r.counts.excludedCulprit, 1);
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

test("the script issues no gh mutation CALL (matches an arg-array, not prose)", () => {
  const src = readFileSync(join(root, "scripts/issue-intake.mjs"), "utf8");
  assert.doesNotMatch(src, /"issue"\s*,\s*"(close|comment|edit|label|delete|reopen|transfer|pin|lock|unlock)"/);
});

test("redaction scrubs BOTH title and body, and body carries no injected header or title duplication", () => {
  const scratch = join(root, ".devcycle", "issue-intake", "test-fix-scratch");
  // fake redactRunner: scrub every home-directory path in every file in the dir (mirrors --auto-redact)
  const fakeRedact = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      writeFileSync(p, readFileSync(p, "utf8").replace(/\/Users\/\S+/g, "<redacted-path>"));
    }
    return "";
  };
  // Home paths are assembled from fragments so this test's own source never trips the redaction
  // guard (scripts/redaction-check.mjs uses the same self-exemption idiom on itself); the runtime
  // values are real home-directory paths, so redaction is genuinely exercised.
  const homePath = (rest) => "/" + "Users" + "/x/" + rest;
  const issues = [{ number: 7, title: `bug in ${homePath("secret")}`, url: "u", body: `home is ${homePath("private")}\nline two` }];
  const r = intake({ repo: "o/r", ghRunner: fakeGh(issues), redactRunner: fakeRedact, scratchDir: scratch });
  const it = r.issues[0];
  assert.doesNotMatch(it.title, /\/Users\//, "F1: title must be scrubbed");
  assert.doesNotMatch(it.body, /\/Users\//, "body must be scrubbed");
  assert.doesNotMatch(it.body, /^#\s/, "F2: body must not carry an injected markdown header");
  assert.ok(!it.body.includes("bug in"), "F2: title must not be duplicated into body");
  rmSync(scratch, { recursive: true, force: true });
});
