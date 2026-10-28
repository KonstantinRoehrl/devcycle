// scripts/dispatch-health.mjs owns the dispatch-ended ledger event: one line per dead dispatch, a cap
// of one redispatch per role per task, and the round a reviewer death leaves open.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { nextReviewRound, parseLedgerLine, taskEntries } from "../../scripts/task-ledger.mjs";
import {
  DEATH_CAP, DISPATCH_ENDED, QUIET_MS, UNBOUND_MS, deathRoute, deathsOf, dispatchHealth, endedOutcome, endedRole, formatDispatch, lastMilestone,
  markEnded, recordDeath,
} from "../../scripts/dispatch-health.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";

const PREAMBLE = "Plan: `docs/plan.md`\n\n";
const line = (text) => `- [2026-10-28T08:00:00Z] ${text}\n`;
function ledger(lines = []) {
  const root = makeTempDir("dispatch-health-ledger-");
  writeInto(root, ".devcycle/ledger.md", PREAMBLE + lines.map(line).join(""));
  return join(root, ".devcycle/ledger.md");
}
const ended = (path) => readFileSync(path, "utf8").split("\n").filter((l) => l.includes(`event=${DISPATCH_ENDED}`));

test("the outcome names the role, and only a dispatch-ended outcome reads back as one", () => {
  assert.equal(endedOutcome("implementer"), "without output (implementer)");
  assert.equal(endedRole("without output (reviewer)"), "reviewer");
  assert.equal(endedRole("rejected (missing report file)"), null);
});

test("a death is one line keyed to the dead dispatch's round, and recording it again appends nothing", () => {
  const path = ledger(["task=5 event=dispatched outcome=model x ref=.devcycle/briefs/5-implementer.md key=5/dispatched/0/0"]);
  const first = recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-0.json" });
  assert.equal(first.next, "redispatch-implementer");
  const again = recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-0.json" });
  assert.equal(again.next, "redispatch-implementer");
  const lines = ended(path);
  assert.equal(lines.length, 1);
  assert.match(lines[0], / task=5 event=dispatch-ended outcome=without output \(implementer\) ref=\.devcycle\/dispatch\/5-implementer-0-0\.json key=5\/dispatch-ended\/0\/0$/);
});

test("a second death of the same role is the user's; a death of the other role is counted apart", () => {
  const path = ledger();
  recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-0.json" });
  assert.equal(recordDeath({ ledgerPath: path, task: "5", role: "reviewer", round: 1, recordPath: ".devcycle/dispatch/5-reviewer-1-0.json" }).next, "redispatch-reviewer");
  assert.equal(recordDeath({ ledgerPath: path, task: "5", role: "implementer", round: 0, recordPath: ".devcycle/dispatch/5-implementer-0-1.json" }).next, "needs-user");
  const entries = taskEntries(path, "5");
  assert.deepEqual([deathsOf(entries, "implementer"), deathsOf(entries, "reviewer"), DEATH_CAP], [2, 1, 1]);
  assert.equal(deathRoute(entries, "nobody"), "needs-user");
});

test("a reviewer death leaves its round open, so the redispatch reviews the same round", () => {
  const entries = [
    "task=5 event=review-round outcome=round 2 ref=.devcycle/briefs/5-reviewer-round-2.md key=5/review-round/2/1",
    "task=5 event=dispatch-ended outcome=without output (reviewer) ref=.devcycle/dispatch/5-reviewer-2-1.json key=5/dispatch-ended/2/0",
  ].map((l) => parseLedgerLine(line(l).trim()));
  assert.equal(nextReviewRound(entries), 2);
});

const SID = "sess-abcdef123456";
const FIX = (name) => new URL(`../fixtures/dispatch-health/${name}.jsonl`, import.meta.url).pathname;
const T0 = Date.parse("2026-10-28T08:00:00Z");
const DISPATCHED = "- [2026-10-28T08:00:00Z] task=5 event=dispatched outcome=model x ref=.devcycle/briefs/5-implementer.md key=5/dispatched/0/0\n";

// A repo whose ledger holds task 5's dispatch and its record, and a Claude config dir whose project
// holds this session's main transcript and the named subagent transcripts (agent id → fixture).
function world({ agents = { a1: "pending-tool" }, record = { startedAt: "2026-10-28T08:00:00Z", sessionId: SID }, mtime = T0 + 60_000, meta = {} } = {}) {
  const root = makeRepo();
  writeInto(root, ".devcycle/ledger.md", PREAMBLE + DISPATCHED);
  writeInto(root, ".devcycle/dispatch/5-implementer-0-0.json", JSON.stringify(record) + "\n");
  const config = makeTempDir("dispatch-health-config-");
  const slug = join(config, "projects", "-repo");
  mkdirSync(join(slug, SID, "subagents"), { recursive: true });
  writeFileSync(join(slug, `${SID}.jsonl`), "");
  for (const [id, fixture] of Object.entries(agents)) {
    const file = join(slug, SID, "subagents", `agent-${id}.jsonl`);
    copyFileSync(FIX(fixture), file);
    utimesSync(file, new Date(mtime), new Date(mtime));
    if (meta[id]) writeFileSync(join(slug, SID, "subagents", `agent-${id}.meta.json`), JSON.stringify(meta[id]));
  }
  return { root, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, ledgerPath: join(root, ".devcycle/ledger.md") };
}
const health = (w, opts = {}) => dispatchHealth({ root: w.root, ledgerPath: w.ledgerPath, sessionId: SID, env: w.env, ...opts });
const stateAt = (w, now) => health(w, { now })[0].state;

test("a pending tool call is running until the tool ceiling, then the transcript's silence decides", () => {
  const w = world({ mtime: T0 + 60_000 });
  assert.equal(stateAt(w, T0 + 60_000 + 5 * 60_000), "running");
  assert.equal(stateAt(w, T0 + 60_000 + QUIET_MS + 1), "quiet");
});

test("every recognised end reads ended; with no report it is ended-without-output", () => {
  for (const fixture of ["handback", "interrupted", "final-text", "torn"]) {
    const w = world({ agents: { a1: fixture } });
    assert.equal(stateAt(w, T0 + 3 * 60_000), "ended-without-output", fixture);
  }
  assert.equal(stateAt(world({ agents: { a1: "thinking-only" } }), T0 + 3 * 60_000), "running", "a mid-stream thinking record is not an end");
  assert.equal(stateAt(world({ meta: { a1: { finished: true } } }), T0 + 2 * 60_000), "ended-without-output", "meta.json finished");
});

test("a report written after the dispatch started makes it ended-with-output; one from before does not", () => {
  const w = world({ agents: { a1: "handback" } });
  writeInto(w.root, ".devcycle/reports/5.md", "report\n");
  utimesSync(join(w.root, ".devcycle/reports/5.md"), new Date(T0 + 90_000), new Date(T0 + 90_000));
  assert.equal(stateAt(w, T0 + 3 * 60_000), "ended-with-output");
  utimesSync(join(w.root, ".devcycle/reports/5.md"), new Date(T0 - 60_000), new Date(T0 - 60_000));
  assert.equal(stateAt(w, T0 + 3 * 60_000), "ended-without-output");
});

test("binding: of two transcripts naming one brief, the one started after the record binds, and its agent id is kept", () => {
  const w = world({ agents: { a1: "pending-tool", a2: "handback" }, record: { startedAt: "2026-10-28T08:00:02Z", sessionId: SID } });
  // a1's first record (08:00:01) predates the record: an earlier retry's agent. a2 is rewritten to start after it.
  const a2 = join(w.env.CLAUDE_CONFIG_DIR, "projects", "-repo", SID, "subagents", "agent-a2.jsonl");
  writeFileSync(a2, readFileSync(a2, "utf8").replace("2026-10-28T08:00:01.000Z", "2026-10-28T08:00:03.000Z"));
  const [d] = health(w, { now: T0 + 3 * 60_000 });
  assert.equal(d.agentId, "a2");
  assert.equal(JSON.parse(readFileSync(join(w.root, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8")).agentId, "a2");
});

test("another session's dispatch and a missing transcript: never classified, and unbound until UNBOUND_MS", () => {
  assert.deepEqual(health(world({ record: { startedAt: "2026-10-28T08:00:00Z", sessionId: "other" } }), { now: T0 }), []);
  const w = world({ agents: {} });
  const [early] = health(w, { now: T0 + 60_000, record: true });
  assert.deepEqual([early.state, early.action, early.recorded], ["unbound", "wait", false]);
  const [late] = health(w, { now: T0 + UNBOUND_MS + 1, record: true });
  assert.deepEqual([late.state, late.action, late.recorded], ["unbound", "redispatch-implementer", true]);
});

// A world whose session has no transcripts at all, or whose session directory has no subagents/.
function unlocatable({ slug = false, role = "implementer" } = {}) {
  const w = world({ agents: {} });
  const config = makeTempDir("dispatch-health-config-");
  if (slug) mkdirSync(join(config, "projects", "-repo", SID), { recursive: true });
  if (role === "reviewer") {
    writeInto(w.root, ".devcycle/ledger.md", PREAMBLE + REVIEWING);
    writeInto(w.root, ".devcycle/dispatch/5-reviewer-1-0.json", JSON.stringify({ startedAt: "2026-10-28T08:00:00Z", sessionId: SID }) + "\n");
  }
  return { ...w, env: { ...process.env, CLAUDE_CONFIG_DIR: config } };
}
const REVIEWING = "- [2026-10-28T08:00:00Z] task=5 event=review-round outcome=round 1 ref=.devcycle/briefs/5-reviewer-round-1.md key=5/review-round/1/0\n";
const noDeathLine = (w) => assert.equal(ended(w.ledgerPath).length, 0);

test("with no locatable transcripts a dispatch only waits: unbound, never recorded dead", () => {
  const w = unlocatable();
  const [d] = health(w, { now: T0 + 10 * 60_000, record: true });
  assert.deepEqual([d.state, d.transcriptsFound, d.action, d.recorded], ["unbound", false, "wait", false]);
  noDeathLine(w);
});

test("an unbound dispatch whose owed output is already present is routed on, never recorded dead", () => {
  const owed = { implementer: ".devcycle/reports/5.md", reviewer: ".devcycle/findings/5-round-1.md" };
  const route = { implementer: "intake", reviewer: "verdict" };
  for (const role of ["implementer", "reviewer"]) {
    const w = unlocatable({ slug: true, role });
    writeInto(w.root, owed[role], "output\n");
    utimesSync(join(w.root, owed[role]), new Date(T0 + 90_000), new Date(T0 + 90_000));
    const [d] = health(w, { now: T0 + 10 * 60_000, record: true });
    assert.deepEqual([d.state, d.action, d.recorded], ["unbound", route[role], false], role);
    noDeathLine(w);
  }
});

test("a dispatch the located session never bound, with no output past UNBOUND_MS, is the genuine death", () => {
  for (const role of ["implementer", "reviewer"]) {
    const w = unlocatable({ slug: true, role });
    const [d] = health(w, { now: T0 + 10 * 60_000, record: true });
    assert.deepEqual([d.state, d.transcriptsFound, d.action, d.recorded], ["unbound", true, `redispatch-${role}`, true], role);
  }
});

test("the CLI without a session id fails loudly instead of reporting nothing to classify", () => {
  const w = world();
  for (const args of [[], ["--json"]]) {
    const r = spawnSync(process.execPath, [new URL("../../scripts/dispatch-health.mjs", import.meta.url).pathname, ...args],
      { cwd: w.root, encoding: "utf8", env: { ...w.env, CLAUDE_CODE_SESSION_ID: "" } });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /CLAUDE_CODE_SESSION_ID/);
    assert.doesNotMatch(r.stdout, /nothing to classify|"ok":true/);
  }
});

test("an unbound dispatch is never recorded while an unaccounted live agent could be it", () => {
  const w = world({ agents: { a9: "pending-tool" } });
  const a9 = join(w.env.CLAUDE_CONFIG_DIR, "projects", "-repo", SID, "subagents", "agent-a9.jsonl");
  writeFileSync(a9, readFileSync(a9, "utf8").replace(".devcycle/briefs/5-implementer.md", "a research task"));
  const [d] = health(w, { now: T0 + UNBOUND_MS + 1, record: true });
  assert.deepEqual([d.state, d.liveUnknown, d.action, d.recorded], ["unbound", 1, "wait", false]);
});

test("--record records a death once and prints the route; quiet asks for a stop, and --stopped records it", () => {
  const dead = world({ agents: { a1: "interrupted" } });
  const [d] = health(dead, { now: T0 + 3 * 60_000, record: true });
  assert.deepEqual([d.action, d.recorded], ["redispatch-implementer", true]);
  assert.equal(readFileSync(dead.ledgerPath, "utf8").match(/event=dispatch-ended/g).length, 1);
  const quiet = world({ mtime: T0 + 60_000 });
  const now = T0 + 60_000 + QUIET_MS + 1;
  const [q] = health(quiet, { now, record: true });
  assert.deepEqual([q.state, q.action, q.recorded], ["quiet", "stop-agent a1", false]);
  const [s] = health(quiet, { now, record: true, stopped: "5" });
  assert.deepEqual([s.action, s.recorded], ["redispatch-implementer", true]);
});

test("the CLI prints one compact line per dispatch and never transcript content", () => {
  const w = world({ agents: { a1: "interrupted" } });
  const r = spawnSync(process.execPath, [new URL("../../scripts/dispatch-health.mjs", import.meta.url).pathname, "--record"],
    { cwd: w.root, encoding: "utf8", env: { ...w.env, CLAUDE_CODE_SESSION_ID: SID } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^task 5 implementer round 0 · ended-without-output · \d+m · 2 tools · idle \d+m · last Bash → redispatch-implementer \(recorded\)\n$/);
  assert.doesNotMatch(r.stdout, /Your brief|interrupted by user/);
});

test("the sensor's end mark binds by brief and session and records whether the output exists", () => {
  const w = world({ agents: { a1: "handback" } });
  const transcriptPath = join(w.env.CLAUDE_CONFIG_DIR, "projects", "-repo", SID, "subagents", "agent-a1.jsonl");
  assert.equal(markEnded({ root: w.root, sessionId: SID, transcriptPath, agentId: "a1", now: T0 + 2 * 60_000 }), true);
  const record = JSON.parse(readFileSync(join(w.root, ".devcycle/dispatch/5-implementer-0-0.json"), "utf8"));
  assert.deepEqual([record.agentId, record.endedAt, record.outputPresent], ["a1", "2026-10-28T08:02:00.000Z", false]);
  assert.equal(markEnded({ root: w.root, sessionId: "other", transcriptPath, agentId: "a1" }), false);
});

test("a long non-task dispatch is in flight with its last milestone until the final one or its end", () => {
  const w = world({ agents: { p1: "pending-tool" } });
  const p1 = join(w.env.CLAUDE_CONFIG_DIR, "projects", "-repo", SID, "subagents", "agent-p1.jsonl");
  writeFileSync(p1, readFileSync(p1, "utf8").replace(".devcycle/briefs/5-implementer.md", ".devcycle/progress/map-scripts.log"));
  writeInto(w.root, ".devcycle/progress/map-scripts.log", "2026-10-28T08:01:00Z 1/3 listed the scripts\n2026-10-28T08:02:00Z 2/3 traced the ledger readers\n");
  const progress = health(w, { now: T0 + 3 * 60_000 }).find((d) => d.kind === "progress");
  assert.deepEqual([progress.id, progress.state, progress.action, progress.milestone], ["map-scripts", "running", "wait", { i: 2, n: 3, text: "traced the ledger readers" }]);
  assert.match(formatDispatch(progress), /^progress map-scripts · running · 2\/3 traced the ledger readers · 2m · /);
  writeInto(w.root, ".devcycle/progress/map-scripts.log", "2026-10-28T08:03:00Z 3/3 wrote the map\n");
  assert.equal(health(w, { now: T0 + 4 * 60_000 }).some((d) => d.kind === "progress"), false);
  assert.equal(lastMilestone("garbage\n"), null);
});
