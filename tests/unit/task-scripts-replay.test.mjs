// SC4 (spec § 8): the task scripts keep the per-task ledger path playbooks/executing-waves.md walked by
// hand before them. Each scenario drives the real scripts in a throwaway repo, the way the playbook's
// steps 3-7 call them, and compares the ledger lines they wrote with the lines the prose path wrote,
// modulo the timestamp and the idempotency key — the two things the prose path never had. One
// difference is intended, and pinned by its own scenario: the script path logs `review-round` when
// the reviewer is dispatched, where the prose logged it after the reviewer returned, so a round whose
// findings file went missing carries one `review-round` line per reviewer dispatch.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { now } from "../../scripts/stamp.mjs";
import { gitToplevel, repoSlug } from "../../scripts/run-record.mjs";
import { makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";

const RUN = "5c4a5c4a5c4a5c4a";
const DECISION = "fast (auto: files=1, deps=none, steps=specified)";
const PLAN = [
  "# Plan",
  "",
  "### Task 1: one",
  "",
  "**Files:**",
  "- Modify: src/a.txt",
  "",
  "**Evidence:** red-green",
  "",
  "### Task 2: two",
  "",
  "**Files:**",
  "- Modify: src/b.txt",
  "",
  "**Evidence:** red-green",
  "",
  "### Task 3: three",
  "",
  "**Files:**",
  "- Modify: src/c.txt",
  "",
  "**Evidence:** green-green (behavior-preserving)",
  "**Execution:** sweep",
  "",
].join("\n");

const script = (name) => fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url));

function fixture() {
  const dir = makeRepo();
  sh("git", ["config", "user.name", "devcycle-test"], { cwd: dir });
  sh("git", ["config", "user.email", "test@devcycle.invalid"], { cwd: dir });
  writeInto(dir, ".gitignore", ".devcycle/\n");
  writeInto(dir, "docs/plan.md", PLAN);
  for (const name of ["a", "b", "c"]) writeInto(dir, `src/${name}.txt`, "fine\n");
  commitAll(dir, "chore: seed");
  const cut = sh("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).trim();
  sh("git", ["checkout", "-q", "-b", "feat/replay"], { cwd: dir });
  writeInto(dir, ".devcycle/state.md",
    `# devcycle state\n- stage: execution\n- branch: feat/replay (cut from main at ${cut})\n- plan: docs/plan.md\n- run: ${RUN}\n`);
  writeInto(dir, ".devcycle/ledger.md", [
    "Plan: `docs/plan.md`",
    `Branch: \`feat/replay\` (cut from \`main\` at \`${cut}\`)`,
    "Profile: `standard` (evidence tail 2 lines)",
    "Commit-convention: types feat/fix/chore; no scope; imperative subject (derived from git log)",
    "",
    "",
  ].join("\n"));
  const runsDir = makeTempDir("replay-runs-");
  const home = makeTempDir("replay-home-");
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: runsDir, CLAUDE_DOCTOR_PROJECTS: home, HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return { dir, env, runsDir, cleanup: () => [dir, runsDir, home].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

function call(fx, name, args, input) {
  const r = spawnSync(process.execPath, [script(name), "--run", RUN, ...args], { cwd: fx.dir, env: fx.env, encoding: "utf8", input });
  assert.equal(r.status, 0, `${name} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// Step 3 — the routing decision is what model-routing.md's audit shape records on `dispatched`.
const dispatchImplementer = (fx, task, round) =>
  call(fx, "task-dispatch", ["--task", task, "--role", "implementer", "--model-decision", DECISION,
    ...(round ? ["--round", String(round)] : [])], `brief for task ${task}\n`);
const dispatchReviewer = (fx, task, round) =>
  call(fx, "task-dispatch", ["--task", task, "--role", "reviewer", "--round", String(round)], `review brief for task ${task}\n`);

// What a devcycle:implementer leaves behind: the edit, both evidence captures and the report.
function implement(fx, task, file) {
  writeInto(fx.dir, file, `done by task ${task}\n`);
  const cmd = "npm test";
  writeInto(fx.dir, `.devcycle/evidence/${task}-before.txt`, `# devcycle-cmd: ${cmd}\nℹ pass 0\nℹ fail 1\n`);
  writeInto(fx.dir, `.devcycle/evidence/${task}-after.txt`, `# devcycle-cmd: ${cmd}\nℹ pass 1\nℹ fail 0\n`);
  const report = `.devcycle/reports/${task}.md`;
  writeInto(fx.dir, report, [
    "## Task report",
    `- Files changed: ${file}`,
    `- Evidence: red-green | cmd: ${cmd}`,
    `- Before: .devcycle/evidence/${task}-before.txt (exit 1)`,
    `- After: .devcycle/evidence/${task}-after.txt (exit 0)`,
    "- Tail (after, last 2 lines):",
    "  ℹ pass 1",
    "  ℹ fail 0",
    "- Deviations: none",
    "- Claims: none",
    "- On-device items: none",
    "",
  ].join("\n"));
  return report;
}

const intake = (fx, task, report) =>
  call(fx, "task-intake", ["--task", task, "--report", report, "--status", "complete", "--agent-type", "devcycle:implementer",
    "--model", "claude-haiku-4-5", "--model-source", "explicit", "--agent-id", `a${task}0f1e2d3c4b5a697`]);

// Step 5 — the reviewer writes its own findings file; the verdict script reads it.
function review(fx, task, round, verdict, evidenceClass = "red-green") {
  const path = `.devcycle/findings/${task}-round-${round}.md`;
  if (verdict === "missing") rmSync(join(fx.dir, path), { force: true });
  else writeInto(fx.dir, path, verdict === "accept"
    ? "Verdict: accept\n"
    : "Verdict: needs-changes\nCulprit: fix-misses-the-convention\n\n1. [high] the edit keeps the seed value\n");
  return call(fx, "task-verdict", ["--task", task, "--round", String(round), "--findings", path, "--evidence-class", evidenceClass]);
}

const commitTask = (fx, task, testCmd, extra = []) =>
  call(fx, "task-commit", ["--task", task, "--plan", "docs/plan.md", "--test-cmd", testCmd,
    "--subject", `feat: land task ${task}`, ...extra]);

// One accepted round: steps 3, 4 and 5, in the order the playbook runs them.
function acceptedTask(fx, task, file) {
  const implementer = dispatchImplementer(fx, task);
  const report = implement(fx, task, file);
  assert.equal(intake(fx, task, report).action, "review");
  const reviewer = dispatchReviewer(fx, task, 1);
  assert.equal(review(fx, task, 1, "accept").action, "accepted");
  return [
    `task=${task} event=dispatched outcome=model ${DECISION} ref=${implementer.briefPath}`,
    `task=${task} event=report-received outcome=complete ref=${report}`,
    `task=${task} event=review-round outcome=round 1 ref=${reviewer.briefPath}`,
    `task=${task} event=review-verdict outcome=accepted ref=.devcycle/findings/${task}-round-1.md`,
  ];
}

// Modulo the two things the prose path never wrote: the stamp and the trailing idempotency key.
const ledger = (fx, task) =>
  readFileSync(join(fx.dir, ".devcycle/ledger.md"), "utf8").split("\n")
    .filter((l) => l.startsWith("- [") && l.includes(` task=${task} `))
    .map((l) => l.replace(/^- \[[^\]]+\] /, "").replace(/ key=\S+$/, ""));

const events = (fx, task) =>
  readFileSync(join(fx.runsDir, repoSlug(gitToplevel(fx.dir)), `${RUN}.jsonl`), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l)).filter((r) => r.kind === "event" && r.task === task).map((r) => r.event);

test("SC4 replay: a happy task", () => {
  const fx = fixture();
  try {
    const expected = acceptedTask(fx, "1", "src/a.txt");
    const commit = commitTask(fx, "1", "true");
    assert.equal(commit.action, "committed");
    assert.deepEqual(ledger(fx, "1"), [...expected, `task=1 event=committed outcome=green gate passed ref=${commit.sha}`]);
    assert.deepEqual(events(fx, "1"), ["gate-pass-clean"]);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: a rejected round goes back to the implementer, then the next round commits", () => {
  const fx = fixture();
  try {
    const first = dispatchImplementer(fx, "1");
    const report = implement(fx, "1", "src/a.txt");
    assert.equal(intake(fx, "1", report).action, "review");
    const round1 = dispatchReviewer(fx, "1", 1);
    assert.equal(review(fx, "1", 1, "needs-changes").action, "rejected");
    const fix = dispatchImplementer(fx, "1", 1);
    implement(fx, "1", "src/a.txt");
    assert.equal(intake(fx, "1", report).action, "review");
    const round2 = dispatchReviewer(fx, "1", 2);
    assert.equal(review(fx, "1", 2, "accept").action, "accepted");
    const commit = commitTask(fx, "1", "true");
    assert.equal(commit.action, "committed");
    assert.deepEqual(ledger(fx, "1"), [
      `task=1 event=dispatched outcome=model ${DECISION} ref=${first.briefPath}`,
      `task=1 event=report-received outcome=complete ref=${report}`,
      `task=1 event=review-round outcome=round 1 ref=${round1.briefPath}`,
      "task=1 event=review-verdict outcome=rejected ref=.devcycle/findings/1-round-1.md",
      `task=1 event=dispatched outcome=model ${DECISION} ref=${fix.briefPath}`,
      `task=1 event=report-received outcome=complete ref=${report}`,
      `task=1 event=review-round outcome=round 2 ref=${round2.briefPath}`,
      "task=1 event=review-verdict outcome=accepted ref=.devcycle/findings/1-round-2.md",
      `task=1 event=committed outcome=green gate passed ref=${commit.sha}`,
    ]);
    assert.deepEqual(events(fx, "1"), ["review-reject", "gate-pass-clean"]);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: a green-gate failure blocks the commit and goes back to the implementer", () => {
  const fx = fixture();
  try {
    const expected = acceptedTask(fx, "1", "src/a.txt");
    const head = sh("git", ["rev-parse", "HEAD"], { cwd: fx.dir }).trim();
    assert.equal(commitTask(fx, "1", "exit 1").action, "gate-fail");
    assert.equal(sh("git", ["rev-parse", "HEAD"], { cwd: fx.dir }).trim(), head);
    assert.deepEqual(ledger(fx, "1"), [
      ...expected,
      "task=1 event=review-verdict outcome=rejected (green gate: exit 1) ref=.devcycle/evidence/1-gate.txt",
    ]);
    assert.deepEqual(events(fx, "1"), ["gate-fail"]);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: after a green-gate failure the fix's review is the next round, so the accepted round's findings are never read again", () => {
  const fx = fixture();
  try {
    acceptedTask(fx, "1", "src/a.txt");
    assert.equal(commitTask(fx, "1", "exit 1").action, "gate-fail");
    dispatchImplementer(fx, "1", 1);
    const report = implement(fx, "1", "src/a.txt");
    assert.equal(intake(fx, "1", report).action, "review");
    const reused = spawnSync(process.execPath, [script("task-dispatch"), "--run", RUN, "--task", "1", "--role", "reviewer", "--round", "1"],
      { cwd: fx.dir, env: fx.env, encoding: "utf8", input: "review brief\n" });
    assert.equal(reused.status, 2, "the gate closed round 1: a re-review there is refused");
    dispatchReviewer(fx, "1", 2);
    assert.equal(review(fx, "1", 2, "missing").action, "missing-findings", "round 2's reviewer died without writing");
    dispatchReviewer(fx, "1", 2);
    assert.equal(review(fx, "1", 2, "accept").action, "accepted");
    assert.equal(commitTask(fx, "1", "true").action, "committed");
    assert.deepEqual(ledger(fx, "1").slice(4).map((l) => l.replace(/ ref=\S+$/, "")), [
      "task=1 event=review-verdict outcome=rejected (green gate: exit 1)",
      `task=1 event=dispatched outcome=model ${DECISION}`,
      "task=1 event=report-received outcome=complete",
      "task=1 event=review-round outcome=round 2",
      "task=1 event=review-verdict outcome=rejected (missing findings file)",
      "task=1 event=review-round outcome=round 2",
      "task=1 event=review-verdict outcome=accepted",
      "task=1 event=committed outcome=green gate passed",
    ]);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: after a green-gate failure neither the closed round's verdict nor a commit of the unreviewed fix goes through", () => {
  const fx = fixture();
  try {
    acceptedTask(fx, "1", "src/a.txt");
    assert.equal(commitTask(fx, "1", "exit 1").action, "gate-fail");
    dispatchImplementer(fx, "1", 1);
    assert.equal(intake(fx, "1", implement(fx, "1", "src/a.txt")).action, "review");
    const head = sh("git", ["rev-parse", "HEAD"], { cwd: fx.dir }).trim();
    const refused = (name, args) => {
      const r = spawnSync(process.execPath, [script(name), "--run", RUN, "--task", "1", ...args], { cwd: fx.dir, env: fx.env, encoding: "utf8" });
      assert.equal(r.status, 2, `${name}: ${r.stdout}`);
    };
    refused("task-verdict", ["--round", "1", "--findings", ".devcycle/findings/1-round-1.md", "--evidence-class", "red-green"]);
    refused("task-commit", ["--plan", "docs/plan.md", "--test-cmd", "true", "--subject", "feat: land task 1"]);
    assert.equal(sh("git", ["rev-parse", "HEAD"], { cwd: fx.dir }).trim(), head, "the unreviewed fix is not committed");
    assert.equal(ledger(fx, "1").at(-1), `task=1 event=report-received outcome=complete ref=.devcycle/reports/1.md`);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: a sibling-caused red is deferred, then the quiesced wave commits", () => {
  const fx = fixture();
  try {
    const expected = acceptedTask(fx, "1", "src/a.txt");
    writeInto(fx.dir, "src/b.txt", "broken by task 2, mid-flight\n");
    const gate = ["grep -q fine src/b.txt", ["--subset-cmd", "grep -q done src/a.txt"]];
    assert.equal(commitTask(fx, "1", ...gate).action, "deferred");
    writeInto(fx.dir, "src/b.txt", "fine\n");
    const commit = commitTask(fx, "1", ...gate);
    assert.equal(commit.action, "committed");
    assert.deepEqual(ledger(fx, "1"), [
      ...expected,
      "task=1 event=review-verdict outcome=deferred (concurrent sibling edits) ref=.devcycle/evidence/1-gate.txt",
      `task=1 event=committed outcome=green gate passed ref=${commit.sha}`,
    ]);
    assert.deepEqual(events(fx, "1"), ["gate-deferred-foreign-change", "gate-pass-clean"]);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: a sweep task keeps its own two lines, then review, gate and commit run through the scripts", () => {
  const fx = fixture();
  try {
    // references/sweep-execution.md: the coordinator appends these two, around the sweep run.
    const ledgerPath = join(fx.dir, ".devcycle/ledger.md");
    appendFileSync(ledgerPath, `- [${now()}] task=3 event=dispatched outcome=sweep model ${DECISION} ref=.devcycle/sweep-args-3.json\n`);
    writeInto(fx.dir, "src/c.txt", "swept\n");
    writeInto(fx.dir, ".devcycle/sweep-report-3.json", `${JSON.stringify({ applied: ["src/c.txt"] })}\n`);
    appendFileSync(ledgerPath, `- [${now()}] task=3 event=report-received outcome=complete ref=.devcycle/sweep-report-3.json\n`);
    const reviewer = dispatchReviewer(fx, "3", 1);
    assert.equal(review(fx, "3", 1, "accept", "green-green").action, "accepted");
    const commit = commitTask(fx, "3", "grep -q swept src/c.txt");
    assert.equal(commit.action, "committed");
    assert.deepEqual(ledger(fx, "3"), [
      `task=3 event=dispatched outcome=sweep model ${DECISION} ref=.devcycle/sweep-args-3.json`,
      "task=3 event=report-received outcome=complete ref=.devcycle/sweep-report-3.json",
      `task=3 event=review-round outcome=round 1 ref=${reviewer.briefPath}`,
      "task=3 event=review-verdict outcome=accepted ref=.devcycle/findings/3-round-1.md",
      `task=3 event=committed outcome=green gate passed ref=${commit.sha}`,
    ]);
    assert.deepEqual(events(fx, "3"), ["gate-pass-clean"]);
  } finally {
    fx.cleanup();
  }
});

test("SC4 replay: a missing findings file re-dispatches the reviewer — one review-round line per reviewer dispatch", () => {
  const fx = fixture();
  try {
    const implementer = dispatchImplementer(fx, "1");
    const report = implement(fx, "1", "src/a.txt");
    assert.equal(intake(fx, "1", report).action, "review");
    const lost = dispatchReviewer(fx, "1", 1);
    assert.equal(review(fx, "1", 1, "missing").action, "missing-findings");
    const again = dispatchReviewer(fx, "1", 1);
    assert.equal(review(fx, "1", 1, "accept").action, "accepted");
    const commit = commitTask(fx, "1", "true");
    assert.deepEqual(ledger(fx, "1"), [
      `task=1 event=dispatched outcome=model ${DECISION} ref=${implementer.briefPath}`,
      `task=1 event=report-received outcome=complete ref=${report}`,
      // The script path's extra line: the prose path logged review-round only once a findings file existed.
      `task=1 event=review-round outcome=round 1 ref=${lost.briefPath}`,
      "task=1 event=review-verdict outcome=rejected (missing findings file) ref=.devcycle/findings/1-round-1.md",
      `task=1 event=review-round outcome=round 1 ref=${again.briefPath}`,
      "task=1 event=review-verdict outcome=accepted ref=.devcycle/findings/1-round-1.md",
      `task=1 event=committed outcome=green gate passed ref=${commit.sha}`,
    ]);
  } finally {
    fx.cleanup();
  }
});
