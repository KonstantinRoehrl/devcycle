import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalDir, readJournal, journalEvents, eventsByCulprit, lastRecurrence, runsObserved } from "../../scripts/journal.mjs";
import { repoSlug } from "../../scripts/run-record.mjs";

// A journal store on disk, laid out exactly as run-record.mjs writes one.
function store(lines, { repo = "/tmp/fake-repo" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "devcycle-journal-"));
  process.env.DEVCYCLE_RUNS_DIR = base;
  const dir = join(base, repoSlug(repo));
  mkdirSync(dir, { recursive: true });
  const byRun = new Map();
  for (const l of lines) {
    if (!byRun.has(l.runId)) byRun.set(l.runId, []);
    byRun.get(l.runId).push(l);
  }
  for (const [runId, ls] of byRun)
    writeFileSync(join(dir, `${runId}.jsonl`), ls.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return repo;
}

const RUN_A = "a".repeat(16);
const RUN_B = "b".repeat(16);
const ev = (runId, culprit, ts, extra = {}) => ({
  kind: "event", runId, event: "gate-fail", stage: "execution", culprit, ts, ...extra,
});

test("journalDir points at this repo's run directory under DEVCYCLE_RUNS_DIR", () => {
  const repo = store([]);
  assert.equal(journalDir(repo), join(process.env.DEVCYCLE_RUNS_DIR, repoSlug(repo)));
});

test("an absent store is journalEmpty, not an error", () => {
  process.env.DEVCYCLE_RUNS_DIR = mkdtempSync(join(tmpdir(), "devcycle-journal-"));
  const res = journalEvents({ toplevel: "/tmp/never-ran" });
  assert.equal(res.journalEmpty, true);
  assert.deepEqual(res.events, []);
  assert.equal(res.runs, 0);
});

test("a store with events is not journalEmpty even when `since` filters them all away", () => {
  const repo = store([ev(RUN_A, "friction:flaky-test-retry", "2026-08-01T00:00:00Z")]);
  const res = journalEvents({ toplevel: repo, since: "2026-08-10T00:00:00Z" });
  assert.equal(res.journalEmpty, false, "read-but-nothing-in-window is not an empty journal");
  assert.deepEqual(res.events, []);
});

test("events are read across every run file, ascending by ts", () => {
  const repo = store([
    ev(RUN_B, "friction:b", "2026-08-05T00:00:00Z"),
    ev(RUN_A, "friction:a", "2026-08-01T00:00:00Z"),
  ]);
  const { events, runs, journalEmpty } = journalEvents({ toplevel: repo });
  assert.equal(journalEmpty, false);
  assert.equal(runs, 2);
  assert.deepEqual(events.map((e) => e.culprit), ["friction:a", "friction:b"]);
});

test("a malformed journal line throws rather than being skipped", () => {
  const repo = store([]);
  const dir = join(process.env.DEVCYCLE_RUNS_DIR, repoSlug(repo));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${RUN_A}.jsonl`), "{not json\n");
  assert.throws(() => readJournal(repo), /malformed journal line/);
});

test("eventsByCulprit drops null-culprit events and keeps the rest keyed", () => {
  const repo = store([
    ev(RUN_A, null, "2026-08-01T00:00:00Z"),
    ev(RUN_A, "friction:a", "2026-08-02T00:00:00Z"),
    ev(RUN_A, "friction:a", "2026-08-03T00:00:00Z"),
  ]);
  const { events } = journalEvents({ toplevel: repo });
  const map = eventsByCulprit(events);
  assert.deepEqual([...map.keys()], ["friction:a"]);
  assert.equal(map.get("friction:a").length, 2);
});

test("lastRecurrence returns the newest ts for an id, null for an id never seen", () => {
  const repo = store([
    ev(RUN_A, "friction:a", "2026-08-02T00:00:00Z"),
    ev(RUN_A, "friction:a", "2026-08-09T00:00:00Z"),
  ]);
  const { events } = journalEvents({ toplevel: repo });
  assert.equal(lastRecurrence(events, "friction:a"), "2026-08-09T00:00:00Z");
  assert.equal(lastRecurrence(events, "friction:never"), null);
});

test("runsObserved counts distinct runs at or after `since`", () => {
  const repo = store([
    ev(RUN_A, "friction:a", "2026-08-01T00:00:00Z"),
    ev(RUN_B, "friction:a", "2026-08-09T00:00:00Z"),
  ]);
  const { events } = journalEvents({ toplevel: repo });
  assert.equal(runsObserved(events), 2);
  assert.equal(runsObserved(events, "2026-08-05T00:00:00Z"), 1);
  assert.equal(runsObserved(events, "2026-09-01T00:00:00Z"), 0);
});

test("attributedBy is carried through to the event object", () => {
  const repo = store([ev(RUN_A, "novel:brief-omitted-a-field", "2026-08-01T00:00:00Z", { attributedBy: "coordinator" })]);
  const { events } = journalEvents({ toplevel: repo });
  assert.equal(events[0].attributedBy, "coordinator");
});
