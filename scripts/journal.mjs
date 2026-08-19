#!/usr/bin/env node
// Reads devcycle's friction journal — the run records scripts/run-record.mjs appends — as the
// learn loop's first corpus. Structured lines only: ids, enum values and timestamps, so nothing
// here can carry message text into a caller's transcript.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { repoSlug } from "./run-record.mjs";

export const journalDir = (toplevel) =>
  join(process.env.DEVCYCLE_RUNS_DIR ?? join(homedir(), ".claude", "devcycle", "runs"), repoSlug(toplevel));

// A store that does not exist yet is "this repo has never run", not a failure — the same
// distinction dream.mjs's readTranscriptsOrFail draws. A store that exists but holds a line we
// cannot parse IS a failure: silently skipping it would under-report recurrences, and an
// under-report reads as "the lesson held".
export function readJournal(toplevel) {
  const dir = journalDir(toplevel);
  if (!existsSync(dir)) return { runs: 0, lines: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const lines = [];
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8");
    text.split("\n").forEach((raw, i) => {
      if (!raw.trim()) return;
      try {
        lines.push(JSON.parse(raw));
      } catch (e) {
        throw new Error(`malformed journal line ${f}:${i + 1}: ${e.message}`);
      }
    });
  }
  return { runs: files.length, lines };
}

// Exported because scripts/verification.mjs guards its observation windows with the same
// predicate; one definition, two callers — the same rule scripts/semver.mjs:2 already follows.
export const isIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

export function journalEvents({ toplevel, since = null }) {
  const { runs, lines } = readJournal(toplevel);
  const all = lines
    .filter((l) => l.kind === "event")
    .map((l) => ({
      runId: l.runId,
      event: l.event,
      stage: l.stage,
      task: l.task ?? null,
      culprit: l.culprit ?? null,
      attributedBy: l.attributedBy ?? null,
      ts: l.ts,
    }))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  // journalEmpty describes the STORE, never the window: a caller that reads "empty" for a
  // journal that simply has nothing since the checkpoint would fall through to mining a corpus
  // the journal already covers, and would report the cold-start message on a warm repo.
  const journalEmpty = all.length === 0;
  const sinceMs = isIso(since) ? Date.parse(since) : null;
  const events = sinceMs === null ? all : all.filter((e) => Date.parse(e.ts) >= sinceMs);
  return { journalEmpty, events, runs };
}

export function eventsByCulprit(events) {
  const map = new Map();
  for (const e of events) {
    if (!e.culprit) continue;
    if (!map.has(e.culprit)) map.set(e.culprit, []);
    map.get(e.culprit).push(e);
  }
  for (const list of map.values()) list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return map;
}

export const lastRecurrence = (events, culpritId) =>
  events.filter((e) => e.culprit === culpritId).map((e) => e.ts).sort().at(-1) ?? null;

export function runsObserved(events, since = null) {
  const sinceMs = isIso(since) ? Date.parse(since) : null;
  const ids = new Set();
  for (const e of events) {
    if (sinceMs !== null && Date.parse(e.ts) < sinceMs) continue;
    ids.add(e.runId);
  }
  return ids.size;
}
