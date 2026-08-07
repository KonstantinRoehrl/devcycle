import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { repoSlug, hashSession, recordPath } from "../../scripts/run-record.mjs";

const SCRIPT = new URL("../../scripts/run-record.mjs", import.meta.url).pathname;

// Both fixtures below are assembled from fragments so this file — which is tracked and so
// scanned by scripts/redaction-check.mjs — carries no literal the check matches. Same idiom as
// tests/unit/redaction-check.test.mjs. The assembled values are unchanged, so the assertions
// still see a genuinely home-shaped path and a genuinely session-id-shaped id.
const SLASH = "/";
const HOME_REPO = `${SLASH}Users${SLASH}someone${SLASH}Programming${SLASH}devcycle`;
const SESSION_ID = ["d5a1382d", "b2d7", "487c", "a88b", "be6d0f794308"].join("-");
const SESSION_HEAD = new RegExp(SESSION_ID.slice(0, 8));

function run(args, runsDir) {
  // recordPath() reads DEVCYCLE_RUNS_DIR from whichever process calls it, so the assertions
  // below need it set here too, not just in the spawned child.
  process.env.DEVCYCLE_RUNS_DIR = runsDir;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir },
  });
}

test("repoSlug is the basename plus a short hash of the toplevel path", () => {
  const slug = repoSlug(HOME_REPO);
  const expected =
    "devcycle-" + createHash("sha256").update(HOME_REPO).digest("hex").slice(0, 8);
  assert.strictEqual(slug, expected);
});

test("repoSlug distinguishes two repos sharing a basename", () => {
  assert.notStrictEqual(repoSlug("/a/devcycle"), repoSlug("/b/devcycle"));
});

test("repoSlug leaks no path segment beyond the basename", () => {
  assert.doesNotMatch(repoSlug(HOME_REPO), /someone|Programming/);
});

test("hashSession returns 64 lowercase hex chars and never the raw id", () => {
  const h = hashSession(SESSION_ID);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(h, SESSION_HEAD);
});

test("new mints a run id and writes a schema-valid run line", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const r = run(
    ["new", "--repo", "/tmp/demo", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "thorough", "--knob", "gitPolicy=open-pr"],
    runs
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const runId = r.stdout.trim();
  assert.match(runId, /^[0-9a-f]{16}$/);
  const p = recordPath("/tmp/demo", runId);
  assert.ok(existsSync(p));
  const first = JSON.parse(readFileSync(p, "utf8").split("\n")[0]);
  assert.strictEqual(first.kind, "run");
  assert.strictEqual(first.schemaVersion, 1);
  assert.strictEqual(first.profile, "thorough");
  assert.deepStrictEqual(first.knobs, { gitPolicy: "open-pr" });
});

test("append adds one line per call and never rewrites earlier lines", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo2", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  for (const task of ["1", "2"]) {
    const r = run(
      ["append", "--run", runId, "--repo", "/tmp/demo2", "--kind", "commit",
       "--taskId", task, "--sha", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"],
      runs
    );
    assert.strictEqual(r.status, 0, r.stderr);
  }
  const lines = readFileSync(recordPath("/tmp/demo2", runId), "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(JSON.parse(lines[0]).kind, "run");
  assert.deepStrictEqual(lines.slice(1).map((l) => JSON.parse(l).taskId), ["1", "2"]);
});

test("append rejects a missing required field before writing anything", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo3", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo3", "--kind", "commit", "--taskId", "1"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /sha/);
  const lines = readFileSync(recordPath("/tmp/demo3", runId), "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 1);
});

test("append rejects an enum value the schema does not permit", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo4", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo4", "--kind", "dispatch",
     "--taskId", "1", "--agentType", "devcycle:implementer", "--model", "claude-sonnet-5",
     "--modelSource", "guessed", "--startedAt", "2026-08-07T10:00:00Z",
     "--endedAt", "2026-08-07T10:01:00Z", "--json", "toolCalls={}",
     "--outcome", "complete", "--reviewRound", "0", "--retryIndex", "0"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /modelSource/);
});

test("append writes a session line carrying only a hash, never a raw session id", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo5", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo5", "--kind", "session",
     "--sessionId", SESSION_ID, "--firstSeen", "2026-08-07T10:00:00Z",
     "--lastSeen", "2026-08-07T10:05:00Z"],
    runs
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const text = readFileSync(recordPath("/tmp/demo5", runId), "utf8");
  assert.doesNotMatch(text, SESSION_HEAD);
  assert.match(text, new RegExp(hashSession(SESSION_ID)));
});
