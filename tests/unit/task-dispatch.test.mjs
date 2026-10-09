import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/task-dispatch.mjs", import.meta.url).pathname;
const RUN = "0123456789abcdef";
const PREAMBLE = "Plan: `docs/plan.md`\nBranch: `feat/x` (cut from `dev` at `abc1234`)\nProfile: `standard` (evidence tail 20 lines)\n";

function repoWithLedger() {
  const repo = makeRepo();
  mkdirSync(join(repo, ".devcycle"), { recursive: true });
  writeFileSync(join(repo, ".devcycle/ledger.md"), PREAMBLE);
  return repo;
}

// No session id reaches the script, so the depth probe never reads a real transcript.
function childEnv() {
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: makeTempDir("task-dispatch-runs-"), CLAUDE_DOCTOR_PROJECTS: makeTempDir("task-dispatch-projects-") };
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
    briefPath: ".devcycle/briefs/5-implementer.md", depthBand: "unknown",
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
