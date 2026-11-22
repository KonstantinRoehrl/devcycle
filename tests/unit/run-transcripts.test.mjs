// scripts/run-transcripts.mjs finds this run's own session transcripts and nothing else: one project
// directory level deep, matched against the run record's session hashes, never by a raw id.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashSession } from "../../scripts/run-record.mjs";
import { lastSession, runTranscripts } from "../../scripts/run-transcripts.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

// A Claude config dir whose projects hold an empty main transcript per named session (slug → ids).
function config(layout) {
  const dir = makeTempDir("run-transcripts-config-");
  for (const [slug, ids] of Object.entries(layout)) {
    mkdirSync(join(dir, "projects", slug), { recursive: true });
    for (const id of ids) writeFileSync(join(dir, "projects", slug, `${id}.jsonl`), "");
  }
  return { CLAUDE_CONFIG_DIR: dir };
}
const transcript = (env, slug, id) => join(env.CLAUDE_CONFIG_DIR, "projects", slug, `${id}.jsonl`);
const session = (id) => ({ kind: "session", sessionHash: hashSession(id) });
const byFile = (a, b) => a.file.localeCompare(b.file);

test("lists the run's own sessions under every project directory, and no other session's", () => {
  const env = config({ "-repo": ["sess-a", "sess-other"], "-elsewhere": ["sess-b"] });
  const found = runTranscripts({ sessionHashes: [hashSession("sess-a"), hashSession("sess-b")], env });
  assert.deepEqual(found.sort(byFile), [
    { sessionHash: hashSession("sess-b"), file: transcript(env, "-elsewhere", "sess-b") },
    { sessionHash: hashSession("sess-a"), file: transcript(env, "-repo", "sess-a") },
  ]);
  assert.deepEqual(runTranscripts({ sessionHashes: new Set([hashSession("sess-a")]), env }), [
    { sessionHash: hashSession("sess-a"), file: transcript(env, "-repo", "sess-a") },
  ]);
});

test("never lists a subagent transcript or a deeper file, and an unreadable projects dir lists nothing", () => {
  const env = config({ "-repo": ["sess-a"] });
  const sessionDir = join(env.CLAUDE_CONFIG_DIR, "projects", "-repo", "sess-a");
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  writeFileSync(join(sessionDir, "subagents", "agent-a1.jsonl"), "");
  writeFileSync(join(sessionDir, "subagents", "sess-sub.jsonl"), "");
  writeFileSync(join(sessionDir, "sess-deep.jsonl"), "");
  assert.deepEqual(runTranscripts({ sessionHashes: ["agent-a1", "sess-sub", "sess-deep"].map(hashSession), env }), []);
  assert.deepEqual(runTranscripts({ sessionHashes: [hashSession("sess-a")], env: { CLAUDE_CONFIG_DIR: makeTempDir("run-transcripts-empty-") } }), []);
  assert.deepEqual(runTranscripts({ sessionHashes: [], env }), []);
});

test("the last session is the latest session row that is not this session, with its transcript when one is found", () => {
  const env = config({ "-repo": ["sess-a", "sess-b"] });
  const rows = [{ kind: "run", startedAt: "2026-10-30T08:00:00Z" }, session("sess-a"), session("sess-b"), session("sess-me")];
  assert.deepEqual(lastSession({ rows, currentSessionId: "sess-me", env }), { sessionHash: hashSession("sess-b"), file: transcript(env, "-repo", "sess-b") });
  assert.deepEqual(lastSession({ rows: rows.slice(0, 3), currentSessionId: "sess-b", env }), { sessionHash: hashSession("sess-a"), file: transcript(env, "-repo", "sess-a") });
  assert.deepEqual(lastSession({ rows, currentSessionId: null, env }), { sessionHash: hashSession("sess-me"), file: null }, "no current session: the latest row, here with no transcript");
  assert.equal(lastSession({ rows: [session("sess-me")], currentSessionId: "sess-me", env }), null);
  assert.equal(lastSession({ rows: [], currentSessionId: "sess-me", env }), null);
});
