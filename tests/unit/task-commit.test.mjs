// scripts/task-commit.mjs — the coordinator's green gate and acceptance commit in one call. Every case
// builds a throwaway repo on a topic branch with a state file, a plan, a ledger and an isolated run
// record directory; nothing reads the real ~/.claude or this repo's .devcycle.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { gitToplevel, repoSlug } from "../../scripts/run-record.mjs";
import { makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/task-commit.mjs", import.meta.url));
const RUN = "0123456789abcdef";
const OTHER_RUN = "fedcba9876543210";
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
].join("\n");

function fixture({ acceptedRound = true } = {}) {
  const dir = makeRepo();
  sh("git", ["config", "user.name", "devcycle-test"], { cwd: dir });
  sh("git", ["config", "user.email", "test@devcycle.invalid"], { cwd: dir });
  writeInto(dir, ".gitignore", ".devcycle/\n");
  writeInto(dir, "docs/plan.md", PLAN);
  writeInto(dir, "src/a.txt", "a0\n");
  writeInto(dir, "src/b.txt", "fine\n");
  commitAll(dir, "chore: seed");
  const cut = sh("git", ["rev-parse", "--short", "HEAD"], { cwd: dir }).trim();
  sh("git", ["checkout", "-q", "-b", "feat/topic"], { cwd: dir });
  writeInto(dir, ".devcycle/state.md",
    `# devcycle state\n- stage: execution\n- branch: feat/topic (cut from main at ${cut})\n- run: ${RUN}\n`);
  writeInto(dir, ".devcycle/ledger.md", [
    "Plan: `docs/plan.md`",
    `Branch: \`feat/topic\` (cut from \`main\` at \`${cut}\`)`,
    "Profile: `standard` (evidence tail 20 lines)",
    "",
    "- [2026-01-01T00:00:00Z] task=1 event=review-round outcome=round 1 ref=none key=1/review-round/1/0",
    "- [2026-01-01T00:01:00Z] task=1 event=review-verdict outcome=accepted ref=.devcycle/findings/1-round-1.md key=1/review-verdict/1/0",
    "",
  ].join("\n"));
  const runsDir = makeTempDir("task-commit-runs-");
  const home = makeTempDir("task-commit-home-");
  const fx = { dir, runsDir, home, record: join(runsDir, repoSlug(gitToplevel(dir)), `${RUN}.jsonl`) };
  if (acceptedRound)
    writeInto(runsDir, join(repoSlug(gitToplevel(dir)), `${RUN}.jsonl`),
      JSON.stringify({ kind: "verdict", runId: RUN, taskId: "1", round: 1, blockingCount: 0, evidenceClass: "red-green", conformance: "pass" }) + "\n");
  return fx;
}

const cleanup = (fx) => [fx.dir, fx.runsDir, fx.home].forEach((d) => rmSync(d, { recursive: true, force: true }));

function env(fx) {
  const e = { ...process.env, DEVCYCLE_RUNS_DIR: fx.runsDir, CLAUDE_DOCTOR_PROJECTS: fx.home, HOME: fx.home };
  delete e.CLAUDE_CODE_SESSION_ID;
  return e;
}

function commitTask(fx, { testCmd = "true", extra = [], cwd = fx.dir } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "1", "--plan", "docs/plan.md",
    "--test-cmd", testCmd, "--subject", "feat: land task one", ...extra], { cwd, encoding: "utf8", env: env(fx) });
  assert.notEqual(r.stdout, "", `no JSON object on stdout — stderr: ${r.stderr}`);
  return { status: r.status, stderr: r.stderr, out: JSON.parse(r.stdout) };
}

const git = (fx, ...args) => sh("git", args, { cwd: fx.dir }).trim();
const head = (fx) => git(fx, "rev-parse", "HEAD");
const ledgerLines = (fx) =>
  readFileSync(join(fx.dir, ".devcycle/ledger.md"), "utf8").split("\n").filter((l) => l.startsWith("- ["));
const rows = (fx) => (existsSync(fx.record) ? readFileSync(fx.record, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const events = (fx) => rows(fx).filter((r) => r.kind === "event").map((r) => r.event);

test("a green gate commits only the task's changed Files with the subject and the run-scoped trailer", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    writeInto(fx.dir, "src/b.txt", "sibling edit\n");
    const { status, out } = commitTask(fx);
    assert.equal(status, 0);
    assert.equal(out.ok, true);
    assert.equal(out.action, "committed");
    assert.equal(out.gate, "pass");
    assert.equal(out.depthBand, "unknown");
    assert.match(out.sha, /^[0-9a-f]{40}$/);
    assert.equal(out.sha, head(fx));
    assert.equal(git(fx, "log", "-1", "--format=%s"), "feat: land task one");
    assert.equal(git(fx, "log", "-1", "--format=%(trailers:key=Devcycle-Task,valueonly)"), `${RUN}/1`);
    assert.equal(git(fx, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "src/a.txt");
    assert.equal(git(fx, "diff", "--name-only"), "src/b.txt", "a sibling's edit stays uncommitted");
    const last = ledgerLines(fx).at(-1);
    assert.match(last, new RegExp(`^- \\[[^\\]]+\\] task=1 event=committed outcome=green gate passed ref=${out.sha} key=1/committed/0/0$`));
    assert.deepEqual(events(fx), ["gate-pass-clean"]);
    assert.ok(rows(fx).some((r) => r.kind === "commit" && r.taskId === "1" && r.sha === out.sha));
    assert.deepEqual(out.appended, ["1/committed/0/0", "rr:event", "rr:commit"]);
  } finally {
    cleanup(fx);
  }
});

test("the convention's own trailers share git's trailer block with Devcycle-Task", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    const { out } = commitTask(fx, { extra: ["--trailers", "Co-Authored-By: Pair <pair@devcycle.invalid>"] });
    assert.equal(out.action, "committed");
    assert.equal(git(fx, "log", "-1", "--format=%s"), "feat: land task one");
    assert.deepEqual(git(fx, "log", "-1", "--format=%(trailers:only,unfold)").split("\n"), [
      "Co-Authored-By: Pair <pair@devcycle.invalid>",
      `Devcycle-Task: ${RUN}/1`,
    ]);
  } finally {
    cleanup(fx);
  }
});

test("a Files path with glob characters is committed alone: a sibling it would match as a pattern stays unstaged", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "docs/plan.md", PLAN.replace("- Modify: src/a.txt", "- Modify: src/[ab].txt"));
    writeInto(fx.dir, "src/[ab].txt", "x0\n");
    commitAll(fx.dir, "chore: seed a bracketed path");
    writeInto(fx.dir, "src/[ab].txt", "x1\n");
    writeInto(fx.dir, "src/a.txt", "sibling edit\n");
    const { out } = commitTask(fx);
    assert.equal(out.action, "committed", JSON.stringify(out));
    assert.equal(git(fx, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "src/[ab].txt");
    assert.equal(git(fx, "diff", "--cached", "--name-only"), "", "nothing else is left staged");
    assert.equal(git(fx, "diff", "--name-only"), "src/a.txt");
  } finally {
    cleanup(fx);
  }
});

// After `git add -N`, git reports a work-tree rename as ` R <new>\0<old>\0`; a `git mv` stages it as
// `R  <new>\0<old>\0`. Either way the task's change is the new path and the old one's deletion.
test("a renamed Files path commits both sides: the new file and the old one's deletion", () => {
  for (const [how, rename] of [
    ["in the work tree", (fx) => {
      renameSync(join(fx.dir, "src/a.txt"), join(fx.dir, "src/renamed.txt"));
      git(fx, "add", "-N", "src/renamed.txt");
    }],
    ["in the index", (fx) => git(fx, "mv", "src/a.txt", "src/renamed.txt")],
  ]) {
    const fx = fixture();
    try {
      writeInto(fx.dir, "docs/plan.md", PLAN.replace("- Modify: src/a.txt", "- Modify: src/a.txt\n- Create: src/renamed.txt"));
      rename(fx);
      const { out } = commitTask(fx);
      assert.equal(out.action, "committed", `${how}: ${JSON.stringify(out)}`);
      assert.deepEqual(git(fx, "diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD").split("\n").sort(),
        ["A\tsrc/renamed.txt", "D\tsrc/a.txt"], how);
      assert.equal(git(fx, "status", "--porcelain", "--", "src"), "", `${how}: the rename is left half-committed`);
    } finally {
      cleanup(fx);
    }
  }
});

test("a Files path deleted in the index is committed as a deletion", () => {
  const fx = fixture();
  try {
    git(fx, "rm", "-q", "src/a.txt");
    const { out } = commitTask(fx);
    assert.equal(out.action, "committed", JSON.stringify(out));
    assert.equal(git(fx, "diff-tree", "--no-commit-id", "--name-status", "-r", "HEAD"), "D\tsrc/a.txt");
  } finally {
    cleanup(fx);
  }
});

test("a crash between the commit and its ledger line: the re-run finds the trailer and only appends", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    git(fx, "commit", "--quiet", "-m", "feat: land task one", "--trailer", `Devcycle-Task: ${RUN}/1`, "--", "src/a.txt");
    const sha = head(fx);
    const first = commitTask(fx, { testCmd: "exit 1" });
    assert.equal(first.out.action, "already-committed", "the gate is not re-run for a commit that already landed");
    assert.equal(first.out.sha, sha);
    assert.equal(head(fx), sha, "no second commit");
    assert.equal(ledgerLines(fx).filter((l) => l.includes("event=committed")).length, 1);
    assert.deepEqual(events(fx), ["gate-pass-clean"]);
    const again = commitTask(fx);
    assert.equal(again.out.action, "already-committed");
    assert.deepEqual(again.out.appended, [], "a second re-run appends nothing");
    assert.equal(ledgerLines(fx).filter((l) => l.includes("event=committed")).length, 1);
  } finally {
    cleanup(fx);
  }
});

test("a previous cycle's same-numbered task does not match: its trailer names another run", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "earlier cycle\n");
    git(fx, "commit", "--quiet", "-m", "feat: an earlier cycle's task one", "--trailer", `Devcycle-Task: ${OTHER_RUN}/1`, "--", "src/a.txt");
    const earlier = head(fx);
    writeInto(fx.dir, "src/a.txt", "this cycle\n");
    const { out } = commitTask(fx);
    assert.equal(out.action, "committed");
    assert.notEqual(out.sha, earlier);
  } finally {
    cleanup(fx);
  }
});

test("a red gate on a clean tree is the task's own: gate-fail, no commit, culprit and conformance=fail rows", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    const before = head(fx);
    const { status, out } = commitTask(fx, { testCmd: "exit 1" });
    assert.equal(status, 0, "a red gate is a normal result, not an error");
    assert.equal(out.action, "gate-fail");
    assert.equal(out.gate, "fail");
    assert.equal(head(fx), before);
    assert.match(ledgerLines(fx).at(-1),
      /^- \[[^\]]+\] task=1 event=review-verdict outcome=rejected \(green gate: exit 1\) ref=\.devcycle\/evidence\/1-gate\.txt key=1\/review-verdict\/1\/1$/);
    assert.match(readFileSync(join(fx.dir, ".devcycle/evidence/1-gate.txt"), "utf8"), /^# devcycle-cmd: exit 1\n/);
    const gateFail = rows(fx).find((r) => r.kind === "event" && r.event === "gate-fail");
    assert.equal(gateFail.culprit, "gate-caught-regression");
    assert.equal(gateFail.attributedBy, "coordinator");
    assert.ok(rows(fx).some((r) => r.kind === "verdict" && r.round === 1 && r.conformance === "fail" && r.evidenceClass === "red-green"));
  } finally {
    cleanup(fx);
  }
});

// One review round is a reviewer dispatch plus the fix pass it triggers (references/loops.md); a red
// gate after a round's acceptance rejects that round, so after round 3 no round is left.
test("a red gate after round 3's acceptance exhausts the review loop: a user decision, never another fix", () => {
  const fx = fixture();
  try {
    appendFileSync(join(fx.dir, ".devcycle/ledger.md"), [
      "- [2026-01-01T00:02:00Z] task=1 event=review-round outcome=round 3 ref=none key=1/review-round/3/1",
      "- [2026-01-01T00:03:00Z] task=1 event=review-verdict outcome=accepted ref=.devcycle/findings/1-round-3.md key=1/review-verdict/3/1",
      "",
    ].join("\n"));
    writeInto(fx.dir, "src/a.txt", "a1\n");
    const { status, out } = commitTask(fx, { testCmd: "exit 1" });
    assert.equal(status, 0);
    assert.deepEqual([out.action, out.gate, out.loopId], ["needs-user", "fail", "task-1-review"]);
    assert.match(ledgerLines(fx).at(-1), / outcome=rejected \(green gate: exit 1\) ref=\.devcycle\/evidence\/1-gate\.txt key=1\/review-verdict\/3\/2$/);
    assert.equal(readFileSync(join(fx.dir, ".devcycle/findings/task-1-review-status.md"), "utf8"),
      "status: exhausted-unresolved rounds: 3/3 residue: 1 carried-to: none\n");
  } finally {
    cleanup(fx);
  }
});

test("a sibling-caused red with a green subset is deferred, never attributed", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "done\n");
    writeInto(fx.dir, "src/b.txt", "broken\n");
    const before = head(fx);
    const { out } = commitTask(fx, { testCmd: "grep -q fine src/b.txt", extra: ["--subset-cmd", "grep -q done src/a.txt"] });
    assert.equal(out.action, "deferred");
    assert.equal(out.gate, "deferred");
    assert.equal(head(fx), before);
    assert.match(ledgerLines(fx).at(-1), / task=1 event=review-verdict outcome=deferred \(concurrent sibling edits\) ref=\.devcycle\/evidence\/1-gate\.txt /);
    assert.deepEqual(events(fx), ["gate-deferred-foreign-change"]);
    assert.ok(!rows(fx).some((r) => r.kind === "verdict" && r.conformance === "fail"), "a deferral writes no conformance=fail line");
  } finally {
    cleanup(fx);
  }
});

test("a sibling-caused red whose subset is red too is the task's own; no pass row means no fail row", () => {
  const fx = fixture({ acceptedRound: false });
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    writeInto(fx.dir, "src/b.txt", "broken\n");
    const { out } = commitTask(fx, { testCmd: "grep -q fine src/b.txt", extra: ["--subset-cmd", "grep -q done src/a.txt"] });
    assert.equal(out.action, "gate-fail");
    assert.match(ledgerLines(fx).at(-1), /outcome=rejected \(green gate: exit 1\)/);
    assert.deepEqual(events(fx), ["gate-fail"]);
    assert.ok(!rows(fx).some((r) => r.kind === "verdict"));
  } finally {
    cleanup(fx);
  }
});

test("gate rows a crash cut off after their ledger line are written by the task's next call", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    assert.equal(commitTask(fx, { testCmd: "exit 1" }).out.action, "gate-fail");
    writeFileSync(fx.record, rows(fx).filter((r) => r.conformance === "pass").map((r) => JSON.stringify(r) + "\n").join(""));
    const { out } = commitTask(fx);
    assert.equal(out.action, "committed");
    assert.deepEqual(events(fx).sort(), ["gate-fail", "gate-pass-clean"]);
    assert.ok(rows(fx).some((r) => r.kind === "verdict" && r.conformance === "fail"));
  } finally {
    cleanup(fx);
  }
});

test("a branch switched under the run stops it before any gate or commit", () => {
  const fx = fixture();
  try {
    writeInto(fx.dir, "src/a.txt", "a1\n");
    git(fx, "checkout", "-q", "-b", "elsewhere");
    const before = head(fx);
    const linesBefore = ledgerLines(fx).length;
    const { out } = commitTask(fx);
    assert.equal(out.action, "branch-mismatch");
    assert.equal(out.recorded, "feat/topic");
    assert.equal(out.current, "elsewhere");
    assert.deepEqual(out.appended, []);
    assert.equal(head(fx), before);
    assert.equal(ledgerLines(fx).length, linesBefore);
  } finally {
    cleanup(fx);
  }
});

test("usage errors exit 2 and environment errors exit 3, both before anything is written", () => {
  const fx = fixture();
  const outside = makeTempDir("task-commit-outside-");
  try {
    for (const extra of [
      ["--subject", "feat: one\nsecond line"],
      ["--trailers", "not a trailer"],
      ["--trailers", "Devcycle-Task: forged/1"],
      ["--culprit", "not-a-real-culprit"],
      ["--bogus", "x"],
    ]) {
      const { status, out } = commitTask(fx, { extra });
      assert.equal(status, 2, extra.join(" "));
      assert.equal(out.ok, false);
      assert.equal(out.action, "usage-error");
    }
    const noTask = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "9", "--plan", "docs/plan.md",
      "--test-cmd", "true", "--subject", "feat: x"], { cwd: fx.dir, encoding: "utf8", env: env(fx) });
    assert.equal(noTask.status, 2, noTask.stderr);
    const env3 = commitTask(fx, { cwd: outside });
    assert.equal(env3.status, 3);
    assert.equal(env3.out.action, "environment-error");
    assert.deepEqual(ledgerLines(fx).length, 2);
  } finally {
    cleanup(fx);
    rmSync(outside, { recursive: true, force: true });
  }
});
