import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/task-verdict.mjs", import.meta.url).pathname;
const RUN = "0123456789abcdef";
const PREAMBLE = "Plan: `docs/plan.md`\nBranch: `feat/x` (cut from `dev` at `abc1234`)\nProfile: `standard` (evidence tail 20 lines)\n";
const ACCEPT = "Verdict: accept\n\n1. [low] a naming nit\n";
const REJECT = "Verdict: needs-changes\nCulprit: novel:missing-edge-case\n\n1. [high] the empty ledger is not handled\n2. [critical] a line is lost under concurrency\n3. [medium] a comment restates the code\n";

const reviewRoundLine = (round, retry) =>
  `- [2026-10-08T10:00:00Z] task=5 event=review-round outcome=round ${round} ref=.devcycle/briefs/5-reviewer-round-${round}.md key=5/review-round/${round}/${retry}\n`;

function fixture(round = 1) {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/ledger.md", PREAMBLE + reviewRoundLine(round, 0));
  return { repo, runsDir: makeTempDir("task-verdict-runs-") };
}
const ledgerPath = ({ repo }) => join(repo, ".devcycle/ledger.md");

function verdict({ repo, runsDir }, round = 1, extra = []) {
  const env = { ...process.env, DEVCYCLE_RUNS_DIR: runsDir, CLAUDE_DOCTOR_PROJECTS: makeTempDir("task-verdict-projects-") };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [SCRIPT, "--run", RUN, "--task", "5", "--round", String(round),
    "--findings", `.devcycle/findings/5-round-${round}.md`, "--evidence-class", "red-green", ...extra],
  { cwd: repo, encoding: "utf8", env });
  assert.notEqual(r.stdout, "", `no JSON object on stdout — stderr: ${r.stderr}`);
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
}
const ledgerTail = (f) => readFileSync(ledgerPath(f), "utf8").trim().split("\n").at(-1);
const rows = ({ runsDir }) => {
  const [slug] = readdirSync(runsDir);
  return slug ? readFileSync(join(runsDir, slug, `${RUN}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("an accept verdict: review-verdict accepted and a passing verdict row with its blocking count", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", ACCEPT);
  const r = verdict(f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.out.action, r.out.verdict, r.out.culprit, r.out.blocking], ["accepted", "accept", null, 0]);
  assert.deepEqual(r.out.appended, ["5/review-verdict/1/0", "rr:verdict"]);
  assert.match(ledgerTail(f), / task=5 event=review-verdict outcome=accepted ref=\.devcycle\/findings\/5-round-1\.md key=5\/review-verdict\/1\/0$/);
  assert.deepEqual(rows(f), [{ kind: "verdict", runId: RUN, taskId: "5", round: 1, blockingCount: 0, evidenceClass: "red-green", conformance: "pass" }]);
});

test("a needs-changes verdict: rejected, a failing verdict row and a review-reject event carrying the culprit", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", REJECT);
  const r = verdict(f);
  assert.deepEqual([r.out.action, r.out.culprit, r.out.blocking], ["rejected", "novel:missing-edge-case", 2]);
  assert.deepEqual(r.out.appended, ["5/review-verdict/1/0", "rr:verdict", "rr:event"]);
  const [verdictRow, event] = rows(f);
  assert.equal(verdictRow.conformance, "fail");
  assert.equal(verdictRow.blockingCount, 2);
  assert.deepEqual({ ...event, ts: "<stamp>" }, {
    kind: "event", runId: RUN, event: "review-reject", stage: "execution", task: "5",
    culprit: "novel:missing-edge-case", attributedBy: "coordinator", ts: "<stamp>",
  });
  assert.equal(event.ts, ledgerTail(f).slice(3, 23), "the event's time is its ledger line's stamp");
});

test("a re-run after a crash writes nothing twice", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", REJECT);
  verdict(f);
  assert.deepEqual(verdict(f).out.appended, []);
  assert.equal(rows(f).length, 2);
  assert.equal(readFileSync(ledgerPath(f), "utf8").match(/event=review-verdict/g).length, 1);
});

test("a later round's rejection with the same culprit still lands", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", REJECT);
  verdict(f);
  // Round 1 as an earlier session left it: a review round takes minutes, so its stamp is older.
  const stamp = ledgerTail(f).slice(3, 23);
  const [slug] = readdirSync(f.runsDir);
  assert.ok(slug, "round 1 must have written its rows");
  for (const p of [ledgerPath(f), join(f.runsDir, slug, `${RUN}.jsonl`)])
    writeFileSync(p, readFileSync(p, "utf8").replaceAll(stamp, "2026-10-08T10:05:00Z"));
  appendFileSync(ledgerPath(f), reviewRoundLine(2, 1));
  writeInto(f.repo, ".devcycle/findings/5-round-2.md", REJECT);
  assert.deepEqual(verdict(f, 2).out.appended, ["5/review-verdict/2/1", "rr:verdict", "rr:event"]);
  assert.equal(rows(f).filter((r) => r.kind === "event").length, 2);
});

// The green gate's rejection closes round 1, so the re-review after the fix is round 2 (task-dispatch
// refuses round 1 again): round 1's accept is never read for it, even when round 2's reviewer dies.
test("a re-review after a green-gate rejection is the next round, on the next review-verdict retry", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", ACCEPT);
  verdict(f);
  // task-commit.mjs's gate-fail line for round 1, keyed retry = nextRetry(.., "review-verdict") = 1.
  appendFileSync(ledgerPath(f),
    "- [2026-10-08T10:09:00Z] task=5 event=review-verdict outcome=rejected (green gate: exit 1) ref=.devcycle/evidence/5-gate.txt key=5/review-verdict/1/1\n");
  appendFileSync(ledgerPath(f), reviewRoundLine(2, 1));
  const lost = verdict(f, 2);
  assert.equal(lost.out.action, "missing-findings", "round 2's reviewer wrote nothing");
  assert.deepEqual(lost.out.appended, ["5/review-verdict/2/2"]);
  appendFileSync(ledgerPath(f), reviewRoundLine(2, 2));
  writeInto(f.repo, ".devcycle/findings/5-round-2.md", ACCEPT);
  const again = verdict(f, 2);
  assert.equal(again.out.action, "accepted");
  assert.deepEqual(again.out.appended, ["5/review-verdict/2/3", "rr:verdict"]);
  assert.match(ledgerTail(f), / event=review-verdict outcome=accepted ref=\.devcycle\/findings\/5-round-2\.md key=5\/review-verdict\/2\/3$/);
  assert.deepEqual(verdict(f, 2).out.appended, [], "a re-run after a crash reuses the written key");
});

test("the verdict header reads in any case, approved and accepted read as accept; off-contract text is still no verdict", () => {
  for (const [body, action] of [
    ["verdict: accept\n", "accepted"],
    ["**VERDICT:** Approved\n", "accepted"],
    ["Verdict: accepted\n", "accepted"],
    ["Verdict: Needs-Changes\nculprit: novel:missing-edge-case\n\n1. [high] the empty ledger is not handled\n", "rejected"],
    ["Verdict: looks good\n", "missing-findings"],
    ["Verdict: accept with nits\n", "missing-findings"],
  ]) {
    const f = fixture();
    writeInto(f.repo, ".devcycle/findings/5-round-1.md", body);
    const r = verdict(f);
    assert.equal(r.out.action, action, JSON.stringify(body));
    if (action !== "missing-findings") assert.equal(r.out.verdict, action === "accepted" ? "accept" : "needs-changes");
  }
});

test("the verdict is read from the file's own verdict lines: a quote in a fenced block is not one, and two that disagree are none", () => {
  const quoted = (verdictLine) => `\`\`\`markdown\n${verdictLine}\n\`\`\`\n`;
  for (const [name, body, action] of [
    ["a fenced lowercase accept before the real verdict", `${quoted("verdict: accept")}\n${REJECT}`, "rejected"],
    ["a fenced approved before the real verdict", `${quoted("Verdict: approved")}\n${REJECT}`, "rejected"],
    ["a fenced needs-changes before a real accept", `${quoted("Verdict: needs-changes\nCulprit: novel:quoted\n\n1. [high] quoted")}\n${ACCEPT}`, "accepted"],
    ["an unfenced accept beside the real needs-changes", `verdict: accepted\n\n${REJECT}`, "missing-findings"],
    ["a culprit only inside a fence", `Verdict: needs-changes\n\n${quoted("Culprit: novel:quoted")}\n1. [high] the empty ledger is not handled\n`, "missing-findings"],
  ]) {
    const f = fixture();
    writeInto(f.repo, ".devcycle/findings/5-round-1.md", body);
    const r = verdict(f);
    assert.equal(r.out.action, action, name);
    if (action === "rejected") assert.deepEqual([r.out.culprit, r.out.blocking], ["novel:missing-edge-case", 2], name);
    if (action === "accepted") assert.equal(r.out.blocking, 0, `${name}: a fenced finding is not one`);
  }
});

test("an accept that lists a blocking finding contradicts itself: refused as no verdict, never accepted", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", "Verdict: accept\n\n1. [high] the empty ledger is not handled\n");
  const r = verdict(f);
  assert.equal(r.out.action, "missing-findings");
  assert.match(ledgerTail(f), / outcome=rejected \(missing findings file\) /);
  assert.deepEqual(rows(f), []);
});

// Once the coordinator acts on a round's verdict — the gate rejected its accept, or the next dispatch
// went out — that round is closed: reading its verdict again would hand an unreviewed fix an accept.
test("a closed round's verdict is refused: after its green-gate rejection, or once the next round is dispatched", () => {
  for (const [name, later] of [
    ["the green gate rejected it",
      "- [2026-10-08T10:09:00Z] task=5 event=review-verdict outcome=rejected (green gate: exit 1) ref=.devcycle/evidence/5-gate.txt key=5/review-verdict/1/1\n"],
    ["round 2 is dispatched", reviewRoundLine(2, 1)],
  ]) {
    const f = fixture();
    writeInto(f.repo, ".devcycle/findings/5-round-1.md", ACCEPT);
    assert.equal(verdict(f).out.action, "accepted");
    appendFileSync(ledgerPath(f), later);
    const linesBefore = readFileSync(ledgerPath(f), "utf8");
    const again = verdict(f);
    assert.equal(again.status, 2, `${name}: ${JSON.stringify(again.out)}`);
    assert.match(again.out.error, /round 1 of task 5 is closed/, name);
    assert.equal(readFileSync(ledgerPath(f), "utf8"), linesBefore, `${name}: nothing is appended`);
  }
});

test("a missing, empty or malformed findings file re-dispatches the reviewer, with no verdict row", () => {
  const f = fixture();
  const missing = verdict(f);
  assert.equal(missing.out.action, "missing-findings");
  assert.match(ledgerTail(f), / event=review-verdict outcome=rejected \(missing findings file\) ref=\.devcycle\/findings\/5-round-1\.md key=5\/review-verdict\/1\/0$/);
  for (const [retry, body] of [[1, ""], [2, "Verdict: needs-changes\n\n1. [high] no culprit line\n"]]) {
    appendFileSync(ledgerPath(f), reviewRoundLine(1, retry));
    writeInto(f.repo, ".devcycle/findings/5-round-1.md", body);
    assert.notEqual(verdict(f).out.action, "rejected", `retry ${retry} must not read as a verdict`);
  }
  assert.deepEqual(rows(f), []);
});

test("the third missing findings file for a task is a user decision", () => {
  const f = fixture();
  const actions = [0, 1, 2].map((retry) => {
    if (retry) appendFileSync(ledgerPath(f), reviewRoundLine(1, retry));
    return verdict(f).out.action;
  });
  assert.deepEqual(actions, ["missing-findings", "missing-findings", "needs-user"]);
});

test("a rejected round 3 writes the exhausted-unresolved status and becomes a user decision", () => {
  const f = fixture(3);
  writeInto(f.repo, ".devcycle/findings/5-round-3.md", REJECT);
  const r = verdict(f, 3);
  assert.equal(r.out.action, "needs-user");
  assert.equal(r.out.loopId, "task-5-review");
  assert.equal(readFileSync(join(f.repo, ".devcycle/findings/task-5-review-status.md"), "utf8"),
    "status: exhausted-unresolved rounds: 3/3 residue: 2 carried-to: none\n");
});

// The status goes before the rejection's ledger line: a crash between them must leave a pending user
// decision, never a ledger that reads as a rejected round with a fix round still to go.
test("a round-3 rejection whose status cannot be written appends no rejection line, so the re-run finishes it", () => {
  const f = fixture(3);
  writeInto(f.repo, ".devcycle/findings/5-round-3.md", REJECT);
  const statusPath = join(f.repo, ".devcycle/findings/task-5-review-status.md");
  mkdirSync(join(statusPath, "blocker"), { recursive: true });
  const crashed = verdict(f, 3);
  assert.equal(crashed.status, 3, JSON.stringify(crashed.out));
  assert.doesNotMatch(readFileSync(ledgerPath(f), "utf8"), /event=review-verdict/);
  rmSync(statusPath, { recursive: true });
  const again = verdict(f, 3);
  assert.equal(again.out.action, "needs-user");
  assert.match(ledgerTail(f), / outcome=rejected ref=\.devcycle\/findings\/5-round-3\.md key=5\/review-verdict\/3\/0$/);
});

test("an accepted round 3 is not exhausted", () => {
  const f = fixture(3);
  writeInto(f.repo, ".devcycle/findings/5-round-3.md", ACCEPT);
  assert.equal(verdict(f, 3).out.action, "accepted");
  assert.equal(existsSync(join(f.repo, ".devcycle/findings/task-5-review-status.md")), false);
});

test("--evidence-class takes a plan's whole Evidence field and records its leading class", () => {
  const f = fixture();
  writeInto(f.repo, ".devcycle/findings/5-round-1.md", ACCEPT);
  const r = verdict(f, 1, ["--evidence-class", "green-green (behavior-preserving)"]);
  assert.equal(r.out.action, "accepted", JSON.stringify(r.out));
  assert.equal(rows(f)[0].evidenceClass, "green-green");
});

test("usage and environment errors", () => {
  const f = fixture();
  const bad = verdict(f, 1, ["--evidence-class", "tdd"]);
  assert.equal(bad.status, 2);
  assert.match(bad.out.error, /--evidence-class must be/);
  const noRound = verdict(f, 2);
  assert.equal(noRound.status, 3);
  assert.match(noRound.out.error, /no review-round line for task 5 round 2/);
});
