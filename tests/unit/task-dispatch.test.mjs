import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo } from "./helpers.mjs";
import { briefPathFor } from "../../scripts/task-dispatch.mjs";

const SCRIPT = new URL("../../scripts/task-dispatch.mjs", import.meta.url).pathname;
const RUN = "0123456789abcdef";
const PREAMBLE = "Plan: `docs/plan.md`\nBranch: `feat/x` (cut from `dev` at `abc1234`)\nProfile: `standard` (evidence tail 20 lines)\n";

function repoWithLedger() {
  const repo = makeRepo();
  mkdirSync(join(repo, ".devcycle"), { recursive: true });
  writeFileSync(join(repo, ".devcycle/ledger.md"), PREAMBLE);
  return repo;
}

// No session id reaches the script, so the depth probe never reads a real transcript, and the user
// lesson stores an implementer brief is filled from are empty.
function childEnv() {
  const env = {
    ...process.env, DEVCYCLE_RUNS_DIR: makeTempDir("task-dispatch-runs-"), CLAUDE_DOCTOR_PROJECTS: makeTempDir("task-dispatch-projects-"),
    DEVCYCLE_LEARNINGS_DIR: makeTempDir("task-dispatch-learnings-"),
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

function dispatch(cwd, args, brief = "# Brief\nDo the task.\n") {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, input: brief, encoding: "utf8", env: childEnv() });
  assert.notEqual(r.stdout, "", `no JSON object on stdout — stderr: ${r.stderr}`);
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}
const ledgerLines = (repo) => readFileSync(join(repo, ".devcycle/ledger.md"), "utf8").split("\n").filter((l) => l.startsWith("- ["));

test("an implementer dispatch writes the brief, its start time and the dispatched line at retry 0", () => {
  const repo = repoWithLedger();
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, {
    ok: true, appended: ["5/dispatched/0/0"], action: "dispatch", task: "5", role: "implementer", round: 0, retry: 0,
    briefPath: ".devcycle/briefs/5-implementer.md", lessons: null, depthBand: "unknown",
  });
  assert.equal(readFileSync(join(repo, ".devcycle/briefs/5-implementer.md"), "utf8"), "# Brief for task 5\n");
  const { startedAt } = JSON.parse(readFileSync(join(repo, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8"));
  assert.match(startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const [line] = ledgerLines(repo);
  assert.equal(line, `- [${line.slice(3, 23)}] task=5 event=dispatched outcome=implementer retry 0 ref=.devcycle/briefs/5-implementer.md key=5/dispatched/0/0`);
});

test("a second implementer dispatch of the same task is the next retry, and a fix pass names its round", () => {
  const repo = repoWithLedger();
  dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"]);
  const fix = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer", "--round", "1"]);
  assert.equal(fix.out.retry, 1);
  assert.equal(fix.out.briefPath, ".devcycle/briefs/5-implementer-round-1.md");
  assert.match(ledgerLines(repo)[1], / outcome=implementer retry 1 ref=\.devcycle\/briefs\/5-implementer-round-1\.md key=5\/dispatched\/1\/1$/);
});

test("a reviewer dispatch appends review-round for its round; a re-dispatch of that round is its next retry", () => {
  const repo = repoWithLedger();
  const first = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "reviewer", "--round", "1"]);
  const again = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "reviewer", "--round", "1"]);
  assert.deepEqual([first.out.appended, again.out.appended], [["5/review-round/1/0"], ["5/review-round/1/1"]]);
  assert.match(ledgerLines(repo)[0], / task=5 event=review-round outcome=round 1 ref=\.devcycle\/briefs\/5-reviewer-round-1\.md key=5\/review-round\/1\/0$/);
});

// A verdict closes its round — the reviewer's, or the green gate's after an accept — so a findings
// file at a closed round's path is spent, and the round cap counts every closed round.
test("a reviewer dispatch takes the task's open round, else the one after its last verdict; any other round is refused", () => {
  const repo = repoWithLedger();
  const verdictLine = (round, retry, outcome) =>
    `- [2026-10-08T10:00:00Z] task=5 event=review-verdict outcome=${outcome} ref=none key=5/review-verdict/${round}/${retry}\n`;
  const reviewer = (round) => dispatch(repo, ["--run", RUN, "--task", "5", "--role", "reviewer", "--round", String(round)]);
  const refused = (round, expected) => {
    const r = reviewer(round);
    assert.equal(r.status, 2, `round ${round}: ${JSON.stringify(r.out)}`);
    assert.match(r.out.error, new RegExp(`task 5's next review is round ${expected}, not ${round}`));
  };
  refused(2, 1);
  assert.equal(reviewer(1).status, 0);
  appendFileSync(join(repo, ".devcycle/ledger.md"), verdictLine(1, 0, "accepted"));
  appendFileSync(join(repo, ".devcycle/ledger.md"), verdictLine(1, 1, "rejected (green gate: exit 1)"));
  refused(1, 2);
  refused(3, 2);
  assert.equal(reviewer(2).status, 0);
  appendFileSync(join(repo, ".devcycle/ledger.md"), verdictLine(2, 2, "rejected (missing findings file)"));
  assert.equal(reviewer(2).status, 0, "a round whose findings file went missing stays open");
  assert.equal(ledgerLines(repo).filter((l) => l.includes("event=review-round")).length, 3);
});

test("a reviewer dispatch moves a findings file already at its round's path aside, so the verdict read back is its own", () => {
  const repo = repoWithLedger();
  mkdirSync(join(repo, ".devcycle/findings"), { recursive: true });
  writeFileSync(join(repo, ".devcycle/findings/5-round-1.md"), "Verdict: accept\n");
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "reviewer", "--round", "1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(repo, ".devcycle/findings/5-round-1.md")), false);
  assert.equal(readFileSync(join(repo, ".devcycle/findings/5-round-1.stale-0.md"), "utf8"), "Verdict: accept\n");
});

test("a run that died before reaching the ledger is re-run at the same retry and leaves one line", () => {
  const repo = repoWithLedger();
  mkdirSync(join(repo, ".devcycle/briefs"), { recursive: true });
  writeFileSync(join(repo, ".devcycle/briefs/5-implementer.md"), "# half-written\n");
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief\n");
  assert.equal(r.out.retry, 0);
  assert.equal(ledgerLines(repo).length, 1);
  assert.equal(readFileSync(join(repo, ".devcycle/briefs/5-implementer.md"), "utf8"), "# Brief\n");
});

test("--model-decision records the routing decision as the implementer line's outcome; the key keeps the retry", () => {
  const repo = repoWithLedger();
  const decision = "fast (auto: files=1, deps=none, steps=specified)";
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer", "--model-decision", decision]);
  assert.deepEqual([r.out.retry, r.out.appended], [0, ["5/dispatched/0/0"]]);
  assert.match(ledgerLines(repo)[0], / task=5 event=dispatched outcome=model fast \(auto: files=1, deps=none, steps=specified\) ref=\.devcycle\/briefs\/5-implementer\.md key=5\/dispatched\/0\/0$/);
  const again = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer", "--round", "1", "--model-decision", "standard (pinned)"]);
  assert.equal(again.out.retry, 1);
  assert.match(ledgerLines(repo)[1], / outcome=model standard \(pinned\) ref=\.devcycle\/briefs\/5-implementer-round-1\.md key=5\/dispatched\/1\/1$/);
});

test("usage errors exit 2 with one JSON object and write nothing", () => {
  const repo = repoWithLedger();
  for (const [args, brief, message] of [
    [["--run", RUN, "--task", "5", "--role", "reviewer"], "# b\n", /--round is required for a reviewer dispatch/],
    [["--run", RUN, "--task", "5", "--role", "reviewer", "--round", "0"], "# b\n", /--round requires a positive whole number/],
    [["--run", RUN, "--task", "5", "--role", "tester"], "# b\n", /--role must be implementer or reviewer/],
    [["--run", "nope", "--task", "5", "--role", "implementer"], "# b\n", /--run must be a 16-hex run id/],
    [["--task", "5", "--role", "implementer"], "# b\n", /--run is required/],
    [["--run", RUN, "--task", "5", "--role", "implementer", "--bogus"], "# b\n", /unrecognised flag --bogus/],
    [["--run", RUN, "--task", "5", "--role", "implementer"], "  \n", /brief text on stdin is empty/],
  ]) {
    const r = dispatch(repo, args, brief);
    assert.equal(r.status, 2, `${args.join(" ")}: ${JSON.stringify(r.out)}`);
    assert.equal(r.out.ok, false);
    assert.equal(r.out.action, "usage-error");
    assert.match(r.out.error, message);
  }
  assert.equal(ledgerLines(repo).length, 0);
});

test("environment errors exit 3: outside a git repo, and with no ledger yet", () => {
  const outside = dispatch(makeTempDir("task-dispatch-norepo-"), ["--run", RUN, "--task", "5", "--role", "implementer"]);
  assert.equal(outside.status, 3);
  assert.equal(outside.out.action, "environment-error");
  assert.match(outside.out.error, /not a git repository/);
  const noLedger = dispatch(makeRepo(), ["--run", RUN, "--task", "5", "--role", "implementer"]);
  assert.equal(noLedger.status, 3);
  assert.match(noLedger.out.error, /no ledger at .*preamble/);
});

test("several tasks dispatched in parallel on one ledger each leave their line", async () => {
  const repo = repoWithLedger();
  const env = childEnv();
  await Promise.all(["1", "2", "3", "4", "5", "6"].map((task) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "--run", RUN, "--task", task, "--role", "implementer"], { cwd: repo, env });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`task ${task} exited ${code}`))));
    child.stdin.end(`# Brief for task ${task}\n`);
  })));
  assert.deepEqual(ledgerLines(repo).map((l) => l.match(/ key=(\S+)$/)[1]).sort(),
    ["1", "2", "3", "4", "5", "6"].map((t) => `${t}/dispatched/0/0`));
});

const GATED_PLAN = ["# P", "", "**Verification gate:** `npm run gate`", "",
  "### Task 5: T", "**Files:**", "- Modify: src/a.mjs", "**Evidence:** red-green", "**Quality constraints:** none", "",
  "## Dispatch Map", "", "- Wave 1: Task 5", ""].join("\n");

function gatedRepo() {
  const repo = repoWithLedger();
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/plan.md"), GATED_PLAN);
  return repo;
}
const briefAt = (repo, rel) => readFileSync(join(repo, rel), "utf8");

test("an implementer brief ends with the task's resolved gate command", () => {
  const repo = gatedRepo();
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(briefAt(repo, ".devcycle/briefs/5-implementer.md"), "# Brief for task 5\n\n**Lessons:** none\n\n**Gate command:** `npm run gate`\n");
});

test("a fix-pass brief carries the gate line too; a reviewer brief and an ungated task get none", () => {
  const repo = gatedRepo();
  dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer", "--round", "1"], "# Fix pass");
  assert.equal(briefAt(repo, ".devcycle/briefs/5-implementer-round-1.md"), "# Fix pass\n\n**Lessons:** none\n\n**Gate command:** `npm run gate`\n");
  dispatch(repo, ["--run", RUN, "--task", "5", "--role", "reviewer", "--round", "1"], "# Review brief\n");
  assert.equal(briefAt(repo, ".devcycle/briefs/5-reviewer-round-1.md"), "# Review brief\n");
  const plain = repoWithLedger();
  dispatch(plain, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n");
  assert.equal(briefAt(plain, ".devcycle/briefs/5-implementer.md"), "# Brief for task 5\n");
});

const LESSON_HEADER = "**Lessons:** (pull a full record with its --lesson hint only if you are about to work in the area it names)";
const GUARD = '- Guard the thing [novel:guard-thing] → node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lesson novel:guard-thing';

// A gated repo whose execution lesson names the task's file, src/a.mjs.
function lessonRepo() {
  const repo = gatedRepo();
  mkdirSync(join(repo, "docs/devcycle/promotions"), { recursive: true });
  writeFileSync(join(repo, "docs/devcycle/lessons.md"), "# Lessons\n\n## execution\n- Guard the thing [novel:guard-thing]\n");
  writeFileSync(join(repo, "docs/devcycle/promotions/2026-08-16-guard-thing.md"),
    "# Guard the thing\n- affected-files: src/*.mjs\n- culprit-id: novel:guard-thing\n");
  return repo;
}

test("an implementer brief's **Lessons:** line is filled in place with the lessons its task's files match", () => {
  const repo = lessonRepo();
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n**Lessons:**\n\n- [ ] Step 1\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.lessons, 1);
  assert.equal(briefAt(repo, ".devcycle/briefs/5-implementer.md"),
    `# Brief for task 5\n${LESSON_HEADER}\n${GUARD}\n\n- [ ] Step 1\n\n**Gate command:** \`npm run gate\`\n`);
});

test("a filled **Lessons:** line with nothing matched reads none; with no plan to read the brief is left as composed", () => {
  const repo = gatedRepo();
  const r = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n**Lessons:**\n- [ ] Step 1\n");
  assert.equal(r.out.lessons, 0);
  assert.equal(briefAt(repo, ".devcycle/briefs/5-implementer.md"), "# Brief for task 5\n**Lessons:** none\n- [ ] Step 1\n\n**Gate command:** `npm run gate`\n");
  const plain = repoWithLedger();
  const unplanned = dispatch(plain, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n**Lessons:**\n");
  assert.equal(unplanned.out.lessons, null);
  assert.equal(briefAt(plain, ".devcycle/briefs/5-implementer.md"), "# Brief for task 5\n**Lessons:**\n");
});

test("an ungated plan task's brief gets its lessons block last; a reviewer brief is never filled", () => {
  const repo = lessonRepo();
  writeFileSync(join(repo, "docs/plan.md"), GATED_PLAN.replace("**Verification gate:** `npm run gate`\n", ""));
  dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer"], "# Brief for task 5\n");
  assert.equal(briefAt(repo, ".devcycle/briefs/5-implementer.md"), `# Brief for task 5\n\n${LESSON_HEADER}\n${GUARD}\n`);
  const reviewer = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "reviewer", "--round", "1"], "# Review brief\n**Lessons:**\n");
  assert.equal("lessons" in reviewer.out, false);
  assert.equal(briefAt(repo, ".devcycle/briefs/5-reviewer-round-1.md"), "# Review brief\n**Lessons:**\n");
});

test("the dispatch record names the dispatching session, and null where none is set", () => {
  const repo = repoWithLedger();
  const env = { ...childEnv(), CLAUDE_CODE_SESSION_ID: "sess-dispatch-1" };
  const r = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "5", "--role", "implementer"], { cwd: repo, input: "brief\n", encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(join(repo, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8"));
  assert.equal(record.sessionId, "sess-dispatch-1");
  dispatch(repo, ["--run", RUN, "--task", "6", "--role", "implementer"], "brief\n");
  assert.equal(JSON.parse(readFileSync(join(repo, ".devcycle/dispatch/6-implementer-0-0.json"), "utf8")).sessionId, null);
});

test("--capture-cmd ends the brief with the capture command and a ready-made Narrowing line", () => {
  const repo = gatedRepo();
  const out = dispatch(repo, ["--run", RUN, "--task", "5", "--role", "implementer", "--capture-cmd", "node --test tests/unit/a.test.mjs"], "brief\n").out;
  const brief = readFileSync(join(repo, out.briefPath), "utf8");
  assert.match(brief, /\*\*Gate command:\*\* `[^`]+`\n\*\*Capture command:\*\* `node --test tests\/unit\/a\.test\.mjs` — pass it as `capture-evidence\.mjs --cmd`/);
  assert.match(brief, /\n- Narrowing: node --test tests\/unit\/a\.test\.mjs — concurrent wave: siblings' uncommitted edits share the checkout; the whole gate runs at commit in an isolated worktree\n$/);
});

test("--capture-cmd is an implementer's only", () => {
  const repo = repoWithLedger();
  const r = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "5", "--role", "reviewer", "--round", "1", "--capture-cmd", "x"],
    { cwd: repo, input: "brief\n", encoding: "utf8", env: childEnv() });
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error, /implementer dispatch only/);
});

test("--capture-cmd rejects a blank or multi-line command", () => {
  const repo = repoWithLedger();
  for (const cmd of ["  ", "node --test a.test.mjs\nrm -rf x"]) {
    const r = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "5", "--role", "implementer", "--capture-cmd", cmd],
      { cwd: repo, input: "brief\n", encoding: "utf8", env: childEnv() });
    assert.equal(r.status, 2, JSON.stringify(cmd));
    assert.match(JSON.parse(r.stdout).error, /takes one line/);
  }
});

test("briefPathFor is the path dispatch writes", () => {
  assert.equal(briefPathFor("5", "implementer", 0), ".devcycle/briefs/5-implementer.md");
  assert.equal(briefPathFor("5", "reviewer", 2), ".devcycle/briefs/5-reviewer-round-2.md");
});
