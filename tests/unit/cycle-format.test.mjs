// scripts/cycle-format.mjs: the cycle format version, its migrations and the settle that runs them.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";
import {
  CURRENT_FORMAT, MIGRATIONS, contractErrors, formatStopMessage, formatVerdict, isPendingRename, liveLedgerPatterns, settleFormat, stampFormat,
} from "../../scripts/cycle-format.mjs";
import { checkState } from "../../scripts/resume-check.mjs";
import { ledgerPlan, parseLedgerLine } from "../../scripts/task-ledger.mjs";
import { ledgerSlotState } from "../../scripts/ledger-slot.mjs";
import { acquireDriveLock, releaseDriveLock } from "../../scripts/drive-lock.mjs";

const FROZEN = join(process.cwd(), "tests/fixtures/cycle-format/format-0");

// A throwaway repo holding the frozen state file and one of the frozen ledgers.
function frozenCycle(ledgerName = "ledger.md") {
  const repo = realpathSync(makeRepo());
  mkdirSync(join(repo, ".devcycle"), { recursive: true });
  writeInto(repo, "docs/plan.md", "# plan\n");
  const statePath = join(repo, ".devcycle/state.md");
  const text = readFileSync(join(FROZEN, "state.md"), "utf8").replace("- root: /repo", `- root: ${repo}`).replace("- branch: feat/old-cycle (cut from dev at 0000000)", "- branch: main");
  writeFileSync(statePath, text);
  if (ledgerName) copyFileSync(join(FROZEN, ledgerName), join(repo, ".devcycle/ledger.md"));
  return { repo, statePath, ledgerPath: join(repo, ".devcycle/ledger.md") };
}
const settle = (c, opts = {}) => settleFormat(c.statePath, { checked: checkState(c.statePath), ...opts });
const read = (p) => readFileSync(p, "utf8");

test("the verdict: no row is format 0, equal, newer, unparseable", () => {
  assert.deepEqual(formatVerdict("# devcycle state\n- stage: planning\n"), { verdict: "older", from: 0 });
  assert.deepEqual(formatVerdict(`- format: ${CURRENT_FORMAT}\n`), { verdict: "equal", from: CURRENT_FORMAT });
  assert.deepEqual(formatVerdict(`- format: ${CURRENT_FORMAT + 1}\n`), { verdict: "newer", from: CURRENT_FORMAT + 1 });
  assert.deepEqual(formatVerdict("- format: one\n"), { verdict: "unparseable", row: "one" });
});

test("the stop messages name what to do", () => {
  assert.match(formatStopMessage({ verdict: "newer", from: 9 }), /claude plugin update devcycle@devcycle/);
  assert.match(formatStopMessage({ verdict: "newer", from: 9 }), /[Rr]estart/);
  assert.match(formatStopMessage({ verdict: "unparseable", row: "one" }), /"one"/);
});

test("stampFormat replaces the row, or adds it straight under the header", () => {
  assert.equal(stampFormat("# devcycle state\n- stage: x\n", 1), "# devcycle state\n- format: 1\n- stage: x\n");
  assert.equal(stampFormat("# devcycle state\n- format: 0\n- stage: x\n", 1), "# devcycle state\n- format: 1\n- stage: x\n");
});

test("a state with only the row to add crosses silently, with no backup", () => {
  const c = frozenCycle(null);
  const r = settle(c);
  assert.equal(r.status, "migrated");
  assert.deepEqual(r.report, []);
  assert.match(read(c.statePath), /^- format: 1$/m);
  assert.equal(existsSync(join(c.repo, ".devcycle/format-backup-0")), false);
});

test("an unbackticked header naming the state's plan is normalized, backed up and reported", () => {
  const c = frozenCycle("ledger-unbackticked.md");
  const original = read(c.ledgerPath);
  assert.equal(ledgerSlotState({ root: c.repo, plan: "docs/plan.md", run: null }), "stale");
  const r = settle(c);
  assert.equal(r.status, "migrated");
  assert.equal(ledgerPlan(c.ledgerPath), "docs/plan.md");
  assert.equal(ledgerSlotState({ root: c.repo, plan: "docs/plan.md", run: null }), "fresh");
  assert.equal(read(join(c.repo, ".devcycle/format-backup-0/ledger.md")), original);
  assert.ok(r.report.some((l) => l.includes("ledger.md")), r.report.join("\n"));
  assert.ok(r.report.some((l) => l.includes(".devcycle/format-backup-0")), r.report.join("\n"));
});

test("a headerless ledger asks, changes nothing until answered, and each answer settles it", () => {
  const asked = frozenCycle("ledger-headerless.md");
  const before = [read(asked.statePath), read(asked.ledgerPath)];
  const q = settle(asked);
  assert.equal(q.status, "question");
  assert.match(q.question, /2 events/);
  assert.deepEqual([read(asked.statePath), read(asked.ledgerPath)], before);

  const yes = frozenCycle("ledger-headerless.md");
  assert.equal(settle(yes, { answer: "yes" }).status, "migrated");
  assert.equal(ledgerPlan(yes.ledgerPath), "docs/plan.md");
  assert.equal(ledgerSlotState({ root: yes.repo, plan: "docs/plan.md", run: null }), "fresh");

  const no = frozenCycle("ledger-headerless.md");
  assert.equal(settle(no, { answer: "no" }).status, "migrated");
  assert.equal(ledgerPlan(no.ledgerPath), null);
  assert.match(read(no.statePath), /^- format: 1$/m);
  assert.equal(ledgerSlotState({ root: no.repo, plan: "docs/plan.md", run: null }), "stale");
});

test("a headerless ledger under a state with no plan is left alone and asks nothing", () => {
  const c = frozenCycle("ledger-headerless.md");
  writeFileSync(c.statePath, read(c.statePath).replace("- plan: docs/plan.md", "- plan: none"));
  assert.equal(settle(c).status, "migrated");
  assert.equal(ledgerPlan(c.ledgerPath), null);
});

test("lines the parser rejects are counted once, in the migration report, and still ignored after it", () => {
  const c = frozenCycle("ledger.md");
  const r = settle(c);
  assert.ok(r.report.some((l) => /1 event-shaped line/.test(l)), r.report.join("\n"));
  assert.equal(read(c.ledgerPath).split("\n").map(parseLedgerLine).filter(Boolean).length, 2);
  assert.deepEqual(settle(c).report, [], "a second settle reported again");
});

test("every step is a no-op on a current-format file, so a dropped row re-runs harmlessly", () => {
  const c = frozenCycle("ledger.md");
  settle(c);
  const ledger = read(c.ledgerPath);
  writeFileSync(c.statePath, read(c.statePath).replace(/^- format: \d+\n/m, ""));
  const r = settle(c);
  assert.equal(r.status, "migrated");
  assert.equal(read(c.ledgerPath), ledger);
});

test("the frozen cycle resolves to the same position after migrating", () => {
  const c = frozenCycle("ledger.md");
  settle(c);
  const lines = read(c.ledgerPath).split("\n").map(parseLedgerLine).filter(Boolean);
  assert.deepEqual(lines.map((l) => [l.task, l.event]), [["1", "dispatched"], ["1", "committed"]]);
  assert.equal(ledgerSlotState({ root: c.repo, plan: "docs/plan.md", run: "00000000000000a1" }), "fresh");
  assert.equal(checkState(c.statePath).format.verdict, "equal");
});

test("a live driver blocks the settle, unless this session is that driver's", () => {
  const c = frozenCycle("ledger-unbackticked.md");
  const before = read(c.ledgerPath);
  const { lock } = acquireDriveLock(c.repo, { statePath: c.statePath, logPath: join(c.repo, ".devcycle/drive.log"), tokenHash: null });
  try {
    assert.equal(settle(c).status, "driver-live");
    assert.equal(read(c.ledgerPath), before);
    assert.equal(settle(c, { driven: true }).status, "migrated");
  } finally {
    releaseDriveLock(c.repo, lock);
  }
});

test("another session's migration lock stops with a message, changing nothing", () => {
  const c = frozenCycle(null);
  const lockPath = `${c.statePath}.lock`;
  // This live process holds it, so it can never be reclaimed as stale.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), hostname: hostname() }));
  const r = settle(c, { lockTimeoutMs: 50 });
  assert.equal(r.status, "locked");
  assert.match(r.detail, /another session/i);
  assert.equal(formatVerdict(read(c.statePath)).verdict, "older");
});

test("a stage: done file, a stale file and a current file are not migrated", () => {
  const done = frozenCycle(null);
  writeFileSync(done.statePath, read(done.statePath).replace("- stage: execution", "- stage: done"));
  assert.equal(settle(done).status, "none");
  assert.doesNotMatch(read(done.statePath), /^- format:/m);

  const stale = frozenCycle(null);
  writeFileSync(stale.statePath, read(stale.statePath).replace("- plan: docs/plan.md", "- plan: docs/gone.md"));
  assert.equal(settle(stale).status, "none");
  assert.doesNotMatch(read(stale.statePath), /^- format:/m);

  const current = frozenCycle(null);
  settle(current);
  assert.equal(settle(current).status, "none");
});

test("a stage a pending step renames is rewritten, and does not read as stale first", () => {
  const steps = [{ from: 0, to: 1, renames: { "old-stage": "planning" }, migrate: (files) => ({ files, notes: [] }) }];
  assert.equal(isPendingRename("old-stage", 0, steps), true);
  assert.equal(isPendingRename("old-stage", 1, steps), false);
  assert.equal(isPendingRename("planning", 0, steps), false);
  const c = frozenCycle(null);
  writeFileSync(c.statePath, read(c.statePath).replace("- stage: execution", "- stage: old-stage"));
  const r = settleFormat(c.statePath, { checked: { ok: true, stage: "old-stage", format: { verdict: "older", from: 0 } }, migrations: steps });
  assert.equal(r.status, "migrated");
  assert.match(read(c.statePath), /^- stage: planning$/m);
});

test("a throwing step leaves every file as it was and reports a failure", () => {
  const c = frozenCycle("ledger-unbackticked.md");
  const before = [read(c.statePath), read(c.ledgerPath)];
  const steps = [{ from: 0, to: 1, renames: {}, migrate: () => { throw new Error("boom"); } }];
  const r = settle(c, { migrations: steps });
  assert.equal(r.status, "failed");
  assert.match(r.detail, /boom/);
  assert.deepEqual([read(c.statePath), read(c.ledgerPath)], before);
});

test("a failed write restores from the backup, and a re-run reuses that backup", () => {
  const c = frozenCycle("ledger-unbackticked.md");
  const before = [read(c.statePath), read(c.ledgerPath)];
  let writes = 0;
  const failOnState = (path, text) => {
    writes++;
    if (path === c.statePath && writes === 2) throw new Error("disk full");
    writeFileSync(path, text);
  };
  const r = settle(c, { write: failOnState });
  assert.equal(r.status, "failed");
  assert.deepEqual([read(c.statePath), read(c.ledgerPath)], before);
  assert.equal(formatVerdict(read(c.statePath)).verdict, "older");
  writeFileSync(c.ledgerPath, "Plan: docs/plan.md\nhalf-migrated\n");
  settleFormat(c.statePath, { checked: checkState(c.statePath), answer: "no" });
  assert.equal(read(join(c.repo, ".devcycle/format-backup-0/ledger.md")), before[1], "a re-run overwrote the backup");
});

test("the migration list has no gaps from 0 to the current format", () => {
  assert.deepEqual(MIGRATIONS.map((m) => [m.from, m.to]), Array.from({ length: CURRENT_FORMAT }, (_, i) => [i, i + 1]));
});

test("a tmp dir with no git and no .devcycle parent still settles", () => {
  const dir = makeTempDir("cycle-format-");
  const statePath = join(dir, "state.md");
  writeFileSync(statePath, "# devcycle state\n- stage: planning\n");
  assert.equal(settleFormat(statePath, { checked: checkState(statePath) }).status, "migrated");
});

const LIVE = { stages: ["planning", "execution"], knobs: ["profile", "gitPolicy"], stateRows: ["format", "stage"], ledger: { eventLine: "a", planHeader: "b", runHeader: "c" } };
const CONTRACT = { format: 1, retiredKnobs: [], ...structuredClone(LIVE) };
const judge = (live, contract = CONTRACT, opts = {}) => contractErrors(live, contract, { current: 1, migrations: [], knobRenames: {}, ...opts });

test("contract: a matching surface passes", () => {
  assert.deepEqual(judge(LIVE), []);
});

test("contract: anything added must be recorded in the fixture in the same change", () => {
  for (const live of [{ ...LIVE, stages: [...LIVE.stages, "new"] }, { ...LIVE, knobs: [...LIVE.knobs, "new"] }, { ...LIVE, stateRows: [...LIVE.stateRows, "new"] }])
    assert.match(judge(live)[0], /new.*tests\/fixtures\/cycle-format-contract\.json/);
});

test("contract: a removed stage fails unless a step's renames declares it", () => {
  const live = { ...LIVE, stages: ["execution"] };
  assert.match(judge(live)[0], /stage "planning"/);
  assert.deepEqual(judge(live, CONTRACT, { migrations: [{ renames: { planning: "execution" } }] }), []);
});

test("contract: a removed knob fails unless renamed or declared retired", () => {
  const live = { ...LIVE, knobs: ["profile"] };
  assert.match(judge(live)[0], /knob "gitPolicy"/);
  assert.deepEqual(judge(live, CONTRACT, { knobRenames: { gitPolicy: "git" } }), []);
  assert.deepEqual(judge(live, { ...CONTRACT, retiredKnobs: ["gitPolicy"] }), []);
});

test("contract: a removed state row or a changed ledger pattern fails, and says to bump", () => {
  assert.match(judge({ ...LIVE, stateRows: ["stage"] })[0], /row "format".*format bump/);
  assert.match(judge({ ...LIVE, ledger: { ...LIVE.ledger, eventLine: "z" } })[0], /eventLine.*format bump/);
});

test("contract: a fixture at another format than the code fails until it is refreshed", () => {
  assert.match(judge(LIVE, CONTRACT, { current: 2 })[0], /format 1.*format 2/);
});

test("contract: the live patterns are the readers' own", () => {
  const live = liveLedgerPatterns();
  assert.ok(new RegExp(live.planHeader, "m").test("Plan: `x`"));
  assert.ok(new RegExp(live.runHeader, "m").test("Run: `0123456789abcdef`"));
  assert.ok(new RegExp(live.eventLine).test("- [s] task=1 event=e outcome=o ref=r"));
});
