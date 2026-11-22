import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { intake, isCulpritBracketTitle, GH_TIMEOUT_MS, GH_MAX_BUFFER, openIssueTotalArgs } from "../../scripts/issue-intake.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fixture = (name) => JSON.parse(readFileSync(join(here, "..", "fixtures", "maintain", "issues", name), "utf8"));

// Answers the open-issue total query and the list call; `total` defaults to the list length.
const fakeGh = (issues, { total = issues.length } = {}) => (args) => {
  if (args[0] === "api" && args[1] === "graphql") return `${total}\n`;
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

// #148: scripts/issue-intake.mjs is read-only — its only gh call is `gh issue list`. The same
// field-flagged body= guard tests/unit/pr-review-intake.test.mjs pins for the PR intake is pinned
// here per script, so a reader of either test sees the rule; the repo-wide sweep lives in
// tests/unit/golden-path.test.mjs.
test("issue-intake never carries a field-flagged body= write", () => {
  const src = readFileSync(join(root, "scripts", "issue-intake.mjs"), "utf8");
  assert.doesNotMatch(src, /-(?:f|F|-field|-raw-field)\s+["']?body=/);
});

test("an unwritable scratch dir keeps the originals instead of failing intake (#184)", () => {
  const issues = [fixture("issue-44-multibug.json")];
  const dir = makeTempDir("issue-intake");
  const notADir = join(dir, "file");
  writeFileSync(notADir, "x");
  const r = intake({ repo: "o/r", ghRunner: fakeGh(issues), redactRunner: noRedact, scratchDir: join(notADir, "scratch") });
  assert.equal(r.available, true);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].title, issues[0].title);
});

const plain = (number) => ({ number, title: `fix: thing ${number}`, body: "b", url: `u${number}` });

test("the list is fetched with --limit equal to GitHub's open-issue total", () => {
  const calls = [];
  const issues = [plain(1), plain(2), plain(3)];
  const gh = (args) => { calls.push(args); return fakeGh(issues)(args); };
  const r = intake({ repo: "o/r", ghRunner: gh, redactRunner: noRedact });
  assert.equal(r.available, true);
  assert.deepEqual(calls[0], openIssueTotalArgs("o/r"));
  const list = calls.find((a) => a[0] === "issue");
  assert.equal(list[list.indexOf("--limit") + 1], "3");
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.fetched, 3);
});

test("a fetched count that differs from the total fails loudly, never a truncated list", () => {
  const r = intake({ repo: "o/r", ghRunner: fakeGh([plain(1), plain(2)], { total: 5 }), redactRunner: noRedact });
  assert.equal(r.available, false);
  assert.equal(r.reason, "count-mismatch: fetched 2 of 5 open issues");
  assert.deepEqual(r.issues, []);
});

test("an unreadable total degrades to available:false with a count-unavailable reason", () => {
  const gh = (args) => (args[0] === "api" ? "not a number" : "[]");
  const r = intake({ repo: "o/r", ghRunner: gh, redactRunner: noRedact });
  assert.equal(r.available, false);
  assert.match(r.reason, /^count-unavailable: /);
});

test("a zero total returns an empty success without calling the list", () => {
  const gh = (args) => { if (args[0] === "issue") throw new Error("list must not run"); return "0"; };
  const r = intake({ repo: "o/r", ghRunner: gh, redactRunner: noRedact });
  assert.equal(r.available, true);
  assert.equal(r.counts.total, 0);
  assert.deepEqual(r.issues, []);
});

test("includeTracked keeps devcycle's own bracket-titled issues, tagged tracked", () => {
  const issues = [fixture("issue-culprit-bracket.json"), fixture("issue-44-multibug.json")];
  const r = intake({ repo: "o/r", includeTracked: true, ghRunner: fakeGh(issues), redactRunner: noRedact });
  assert.equal(r.available, true);
  assert.deepEqual(r.excludedCulprit, []);
  assert.equal(r.counts.tracked, 1);
  assert.deepEqual(r.issues.map((i) => [i.number, i.tracked]).sort((a, b) => a[0] - b[0]), [[44, false], [117, true]]);
});

test("without includeTracked the tracked issues stay excluded and every kept issue says tracked:false", () => {
  const issues = [fixture("issue-culprit-bracket.json"), fixture("issue-44-multibug.json")];
  const r = intake({ repo: "o/r", ghRunner: fakeGh(issues), redactRunner: noRedact });
  assert.equal(r.counts.tracked, 0);
  assert.deepEqual(r.issues.map((i) => i.tracked), [false]);
});

test("the total query is the GraphQL open-issue count for owner and name", () => {
  const args = openIssueTotalArgs("octo/widgets");
  assert.equal(args[0], "api");
  assert.ok(args.includes("owner=octo") && args.includes("name=widgets"));
  assert.match(args.find((a) => a.startsWith("query=")), /issues\(states:OPEN\)\{totalCount\}/);
});

test("the gh runner is sized for a full fetch", () => {
  assert.equal(GH_TIMEOUT_MS, 30000);
  assert.equal(GH_MAX_BUFFER, 64 * 1024 * 1024);
});

test("--limit is no longer accepted by the CLI", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts/issue-intake.mjs"), "--repo", "o/r", "--limit", "5"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--limit/);
});
