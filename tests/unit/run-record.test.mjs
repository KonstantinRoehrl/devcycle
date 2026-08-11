import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, realpathSync, mkdirSync } from "node:fs";
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

test("new rejects a required field that is present but explicitly undefined", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  // --plugin-sha is omitted entirely, so flags["plugin-sha"] is JS `undefined`, and the object
  // literal in main() still sets pluginSha: undefined — "pluginSha" in obj is true even though
  // no real value exists. The pattern check on pluginSha (a controlled regex) would still catch
  // this by accident; profile has no pattern, so route the assertion through the field with no
  // pattern/enum guard to isolate the definedness bug specifically.
  const r = run(
    ["new", "--repo", "/tmp/demo6", "--plugin-sha", "ded29c6", "--profile", "thorough"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /pluginVersion/);
});

test("a --knob or --json flag with no = does not crash the process", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const r = run(
    ["new", "--repo", "/tmp/demo7", "--plugin-version", "0.13.0", "--plugin-sha", "ded29c6",
     "--profile", "thorough", "--knob", "malformed-no-equals"],
    runs
  );
  // Today: value.indexOf("=") returns -1, so value.slice(0, -1) and value.slice(0) silently
  // produce a garbage key/value pair instead of failing loudly — the real bug is that this
  // exits 0 with corrupted data rather than exit 1 with a clear message.
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /--knob/);
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
     "--endedAt", "2026-08-07T10:01:00Z",
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
     "--sessionId", SESSION_ID],
    runs
  );
  assert.strictEqual(r.status, 0, r.stderr);
  const text = readFileSync(recordPath("/tmp/demo5", runId), "utf8");
  assert.doesNotMatch(text, SESSION_HEAD);
  assert.match(text, new RegExp(hashSession(SESSION_ID)));
});

test("append rejects a dispatch reviewRound below the schema's minimum", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo8", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo8", "--kind", "dispatch",
     "--taskId", "1", "--agentType", "devcycle:implementer", "--model", "claude-sonnet-5",
     "--modelSource", "explicit", "--startedAt", "2026-08-07T10:00:00Z",
     "--endedAt", "2026-08-07T10:01:00Z",
     "--outcome", "complete", "--reviewRound", "-1", "--retryIndex", "0"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /reviewRound/);
  const lines = readFileSync(recordPath("/tmp/demo8", runId), "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 1);
});

test("append rejects a dispatch retryIndex below the schema's minimum", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo9", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo9", "--kind", "dispatch",
     "--taskId", "1", "--agentType", "devcycle:implementer", "--model", "claude-sonnet-5",
     "--modelSource", "explicit", "--startedAt", "2026-08-07T10:00:00Z",
     "--endedAt", "2026-08-07T10:01:00Z",
     "--outcome", "complete", "--reviewRound", "0", "--retryIndex", "-1"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /retryIndex/);
});

test("append rejects a verdict round below the schema's minimum", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo10", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo10", "--kind", "verdict",
     "--taskId", "1", "--round", "0", "--blockingCount", "0",
     "--evidenceClass", "red-green", "--conformance", "pass"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /round/);
});

test("append rejects a verdict blockingCount below the schema's minimum", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  const runId = run(
    ["new", "--repo", "/tmp/demo11", "--plugin-version", "0.13.0",
     "--plugin-sha", "ded29c6", "--profile", "lean"],
    runs
  ).stdout.trim();
  const r = run(
    ["append", "--run", runId, "--repo", "/tmp/demo11", "--kind", "verdict",
     "--taskId", "1", "--round", "1", "--blockingCount", "-1",
     "--evidenceClass", "red-green", "--conformance", "pass"],
    runs
  );
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /blockingCount/);
});

test("repoSlug sanitizes a basename containing spaces and non-ASCII characters", () => {
  const weird = `${SLASH}Users${SLASH}someone${SLASH}My Projects${SLASH}dévcyclé ☂`;
  const slug = repoSlug(weird);
  const expectedHash = createHash("sha256").update(weird).digest("hex").slice(0, 8);
  assert.match(slug, /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
  assert.ok(slug.endsWith(`-${expectedHash}`));
});

test("repoSlug falls back to a fixed literal when sanitizing empties the basename", () => {
  const allSymbols = `${SLASH}Users${SLASH}someone${SLASH}☂☂☂`;
  const slug = repoSlug(allSymbols);
  const expectedHash = createHash("sha256").update(allSymbols).digest("hex").slice(0, 8);
  assert.strictEqual(slug, `repo-${expectedHash}`);
});

test("new derives repoSlug from the real git toplevel, not the invoking cwd", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  // Create a temporary git repo and spawn from a nested subdirectory inside it (not the root).
  // Without --repo, the script should derive repoSlug from the real git toplevel, not the
  // nested subdir's path.
  const tempRepo = realpathSync(mkdtempSync(join(tmpdir(), "temp-repo-")));
  // Initialize git repo in temp directory
  spawnSync("git", ["init", "-q"], { cwd: tempRepo });
  // Create nested subdirectory and spawn from there
  const nestedDir = join(tempRepo, "nested", "subdir");
  mkdirSync(nestedDir, { recursive: true });

  const r = spawnSync(process.execPath, [SCRIPT, "new", "--plugin-version", "0.13.0",
    "--plugin-sha", "ded29c6", "--profile", "thorough"], {
    encoding: "utf8", cwd: nestedDir,
    env: { ...process.env, DEVCYCLE_RUNS_DIR: runs },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const runId = r.stdout.trim();
  process.env.DEVCYCLE_RUNS_DIR = runs;
  // Script invoked from nestedDir, but gitToplevel should resolve to tempRepo (the real toplevel)
  const written = JSON.parse(
    readFileSync(recordPath(tempRepo, runId), "utf8").split("\n")[0]
  );
  // Verify the slug is derived from the real git toplevel (tempRepo), not the nested dir
  assert.notStrictEqual(written.repoSlug, repoSlug(nestedDir));
  assert.strictEqual(written.repoSlug, repoSlug(tempRepo));
});
