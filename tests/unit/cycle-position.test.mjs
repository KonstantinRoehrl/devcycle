// scripts/cycle-position.mjs's uncontrolledStop: a pending handoff that nothing stopped on purpose and
// nothing of the run still works on, dated and labelled from the last session's own transcript. Every
// cycle, run record and transcript here is a fixture under makeTempDir, never the real ~/.claude.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { uncontrolledStop } from "../../scripts/cycle-position.mjs";
import { processStartTime } from "../../scripts/file-lock.mjs";
import { gitToplevel, hashSession, recordPath } from "../../scripts/run-record.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

process.env.DEVCYCLE_RUNS_DIR = makeTempDir("cycle-position-runs-");
const RUN = "0123456789abcdef";
const LAST = "sess-last";
const ME = "sess-me";
const WORKER = "sess-worker";
const UPDATED = "2026-10-30T09:00:00Z";
const HOUR_AGO = Date.now() - 60 * 60_000;
const FIX = (name) => new URL(`../fixtures/dispatch-health/${name}.jsonl`, import.meta.url).pathname;
// The fixture's last record's stamp, to the second: what `since` reports for that transcript.
const lastStampOf = (name) =>
  new Date(JSON.parse(readFileSync(FIX(name), "utf8").trim().split("\n").at(-1)).timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");

// A cycle whose run record names LAST then ME (this session), and a Claude config dir holding LAST's
// main transcript, a copy of `transcript` (null: none) last written at `mtime`.
function world({ handoff = "pending 2026-10-30T08:00:00Z", updated = UPDATED, extra = [], transcript = "api-error", mtime = HOUR_AGO } = {}) {
  const root = realpathSync.native(makeTempDir("cycle-position-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".devcycle"));
  const statePath = join(root, ".devcycle", "state.md");
  writeFileSync(statePath, [
    "# devcycle state", `- root: ${root}`, "- stage: planning", `- run: ${RUN}`,
    ...(updated ? [`- updated: ${updated}`] : []), `- handoff: ${handoff}`, ...extra, "",
  ].join("\n"));
  const record = recordPath(gitToplevel(root), RUN);
  mkdirSync(join(record, ".."), { recursive: true });
  for (const id of [LAST, ME]) appendFileSync(record, `${JSON.stringify({ kind: "session", sessionHash: hashSession(id) })}\n`);
  const config = makeTempDir("cycle-position-config-");
  const slug = join(config, "projects", "-repo");
  mkdirSync(slug, { recursive: true });
  const file = join(slug, `${LAST}.jsonl`);
  if (transcript) {
    copyFileSync(FIX(transcript), file);
    utimesSync(file, new Date(mtime), new Date(mtime));
  }
  return { root, statePath, slug, file, env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: ME } };
}
const verdict = (w, opts = {}) => uncontrolledStop({ statePath: w.statePath, env: w.env, ...opts });
const stopOf = (w) => {
  const stop = verdict(w);
  assert.ok(stop, "expected an uncontrolled stop");
  return stop;
};

// An open implementer dispatch of WORKER's session, its ledger line and record as scripts/task-dispatch.mjs
// writes them; with an agent id, that agent's transcript is a copy of pending-tool written at `mtime`.
function dispatched(w, { agentId = null, mtime = Date.now() } = {}) {
  appendFileSync(join(w.root, ".devcycle", "ledger.md"),
    "- [2026-10-30T08:30:00Z] task=5 event=dispatched outcome=model x ref=.devcycle/briefs/5-implementer.md key=5/dispatched/0/0\n");
  mkdirSync(join(w.root, ".devcycle", "dispatch"), { recursive: true });
  writeFileSync(join(w.root, ".devcycle", "dispatch", "5-implementer-0-0.json"),
    JSON.stringify({ startedAt: "2026-10-30T08:30:00Z", sessionId: WORKER, ...(agentId ? { agentId } : {}) }));
  if (!agentId) return;
  const agents = join(w.slug, WORKER, "subagents");
  mkdirSync(agents, { recursive: true });
  const file = join(agents, `agent-${agentId}.jsonl`);
  copyFileSync(FIX("pending-tool"), file);
  utimesSync(file, new Date(mtime), new Date(mtime));
}

test("a pending handoff whose last session ended on a usage limit is uncontrolled, dated by that transcript", () => {
  const w = world();
  const stop = stopOf(w);
  assert.deepEqual([stop.stage, stop.since, stop.label], ["planning", lastStampOf("api-error"), "usage-limit"]);
  assert.deepEqual(stop.lastSession, { sessionHash: hashSession(LAST), file: w.file });
  assert.equal(stop.transcript.apiError, "You've hit your session limit · resets 5:40pm (Europe/Vienna)");
});

test("no transcript found: still uncontrolled, labelled unknown and dated by the state's updated: row, else unknown", () => {
  const stop = stopOf(world({ transcript: null }));
  assert.deepEqual([stop.stage, stop.since, stop.label, stop.transcript], ["planning", UPDATED, "unknown", null]);
  assert.deepEqual(stop.lastSession, { sessionHash: hashSession(LAST), file: null });
  assert.equal(stopOf(world({ transcript: null, updated: null })).since, "unknown");
});

test("a quiet transcript is not live; an unparseable one fails open as not live and unknown", () => {
  const quiet = stopOf(world({ transcript: "pending-bash" }));
  assert.deepEqual([quiet.since, quiet.label], [lastStampOf("pending-bash"), "unknown"]);
  const w = world({ transcript: null });
  writeFileSync(w.file, "not json\n{\"torn\":\n");
  utimesSync(w.file, new Date(HOUR_AGO), new Date(HOUR_AGO));
  const torn = stopOf(w);
  assert.deepEqual([torn.since, torn.label], [UPDATED, "unknown"]);
});

test("a running last session is live: no uncontrolled stop", () => {
  assert.equal(verdict(world({ transcript: "pending-bash", mtime: Date.now() })), null);
});

test("a ready handoff, a stopped: row or a live driver lock is never an uncontrolled stop", () => {
  assert.equal(verdict(world({ handoff: "ready 2026-10-30T08:00:00Z" })), null);
  assert.equal(verdict(world({ extra: ["- stopped: 2026-10-30T10:00:00Z .devcycle/stop.json"] })), null);
  const w = world();
  writeFileSync(join(w.root, ".devcycle", "drive.lock"), JSON.stringify({
    hostname: hostname(), state: ".devcycle/state.md", log: ".devcycle/drive.log", pid: process.pid, startTime: processStartTime(process.pid),
  }));
  assert.equal(verdict(w), null);
});

test("an open dispatch whose agent transcript is running is live; one with no agent id, or a quiet one, is not", () => {
  const running = world();
  dispatched(running, { agentId: "a1" });
  assert.equal(verdict(running), null);
  const unbound = world();
  dispatched(unbound);
  assert.equal(stopOf(unbound).label, "usage-limit");
  const quiet = world();
  dispatched(quiet, { agentId: "a1", mtime: HOUR_AGO });
  assert.equal(stopOf(quiet).label, "usage-limit");
});

test("an unreadable state file is no verdict", () => {
  assert.equal(uncontrolledStop({ statePath: join(makeTempDir("cycle-position-gone-"), ".devcycle", "state.md"), env: {} }), null);
});
