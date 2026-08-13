import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  readCheckpoint,
  writeCheckpoint,
  commitCheckpoint,
  planCorpus,
  artifactFresh,
  recordPromotion,
  readPromotions,
  checkRecurrence,
  runCheckRecurrence,
  observationsDir,
  hasObservations,
  listObservations,
  readObservations,
  suppressedByLandedSignature,
  extractSession,
  messageText,
} from "../../scripts/dream.mjs";

const SCRIPT = new URL("../../scripts/dream.mjs", import.meta.url).pathname;

const repo = () => mkdtempSync(join(tmpdir(), "dream-repo-"));

// Places session fixtures under repoRoot's own escaped-cwd project directory (the
// convention fix 1 scopes planCorpus to), not an arbitrary slug.
function projects(repoRoot, sessions) {
  const dir = mkdtempSync(join(tmpdir(), "dream-proj-"));
  const slug = join(dir, repoRoot.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  for (const [id, ts] of sessions) {
    const rec = { timestamp: ts, type: "assistant", message: { content: [] } };
    writeFileSync(join(slug, `${id}.jsonl`), JSON.stringify(rec) + "\n");
  }
  return dir;
}

// CLI-level tests always get their own empty CLAUDE_DREAM_PROJECTS so a run never scans
// this machine's real ~/.claude/projects.
const run = (args, cwd, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, CLAUDE_DREAM_PROJECTS: mkdtempSync(join(tmpdir(), "dream-cli-empty-")), ...env },
  });

// Claude Code's real project-directory convention (verified on this machine): every
// character that is not alphanumeric becomes its own "-", not merely "/". Mirrors the
// escaping rule fix 2 gives `planCorpus`; `plain `.replaceAll("/", "-")` above still
// matches it for the plain-name fixtures the pre-existing tests use.
const escapedSlug = (root) => root.replace(/[^A-Za-z0-9]/g, "-");

test("checkpoint initializes to never and round-trips", () => {
  const root = repo();
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
  writeCheckpoint(root, { lastDreamedThrough: "2026-08-01T00:00:00Z", lastArtifact: "a.md" });
  assert.deepEqual(readCheckpoint(root), {
    lastDreamedThrough: "2026-08-01T00:00:00Z",
    lastArtifact: "a.md",
  });
});

// Mutation coverage: dropping the never/none literal handling must fail this test, which
// requires actually reading a file containing those literals (the initialize test above
// only exercises the missing-file early return).
test("checkpoint treats literal never/none values as unset, not as those literal strings", () => {
  const root = repo();
  mkdirSync(join(root, ".devcycle", "dreaming"), { recursive: true });
  writeFileSync(
    join(root, ".devcycle", "dreaming", "state.md"),
    "# dreaming checkpoint\n- last-dreamed-through: never\n- last-artifact: none\n",
  );
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
});

test("an empty checkpoint field does not bleed into the next line on read-back", () => {
  const root = repo();
  writeCheckpoint(root, { lastDreamedThrough: "", lastArtifact: "none" });
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
});

test("the cap keeps the most recent sessions and flags that it bound the input", () => {
  const root = repo();
  const many = Array.from({ length: 7 }, (_, i) => [
    `sess-${String(i).padStart(2, "0")}`,
    `2026-08-0${i + 1}T00:00:00Z`,
  ]);
  const m = planCorpus({ repoRoot: root, projectsDir: projects(root, many), since: null, cap: 3 });
  assert.equal(m.capped, true);
  assert.equal(m.sessions.length, 3);
  assert.deepEqual(m.sessions.map((s) => s.id), ["sess-06", "sess-05", "sess-04"]);
});

test("an uncapped corpus reports capped false", () => {
  const root = repo();
  const m = planCorpus({
    repoRoot: root,
    projectsDir: projects(root, [["a", "2026-08-01T00:00:00Z"]]),
    since: null,
    cap: 100,
  });
  assert.equal(m.capped, false);
  assert.equal(m.sessions.length, 1);
});

test("since excludes sessions that ended before the checkpoint", () => {
  const root = repo();
  const m = planCorpus({
    repoRoot: root,
    projectsDir: projects(root, [["old", "2026-07-01T00:00:00Z"], ["new", "2026-08-02T00:00:00Z"]]),
    since: "2026-08-01T00:00:00Z",
    cap: 100,
  });
  assert.deepEqual(m.sessions.map((s) => s.id), ["new"]);
});

test("planCorpus reads only this repo's own transcripts, not every project under the projects root", () => {
  const root = repo();
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-multi-project-"));
  const otherSlug = join(projectsDir, "-some-other-repo");
  mkdirSync(otherSlug, { recursive: true });
  writeFileSync(
    join(otherSlug, "other.jsonl"),
    JSON.stringify({ timestamp: "2026-08-06T00:00:00Z", type: "assistant", message: { content: [] } }) + "\n",
  );
  const ownSlug = join(projectsDir, root.replaceAll("/", "-"));
  mkdirSync(ownSlug, { recursive: true });
  writeFileSync(
    join(ownSlug, "own.jsonl"),
    JSON.stringify({ timestamp: "2026-08-06T00:00:00Z", type: "assistant", message: { content: [] } }) + "\n",
  );
  const m = planCorpus({ repoRoot: root, projectsDir, since: null, cap: 100 });
  assert.deepEqual(m.sessions.map((s) => s.id), ["own"]);
});

// A repo with no project directory yet under an *existing* projects root is normal —
// "nothing mined here before" — and stays tolerant. (The projects root itself missing is
// the opposite case, covered separately below: that one now fails per §9.)
test("planCorpus tolerates a missing project directory under an existing projects root instead of crashing", () => {
  const root = repo();
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-parent-"));
  assert.doesNotThrow(() => planCorpus({ repoRoot: root, projectsDir, since: null, cap: 100 }));
  const m = planCorpus({ repoRoot: root, projectsDir, since: null, cap: 100 });
  assert.deepEqual(m.sessions, []);
});

// Round-2 finding F2: Claude Code escapes every non-alphanumeric character, not just
// "/" — a repo path containing "_" or "." previously mined zero sessions and reported
// success. Fixture directory name mirrors the real convention exactly.
test("planCorpus mines sessions for a repo whose path contains underscores and dots", () => {
  const repoRoot = "/srv/code/my_project.site";
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-underscore-"));
  const slug = join(projectsDir, escapedSlug(repoRoot));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess.jsonl"),
    JSON.stringify({ timestamp: "2026-08-06T00:00:00Z", type: "assistant", message: { content: [] } }) + "\n",
  );
  const m = planCorpus({ repoRoot, projectsDir, since: null, cap: 100 });
  assert.deepEqual(m.sessions.map((s) => s.id), ["sess"]);
});

// Same defect, the other reported case.
test("planCorpus mines sessions for a repo whose path is a bare dotted name like site.com", () => {
  const repoRoot = "/srv/code/site.com";
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-dotted-"));
  const slug = join(projectsDir, escapedSlug(repoRoot));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "sess.jsonl"),
    JSON.stringify({ timestamp: "2026-08-06T00:00:00Z", type: "assistant", message: { content: [] } }) + "\n",
  );
  const m = planCorpus({ repoRoot, projectsDir, since: null, cap: 100 });
  assert.deepEqual(m.sessions.map((s) => s.id), ["sess"]);
});

// Safety net doctor.mjs already has (resolveDepth's filename fallback) and dream lacked:
// when the expected slug directory does not exist at all, fall back to a repo-scoped
// search of the whole projects root instead of reporting an empty corpus. Kept
// repo-scoped by filtering on the session's own recorded `cwd`, so a sibling project's
// sessions still never leak in.
test("planCorpus falls back to a cwd-matched search when the expected slug directory is missing", () => {
  const repoRoot = "/srv/code/another-project";
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-fallback-"));
  const legacySlug = join(projectsDir, "some-unexpected-legacy-name");
  mkdirSync(legacySlug, { recursive: true });
  writeFileSync(
    join(legacySlug, "moved.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-06T00:00:00Z",
      type: "assistant",
      cwd: repoRoot,
      message: { content: [] },
    }) + "\n",
  );
  const otherSlug = join(projectsDir, escapedSlug("/srv/code/other-project"));
  mkdirSync(otherSlug, { recursive: true });
  writeFileSync(
    join(otherSlug, "other.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-06T00:00:00Z",
      type: "assistant",
      cwd: "/srv/code/other-project",
      message: { content: [] },
    }) + "\n",
  );

  const m = planCorpus({ repoRoot, projectsDir, since: null, cap: 100 });
  assert.deepEqual(m.sessions.map((s) => s.id), ["moved"]);
});

// The other half of the safety net: doctor.mjs:624 treats an unreadable directory as a
// hard failure, never as an empty success. A file sitting where the slug directory is
// expected reproduces "exists but can't be read" portably (readdirSync throws ENOTDIR
// on every platform, unlike a chmod trick that root or some CI runners ignore).
test("planCorpus throws instead of silently returning an empty corpus when the project directory is unreadable", () => {
  const root = repo();
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-unreadable-"));
  const slug = join(projectsDir, root.replaceAll("/", "-"));
  writeFileSync(slug, "not a directory\n");
  assert.throws(() => planCorpus({ repoRoot: root, projectsDir, since: null, cap: 100 }));
});

test("cli: --plan fails loudly instead of printing an empty manifest when the project directory is unreadable", () => {
  const root = repo();
  // A spawned process reports its cwd through macOS's realpath (/private/var/... for a
  // path handed in as /var/...), not the string this test built `root` from — resolve it
  // the same way before deriving the slug, or the fixture and the CLI process disagree on
  // which directory the escaped-cwd rule even points at.
  const realRoot = realpathSync(root);
  const projectsDir = mkdtempSync(join(tmpdir(), "dream-cli-unreadable-"));
  const slug = join(projectsDir, realRoot.replaceAll("/", "-"));
  writeFileSync(slug, "not a directory\n");
  const res = run(["--plan"], root, { CLAUDE_DREAM_PROJECTS: projectsDir });
  assert.notEqual(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("archives are enumerated by their dated directory prefix", () => {
  const root = repo();
  const arch = join(root, ".devcycle", "archive-2026-08-02-fix-thing");
  mkdirSync(join(arch, "evidence"), { recursive: true });
  writeFileSync(join(arch, "ledger.md"), "# ledger\n");
  writeFileSync(join(arch, "evidence", "1-before.txt"), "x\n");
  const m = planCorpus({ repoRoot: root, projectsDir: projects(root, []), since: null, cap: 100 });
  assert.equal(m.archives.length, 1);
  assert.equal(m.archives[0].date, "2026-08-02");
  assert.equal(m.archives[0].evidenceCount, 1);
});

// F5: two archives finishing on the same day previously produced byte-identical entries
// (same date, same count, same glob) that a shell expansion could not tell apart. Each
// archive now gets its own id/index, and evidence files are listed by name (never the
// branch-slugged directory) so a reader can actually distinguish and read them.
test("two archives sharing a date get distinct, resolvable handles instead of colliding", () => {
  const root = repo();
  mkdirSync(join(root, ".devcycle", "archive-2026-08-02-feat-alpha", "evidence"), { recursive: true });
  writeFileSync(join(root, ".devcycle", "archive-2026-08-02-feat-alpha", "ledger.md"), "# ledger\n");
  writeFileSync(join(root, ".devcycle", "archive-2026-08-02-feat-alpha", "evidence", "1-before.txt"), "a\n");

  mkdirSync(join(root, ".devcycle", "archive-2026-08-02-fix-beta", "evidence"), { recursive: true });
  writeFileSync(join(root, ".devcycle", "archive-2026-08-02-fix-beta", "ledger.md"), "# ledger\n");
  writeFileSync(join(root, ".devcycle", "archive-2026-08-02-fix-beta", "evidence", "2-before.txt"), "b\n");
  writeFileSync(join(root, ".devcycle", "archive-2026-08-02-fix-beta", "evidence", "2-after.txt"), "b2\n");

  const m = planCorpus({ repoRoot: root, projectsDir: projects(root, []), since: null, cap: 100 });
  assert.equal(m.archives.length, 2);
  const ids = m.archives.map((a) => a.id);
  assert.equal(new Set(ids).size, 2);
  const counts = m.archives.map((a) => a.evidenceFiles.length).sort();
  assert.deepEqual(counts, [1, 2]);

  const json = JSON.stringify(m);
  assert.equal(json.includes("feat-alpha"), false);
  assert.equal(json.includes("fix-beta"), false);
});

// The old check compared only the artifact filename's calendar date, which is true forever
// once the checkpoint and the artifact land the same day. Freshness must instead expire the
// moment a session newer than the covered range shows up — the "real path" fix 2 requires,
// exercised here through the actual writeCheckpoint + planCorpus flow.
test("artifact freshness expires once a session lands after the checkpoint, not just after the day", () => {
  const root = repo();
  writeCheckpoint(root, { lastDreamedThrough: "2026-08-01T00:00:00Z", lastArtifact: null });
  mkdirSync(join(root, ".devcycle", "dreaming"), { recursive: true });
  writeFileSync(join(root, ".devcycle", "dreaming", "2026-08-01-dream.md"), "# dream\n");

  const since = readCheckpoint(root).lastDreamedThrough;
  const noNewSessions = planCorpus({
    repoRoot: root,
    projectsDir: projects(root, [["a", "2026-08-01T00:00:00Z"]]),
    since,
  });
  assert.equal(noNewSessions.artifactFresh, true);

  const withNewSession = planCorpus({
    repoRoot: root,
    projectsDir: projects(root, [["a", "2026-08-01T00:00:00Z"], ["b", "2026-08-01T05:00:00Z"]]),
    since,
  });
  assert.equal(withNewSession.artifactFresh, false);
});

test("artifactFresh compares full timestamps, not just calendar dates", () => {
  const root = repo();
  mkdirSync(join(root, ".devcycle", "dreaming"), { recursive: true });
  writeFileSync(join(root, ".devcycle", "dreaming", "2026-08-03-dream.md"), "# dream\n");
  const since = "2026-08-01T00:00:00Z";
  assert.equal(artifactFresh(root, since, []).fresh, true);
  assert.equal(artifactFresh(root, since, [{ id: "a", lastTimestamp: "2026-08-01T00:00:00Z" }]).fresh, true);
  assert.equal(artifactFresh(root, since, [{ id: "b", lastTimestamp: "2026-08-01T05:00:00Z" }]).fresh, false);
});

// F3: `since = null` must mean "nothing has been mined yet", not "everything is fresh" —
// otherwise an artifact present with the checkpoint still `never` makes every later dream
// a permanent no-op even though un-mined sessions exist.
test("artifactFresh treats since=null as nothing-mined-yet, never as unconditionally fresh", () => {
  const root = repo();
  mkdirSync(join(root, ".devcycle", "dreaming"), { recursive: true });
  writeFileSync(join(root, ".devcycle", "dreaming", "2026-08-01-dream.md"), "# dream\n");
  assert.equal(artifactFresh(root, null, []).fresh, false);
  assert.equal(
    artifactFresh(root, null, [{ id: "a", lastTimestamp: "2026-08-05T00:00:00Z" }]).fresh,
    false,
  );
});

// A record isSelfRecord() matches: a Skill tool_use naming the dreaming skill.
const selfRecord = (ts) => ({
  timestamp: ts,
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", name: "Skill", input: { skill: "devcycle:dreaming-across-sessions" } },
    ],
  },
});
const plainRecord = (ts) => ({ timestamp: ts, type: "assistant", message: { content: [] } });

function projectsWith(repoRoot, entries) {
  const dir = mkdtempSync(join(tmpdir(), "dream-proj-"));
  // Same escaping rule the engine uses: every non-alphanumeric character becomes "-".
  const slug = join(dir, repoRoot.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(slug, { recursive: true });
  for (const [id, records] of entries) {
    writeFileSync(
      join(slug, `${id}.jsonl`),
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }
  return dir;
}

function withArtifact(repoRoot, name = "2026-08-05-dream.md") {
  mkdirSync(join(repoRoot, ".devcycle", "dreaming"), { recursive: true });
  writeFileSync(join(repoRoot, ".devcycle", "dreaming", name), "# dream\n");
}

test("planCorpus: the dream's own session does not make its own artifact stale", () => {
  const root = realpathSync(repo());
  withArtifact(root);
  const proj = projectsWith(root, [["selfsess", [selfRecord("2026-08-05T12:00:00Z")]]]);
  const m = planCorpus({
    repoRoot: root,
    projectsDir: proj,
    since: "2026-08-05T11:00:00Z",
  });
  assert.equal(m.artifactFresh, true, "a self session newer than the checkpoint must not go stale");
  assert.equal(m.sessions.length, 1, "the self session stays mineable in the returned list");
  assert.equal(m.sessions[0].self, true);
});

test("planCorpus: a non-self session newer than the checkpoint does make the artifact stale", () => {
  const root = realpathSync(repo());
  withArtifact(root);
  const proj = projectsWith(root, [["othersess", [plainRecord("2026-08-05T12:00:00Z")]]]);
  const m = planCorpus({
    repoRoot: root,
    projectsDir: proj,
    since: "2026-08-05T11:00:00Z",
  });
  assert.equal(m.artifactFresh, false, "a real new session must make the artifact stale");
  assert.equal(m.sessions[0].self, false);
});

test("artifactFresh: compares instants, not strings, across accepted ISO forms", () => {
  const root = realpathSync(repo());
  withArtifact(root);
  // "+02:00" is 10:00Z — earlier than the 11:00Z session, so the artifact is stale.
  // Lexicographically "2026-08-05T12:00:00+02:00" > "2026-08-05T11:00:00Z", which is the bug.
  assert.equal(
    artifactFresh(root, "2026-08-05T12:00:00+02:00", [{ lastTimestamp: "2026-08-05T11:00:00Z" }])
      .fresh,
    false,
  );
  // Minute precision: 12:00Z is earlier than 12:00:30Z, so the artifact is stale.
  assert.equal(
    artifactFresh(root, "2026-08-05T12:00Z", [{ lastTimestamp: "2026-08-05T12:00:30Z" }]).fresh,
    false,
  );
  // Genuinely covered: the session predates the checkpoint.
  assert.equal(
    artifactFresh(root, "2026-08-05T12:00:00Z", [{ lastTimestamp: "2026-08-05T11:00:00Z" }]).fresh,
    true,
  );
});

test("artifactFresh: ignores self sessions when computing the newest instant", () => {
  const root = realpathSync(repo());
  withArtifact(root);
  assert.equal(
    artifactFresh(root, "2026-08-05T11:00:00Z", [
      { lastTimestamp: "2026-08-05T12:00:00Z", self: true },
    ]).fresh,
    true,
  );
  assert.equal(
    artifactFresh(root, "2026-08-05T11:00:00Z", [
      { lastTimestamp: "2026-08-05T12:00:00Z", self: false },
    ]).fresh,
    false,
  );
});

test("commitCheckpoint rejects a non-ISO value and writes nothing", () => {
  const root = repo();
  assert.throws(() => commitCheckpoint(root, "banana"));
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
});

// F3 (related): the strict ISO check must accept the forms a caller would reasonably
// emit, not just the one exact shape the previous regex hard-coded.
test("commitCheckpoint accepts a numeric UTC offset and a minute-precision instant", () => {
  const root = repo();
  assert.doesNotThrow(() => commitCheckpoint(root, "2026-08-05T12:00:00+00:00"));
  assert.equal(readCheckpoint(root).lastDreamedThrough, "2026-08-05T12:00:00+00:00");

  const root2 = repo();
  assert.doesNotThrow(() => commitCheckpoint(root2, "2026-08-05T12:00Z"));
  assert.equal(readCheckpoint(root2).lastDreamedThrough, "2026-08-05T12:00Z");
});

test("commitCheckpoint records which artifact the new checkpoint covers", () => {
  const root = repo();
  mkdirSync(join(root, ".devcycle", "dreaming"), { recursive: true });
  writeFileSync(join(root, ".devcycle", "dreaming", "2026-08-04-dream.md"), "# dream\n");
  commitCheckpoint(root, "2026-08-04T12:00:00Z");
  const back = readCheckpoint(root);
  assert.equal(back.lastDreamedThrough, "2026-08-04T12:00:00Z");
  assert.match(back.lastArtifact, /2026-08-04-dream\.md$/);
});

test("cli: --commit-checkpoint rejects a non-ISO value and exits non-zero", () => {
  const root = repo();
  const res = run(["--commit-checkpoint", "banana"], root);
  assert.notEqual(res.status, 0);
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
});

test("cli: --commit-checkpoint combined with --plan fails instead of silently planning", () => {
  const root = repo();
  const res = run(["--commit-checkpoint", "2026-08-01T00:00:00Z", "--plan"], root);
  assert.notEqual(res.status, 0);
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
});

// The literal root below must not look like an absolute home directory:
// scripts/redaction-check.mjs fails any tracked file containing one, and this test file
// is tracked.
test("memoryDir follows the escaped-cwd rule, not basename", () => {
  const repoRoot = "/srv/code/Programming/thing";
  const m = planCorpus({
    repoRoot,
    projectsDir: projects(repoRoot, []),
    since: null,
    cap: 100,
  });
  assert.match(m.memoryDir, /-srv-code-Programming-thing\/memory$/);
});

test("the manifest leaks no message text and no branch name", () => {
  const root = repo();
  const dir = mkdtempSync(join(tmpdir(), "dream-secret-"));
  const slug = join(dir, root.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "s1.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-02T00:00:00Z",
      type: "assistant",
      message: { content: [{ type: "text", text: "SUPERSECRETPAYLOAD" }] },
    }) + "\n",
  );
  mkdirSync(join(root, ".devcycle", "archive-2026-08-02-some-secret-branch-slug", "evidence"), {
    recursive: true,
  });
  writeFileSync(join(root, ".devcycle", "archive-2026-08-02-some-secret-branch-slug", "ledger.md"), "# ledger\n");

  const m = planCorpus({ repoRoot: root, projectsDir: dir, since: null, cap: 100 });
  const json = JSON.stringify(m);
  assert.equal(json.includes("SUPERSECRETPAYLOAD"), false);
  assert.equal(json.includes("some-secret-branch-slug"), false);
});

test("planCorpus excludes devcycle's own dreaming/doctor sessions only when asked", () => {
  const root = repo();
  const dir = mkdtempSync(join(tmpdir(), "dream-self-"));
  const slug = join(dir, root.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "self-session.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-05T00:00:00Z",
      type: "assistant",
      attributionSkill: "devcycle:dreaming-across-sessions",
      message: { content: [] },
    }) + "\n",
  );

  const included = planCorpus({ repoRoot: root, projectsDir: dir, since: null, cap: 100 });
  assert.deepEqual(included.sessions.map((s) => s.id), ["self-session"]);

  const excluded = planCorpus({ repoRoot: root, projectsDir: dir, since: null, cap: 100, excludeSelf: true });
  assert.deepEqual(excluded.sessions, []);
});

// A dreaming session records `devcycle:learn` — the command that runs this script — now that
// `devcycle:dreaming-across-sessions` names nothing. Missing it puts the run's own echoed
// cluster signatures back in the recurrence corpus, where they self-seed a permanent hit.
test("planCorpus excludes a session attributed to the learn command as one of devcycle's own", () => {
  const root = repo();
  const dir = mkdtempSync(join(tmpdir(), "dream-self-learn-"));
  const slug = join(dir, root.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "learn-session.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-05T00:00:00Z",
      type: "assistant",
      attributionSkill: "devcycle:learn",
      message: { content: [] },
    }) + "\n",
  );

  const included = planCorpus({ repoRoot: root, projectsDir: dir, since: null, cap: 100 });
  assert.deepEqual(included.sessions.map((s) => s.id), ["learn-session"]);

  const excluded = planCorpus({ repoRoot: root, projectsDir: dir, since: null, cap: 100, excludeSelf: true });
  assert.deepEqual(excluded.sessions, [], "a learn session must not reach the recurrence corpus");
});

const REC = {
  title: "Reviewer rejects unauthorized-file claims",
  promotionType: "skill-edit",
  clusterSignature: "task-reviewer flags files from a concurrent task",
  filesTouched: ["agents/task-reviewer.md"],
  landed: "2026-08-04",
  commit: "abc1234",
};

test("a promotion record round-trips through the committed directory", () => {
  const root = repo();
  const p = recordPromotion(root, REC);
  assert.match(p, /docs\/devcycle\/promotions\/2026-08-04-reviewer-rejects-unauthorized-file-claims\.md$/);
  const [back] = readPromotions(root);
  assert.equal(back.promotionType, "skill-edit");
  assert.equal(back.clusterSignature, REC.clusterSignature);
  assert.deepEqual(back.filesTouched, ["agents/task-reviewer.md"]);
  assert.equal(back.commit, "abc1234");
  assert.match(back.path, /docs\/devcycle\/promotions\/2026-08-04-reviewer-rejects-unauthorized-file-claims\.md$/);
});

// Mutation coverage: the previous version of this test used two different titles, so it
// stayed green even with the collision-suffix loop deleted outright. Recording the same
// title twice actually forces the collision.
test("two promotions with the same title on one day get distinct filenames", () => {
  const root = repo();
  const first = recordPromotion(root, REC);
  const second = recordPromotion(root, { ...REC });
  assert.notEqual(first, second);
  assert.match(second, /-2\.md$/);
  assert.equal(readPromotions(root).length, 2);
});

test("an empty files-touched value does not bleed into the next line on read-back", () => {
  const root = repo();
  recordPromotion(root, { ...REC, filesTouched: [], landed: "2026-08-05" });
  const [back] = readPromotions(root);
  assert.deepEqual(back.filesTouched, []);
  assert.equal(back.landed, "2026-08-05");
});

test("a newline embedded in cluster-signature does not create a phantom landed line", () => {
  const root = repo();
  recordPromotion(root, {
    ...REC,
    clusterSignature: "first part\n- landed: 1999-01-01",
    landed: "2026-08-06",
  });
  const [back] = readPromotions(root);
  assert.equal(back.landed, "2026-08-06");
});

// F6: `oneLine` only sanitized the *joined* filesTouched string; the array branch joined
// its elements raw, so a newline inside one element still forged a phantom `landed` line.
test("a newline inside a filesTouched array element does not forge a phantom landed line", () => {
  const root = repo();
  recordPromotion(root, {
    ...REC,
    filesTouched: ["a.md\n- landed: 1999-01-01"],
    landed: "2026-08-06",
  });
  const [back] = readPromotions(root);
  assert.equal(back.landed, "2026-08-06");
});

// F6 (related): `\r` alone and U+2028 are line terminators for `^`/`$`/`.` in JavaScript
// regexes too, so both open the same phantom-line hole `oneLine`'s `\r?\n`-only pattern
// missed.
test("a lone carriage return does not forge a phantom landed line", () => {
  const root = repo();
  recordPromotion(root, {
    ...REC,
    clusterSignature: "first part\r- landed: 1999-01-01",
    landed: "2026-08-07",
  });
  const [back] = readPromotions(root);
  assert.equal(back.landed, "2026-08-07");
});

test("a U+2028 line separator inside a filesTouched array element does not forge a phantom landed line", () => {
  const root = repo();
  recordPromotion(root, {
    ...REC,
    filesTouched: ["a.md\u2028- landed: 1999-02-02"],
    landed: "2026-08-08",
  });
  const [back] = readPromotions(root);
  assert.equal(back.landed, "2026-08-08");
});

test("filesTouched accepts the documented comma-separated-string form, not just an array", () => {
  const root = repo();
  recordPromotion(root, { ...REC, filesTouched: "a.md, b.md", landed: "2026-08-07" });
  const [back] = readPromotions(root);
  assert.deepEqual(back.filesTouched, ["a.md", "b.md"]);
});

test("recordPromotion does not throw when filesTouched is absent", () => {
  const root = repo();
  const { filesTouched, ...rec } = REC;
  assert.doesNotThrow(() => recordPromotion(root, { ...rec, landed: "2026-08-08" }));
});

test("recordPromotion rejects an invalid promotion-type instead of writing", () => {
  const root = repo();
  assert.throws(() => recordPromotion(root, { ...REC, promotionType: "not-a-real-type" }));
  assert.equal(readPromotions(root).length, 0);
});

test("recordPromotion rejects scratch-code-recurrence — no code path may promote it", () => {
  const root = repo();
  assert.throws(() => recordPromotion(root, { ...REC, promotionType: "scratch-code-recurrence" }));
  assert.equal(readPromotions(root).length, 0);
});

test("recordPromotion rejects a non-ISO landed value instead of writing a bad filename", () => {
  const root = repo();
  assert.throws(() => recordPromotion(root, { ...REC, landed: "whenever" }));
  assert.throws(() => recordPromotion(root, { ...REC, landed: "Aug 4, 2026" }));
  assert.equal(readPromotions(root).length, 0);
});

// F7: `Date.parse("2026-02-30")` rolls over to March 2 in V8 instead of returning NaN, so
// the old `Number.isNaN(Date.parse(...))` half of the check let impossible calendar dates
// through the YYYY-MM-DD shape regex.
test("recordPromotion rejects impossible calendar dates like Feb 30 and Nov 31", () => {
  const root = repo();
  assert.throws(() => recordPromotion(root, { ...REC, landed: "2026-02-30" }));
  assert.throws(() => recordPromotion(root, { ...REC, landed: "2026-11-31" }));
  assert.equal(readPromotions(root).length, 0);
});

// F8: a promotion recorded without a cluster signature is permanently invisible to the
// recurrence check (checkRecurrence skips empty signatures), so it must be rejected at
// write time like the other required fields, not written silently.
test("recordPromotion rejects an empty or missing cluster-signature instead of writing it silently", () => {
  const root = repo();
  assert.throws(() => recordPromotion(root, { ...REC, clusterSignature: "" }));
  assert.throws(() => recordPromotion(root, { ...REC, clusterSignature: undefined }));
  assert.equal(readPromotions(root).length, 0);
});

test("recurrence reports a signature that reappears after it landed", () => {
  const manifest = {
    sessions: [{ id: "s1", files: [], lastTimestamp: "2026-08-06T00:00:00Z", records: 1 }],
  };
  const hits = checkRecurrence(
    [{ ...REC, promotionType: "skill-edit", filesTouched: [] }],
    manifest,
    () => "the task-reviewer flags files from a concurrent task again",
  );
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].hits, ["s1"]);
});

test("recurrence ignores sessions that predate the promotion", () => {
  const manifest = {
    sessions: [{ id: "old", files: [], lastTimestamp: "2026-08-01T00:00:00Z", records: 1 }],
  };
  const hits = checkRecurrence([REC], manifest, () => REC.clusterSignature);
  assert.equal(hits.length, 0);
});

// Old matcher: shared-word Jaccard over a 0.6 threshold, tokenized from raw JSONL. Measured
// against the real corpus: the repo's own unit-test signature matched 95/100 sessions.
// Replacement: exact normalized-phrase substring containment, deterministic, no threshold.
test("recurrence requires an exact normalized-phrase match, not a fuzzy word-overlap score", () => {
  const manifest = {
    sessions: [{ id: "s1", files: [], lastTimestamp: "2026-08-06T00:00:00Z", records: 1 }],
  };
  const rec = { ...REC, clusterSignature: "task-reviewer flags files from a concurrent task" };
  // Shares every word with the signature, scattered rather than contiguous — scores 1.0
  // under a word-overlap threshold but is not the same recurring phrase.
  const scatteredText =
    "files from a concurrent task were reviewed; the task-reviewer flags them separately";
  const hits = checkRecurrence([rec], manifest, () => scatteredText);
  assert.equal(hits.length, 0);
});

// F1: normalizing raw JSONL treated a message newline (the two characters "\" and "n")
// asymmetrically — the backslash vanished but the "n" survived as a stray word, so a
// phrase that happened to wrap in the transcript silently missed. Each whitespace form a
// real transcript can contain must normalize the same way on both sides of the match.
const WRAP_MANIFEST = () => ({
  sessions: [{ id: "s1", files: [], lastTimestamp: "2026-08-06T00:00:00Z", records: 1 }],
});
const WRAP_SIGNATURE = "task-reviewer flags files from a concurrent task";
const WRAP_REC = { ...REC, clusterSignature: WRAP_SIGNATURE };

for (const [label, wrapped] of [
  ["a JSON-escaped \\n", "task-reviewer flags files\\nfrom a concurrent task"],
  ["a JSON-escaped \\r", "task-reviewer flags files\\rfrom a concurrent task"],
  ["a JSON-escaped \\t", "task-reviewer flags files\\tfrom a concurrent task"],
  ["a literal newline", "task-reviewer flags files\nfrom a concurrent task"],
  ["a literal tab", "task-reviewer flags files\tfrom a concurrent task"],
  ["a literal \\r\\n", "task-reviewer flags files\r\nfrom a concurrent task"],
  ["a U+2028 line separator", "task-reviewer flags files from a concurrent task"],
  ["a U+2029 paragraph separator", "task-reviewer flags files from a concurrent task"],
]) {
  test(`recurrence matches a signature that wraps across ${label} in the transcript`, () => {
    const hits = checkRecurrence([WRAP_REC], WRAP_MANIFEST(), () => wrapped);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].hits, ["s1"]);
  });
}

// The one wrap form that must NOT match: a break inside a word is not the same word
// reassembled, and treating whitespace as a separator (never deleting it) is what keeps
// that true instead of accidentally re-gluing split words into a spurious hit.
test("a wrap inside a word does not create a spurious phrase match", () => {
  const rec = { ...REC, clusterSignature: "a concurrent task review" };
  const hits = checkRecurrence(
    [rec],
    WRAP_MANIFEST(),
    () => "flags a conc\nurrent task review here",
  );
  assert.equal(hits.length, 0);
});

// End to end: the fix must match against the *extracted message text*, not the raw
// transcript bytes — a JSONL fixture whose real message text contains a newline (so the
// file on disk contains the two-character "\n" escape, reproducing the reported bug)
// must still be found by the full plan → recurrence pipeline.
test("recurrence matches a line-wrapped signature through the full plan pipeline, not just a mocked readText", () => {
  const root = repo();
  recordPromotion(root, { ...REC, landed: "2026-08-01", clusterSignature: WRAP_SIGNATURE, title: "Wrapped recurrence" });

  const projectsDir = mkdtempSync(join(tmpdir(), "dream-wrap-"));
  const slug = join(projectsDir, root.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "wrapped.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-03T00:00:00Z",
      type: "assistant",
      message: { content: [{ type: "text", text: "task-reviewer flags files\nfrom a concurrent task" }] },
    }) + "\n",
  );

  const result = runCheckRecurrence({ repoRoot: root, projectsDir });
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0].hits, ["wrapped"]);
});

test("check-recurrence output matches the pinned shape and carries no cluster-signature text", () => {
  const manifest = {
    sessions: [{ id: "s1", files: [], lastTimestamp: "2026-08-06T00:00:00Z", records: 1 }],
  };
  const promo = {
    path: "docs/devcycle/promotions/2026-08-04-x.md",
    title: REC.title,
    promotionType: REC.promotionType,
    clusterSignature: REC.clusterSignature,
    filesTouched: [],
    landed: REC.landed,
    commit: REC.commit,
  };
  const hits = checkRecurrence([promo], manifest, () => `${REC.clusterSignature} again`);
  assert.deepEqual(hits, [
    { recordPath: promo.path, title: promo.title, commit: promo.commit, landed: promo.landed, hits: ["s1"] },
  ]);
  assert.equal(JSON.stringify(hits).includes(REC.clusterSignature), false);
});

// The manifest handed to checkRecurrence must not itself be bounded by the checkpoint: a
// promotion landed well before the checkpoint would otherwise have the sessions between
// its own landed date and the checkpoint silently excluded from its own recurrence check.
test("check-recurrence windows the corpus by each promotion's own landed date, decoupled from the checkpoint", () => {
  const root = repo();
  writeCheckpoint(root, { lastDreamedThrough: "2026-08-05T00:00:00Z", lastArtifact: null });
  const signature = "a recurring workaround for the flaky import step";
  recordPromotion(root, {
    ...REC,
    landed: "2026-08-01",
    clusterSignature: signature,
    title: "Flaky import workaround",
  });

  const projectsDir = mkdtempSync(join(tmpdir(), "dream-recur-"));
  const slug = join(projectsDir, root.replaceAll("/", "-"));
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "mid.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-03T00:00:00Z", // after landed, but before the checkpoint above
      type: "assistant",
      message: { content: [{ type: "text", text: `hit ${signature} again` }] },
    }) + "\n",
  );

  const result = runCheckRecurrence({ repoRoot: root, projectsDir });
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0].hits, ["mid"]);
});

// F4: `checkRecurrence` normalized the whole corpus before it ever looked at
// `promotions`, paying the full-corpus read even with zero (or all-empty-signature)
// records — the same cost complaint spec §10's amendment already made once.
test("checkRecurrence returns immediately without reading the corpus when no promotion carries a signature", () => {
  const manifest = { sessions: [{ id: "s1", files: [], lastTimestamp: "2026-08-06T00:00:00Z", records: 1 }] };
  let called = false;
  const readText = () => {
    called = true;
    return "anything";
  };

  assert.deepEqual(checkRecurrence([], manifest, readText), []);
  assert.equal(called, false);

  assert.deepEqual(checkRecurrence([{ ...REC, clusterSignature: "" }], manifest, readText), []);
  assert.equal(called, false);
});

// F9: an empty recurrence result and a cap-truncated corpus both used to render the same
// way (an empty array); truncation must be visible.
test("runCheckRecurrence reports when the 100-session cap truncated its corpus", () => {
  const root = repo();
  const many = Array.from({ length: 105 }, (_, i) => [
    `sess-${String(i).padStart(3, "0")}`,
    `2026-01-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
  ]);
  const result = runCheckRecurrence({ repoRoot: root, projectsDir: projects(root, many) });
  assert.equal(result.capped, true);
});

test("runCheckRecurrence reports capped false when the corpus fits under the cap", () => {
  const root = repo();
  const result = runCheckRecurrence({
    repoRoot: root,
    projectsDir: projects(root, [["a", "2026-08-01T00:00:00Z"]]),
  });
  assert.equal(result.capped, false);
});

// F10: `--commit-checkpoint` must not silently swallow `--check-recurrence`, the same way
// it already refuses to silently swallow `--plan`.
test("cli: --commit-checkpoint combined with --check-recurrence fails instead of silently swallowing the check", () => {
  const root = repo();
  const res = run(["--commit-checkpoint", "2026-08-01T00:00:00Z", "--check-recurrence"], root);
  assert.notEqual(res.status, 0);
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
});

test("planCorpus: reports per-session and total byte sizes", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [["s1", [plainRecord("2026-08-05T12:00:00Z")]]]);
  const m = planCorpus({ repoRoot: root, projectsDir: proj, since: null });
  assert.ok(m.sessions[0].bytes > 0, "each session carries its byte size");
  assert.equal(m.totalBytes, m.sessions.reduce((n, s) => n + s.bytes, 0));
});

test("planCorpus: unmined lists exactly the sessions with no observation file", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [
    ["mined", [plainRecord("2026-08-05T12:00:00Z")]],
    ["fresh", [plainRecord("2026-08-05T12:30:00Z")]],
  ]);
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), "mined.json"), "[]\n");
  // A non-session slice: the memory store is mined at every profile and has no session id.
  writeFileSync(join(observationsDir(root), "memory.json"), "[]\n");
  const m = planCorpus({ repoRoot: root, projectsDir: proj, since: null });
  assert.deepEqual(m.unmined, ["fresh"], "unmined is the session-shaped work list");
  assert.deepEqual(m.observations, ["memory", "mined"], "observations lists every slice id");
  assert.equal(hasObservations(root, "mined"), true);
  assert.equal(hasObservations(root, "fresh"), false);
  assert.deepEqual(listObservations(root), ["memory", "mined"]);
});

// spec §5.4's observation-record schema. quote is verbatim in this fixture; readObservations
// must hand it back unchanged for the round-trip to mean anything.
const OBSERVATION = {
  session: "f2a2877b",
  ts: "2026-08-03T14:22:10Z",
  kind: "correction",
  subject: "scenario evidence sections omitted",
  target: "CONTRIBUTING.md",
  quote: "a reasonable, disclosed judgment call rather than a spec violation",
  confidence: "high",
};

test("readObservations round-trips a valid record written to the store", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), "f2a2877b.json"), JSON.stringify([OBSERVATION]));
  const [back] = readObservations(root, "f2a2877b");
  assert.deepEqual(back, OBSERVATION);
});

test("readObservations rejects a record whose kind is outside the five-value enum", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(
    join(observationsDir(root), "bad.json"),
    JSON.stringify([{ ...OBSERVATION, kind: "opinion" }]),
  );
  assert.throws(() => readObservations(root, "bad"), /invalid kind/);
});

test("readObservations rejects a record missing subject", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  const { subject, ...rest } = OBSERVATION;
  writeFileSync(join(observationsDir(root), "bad.json"), JSON.stringify([rest]));
  assert.throws(() => readObservations(root, "bad"), /subject is required/);
});

test("readObservations rejects a record missing quote — the grounding anchor is not optional", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  const { quote, ...rest } = OBSERVATION;
  writeFileSync(join(observationsDir(root), "bad.json"), JSON.stringify([rest]));
  assert.throws(() => readObservations(root, "bad"), /quote is required/);
});

test("readObservations fails loudly on a truncated file left by an interrupted map dispatch", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), "cut.json"), '[{"session":"s1","kind":"friction"');
  assert.throws(() => readObservations(root, "cut"), /malformed observation file/);
});

test("readObservations fails for a session with no observation file", () => {
  const root = realpathSync(repo());
  assert.throws(() => readObservations(root, "nope"), /no observation file/);
});

// G1-c: readObservations had no caller anywhere in the shipped flow. This is its consumer —
// a CLI subcommand the Map dispatch calls to verify the slice it just wrote, without the
// skill re-reading the file itself ("the skill invokes the CLI, not the module").
test("cli: --check-observations reports ok for a valid observation file", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), "f2a2877b.json"), JSON.stringify([OBSERVATION]));
  const r = run(["--check-observations", "f2a2877b"], root);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "observations: ok");
});

test("cli: --check-observations fails loudly, as dream: <message>, for a missing or malformed file", () => {
  const root = realpathSync(repo());
  const missing = run(["--check-observations", "nope"], root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^dream: no observation file/m);

  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), "cut.json"), '[{"session":"s1","kind":"friction"');
  const malformed = run(["--check-observations", "cut"], root);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /^dream: malformed observation file/m);
});

// Verifying a slice must not print the slice's own content — a subject or a quote in stdout
// would land in this session's own transcript, corpus for a later run, the same reasoning
// that already keeps --check-suppressed and --check-recurrence silent about their subjects.
test("cli: --check-observations never prints the observation's subject or quote", () => {
  const root = realpathSync(repo());
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), "f2a2877b.json"), JSON.stringify([OBSERVATION]));
  const r = run(["--check-observations", "f2a2877b"], root);
  assert.equal(r.stdout.includes(OBSERVATION.subject), false);
  assert.equal(r.stdout.includes(OBSERVATION.quote), false);
});

test("cli: --check-observations cannot be combined with another subcommand", () => {
  const root = realpathSync(repo());
  const r = run(["--check-observations", "f2a2877b", "--plan"], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot be combined/);
});

// spec §4 step 5 / §3.2: the reduce stage suppresses any candidate whose subject matches a
// landed cluster-signature. §10's amendment 1 requires an exact normalized-phrase match, not
// a similarity score, so casing/punctuation differences must still match and an unrelated
// subject sharing some words must not.
test("suppressedByLandedSignature reports a candidate matching a landed cluster-signature", () => {
  const root = realpathSync(repo());
  recordPromotion(root, { ...REC, clusterSignature: "task-reviewer flags files from a concurrent task" });
  const promotions = readPromotions(root);
  assert.equal(
    suppressedByLandedSignature("Task-Reviewer Flags Files From A Concurrent Task!", promotions),
    true,
  );
});

test("suppressedByLandedSignature reports a non-matching subject as not suppressed", () => {
  const root = realpathSync(repo());
  recordPromotion(root, { ...REC, clusterSignature: "task-reviewer flags files from a concurrent task" });
  const promotions = readPromotions(root);
  // Shares every word, scattered rather than contiguous — must not pass an exact-phrase match.
  assert.equal(
    suppressedByLandedSignature("files from a concurrent task were reviewed separately", promotions),
    false,
  );
});

test("cli: --check-suppressed reports suppressed:true without printing the signature text", () => {
  const root = realpathSync(repo());
  const signature = "task-reviewer flags files from a concurrent task";
  recordPromotion(root, { ...REC, clusterSignature: signature });
  const res = run(["--check-suppressed", signature], root);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { suppressed: true });
  assert.equal(res.stdout.includes(signature), false);
});

test("cli: --check-suppressed reports suppressed:false for an unrelated subject", () => {
  const root = realpathSync(repo());
  recordPromotion(root, { ...REC, clusterSignature: "task-reviewer flags files from a concurrent task" });
  const res = run(["--check-suppressed", "an entirely unrelated finding"], root);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { suppressed: false });
});

test("cli: --check-suppressed cannot be combined with --plan, --commit-checkpoint, or --record-promotion", () => {
  const root = realpathSync(repo());
  const recordJson = JSON.stringify({ ...REC, landed: "2026-08-05" });
  for (const other of [
    ["--plan"],
    ["--commit-checkpoint", "2026-08-05T12:00:00Z"],
    ["--record-promotion", recordJson],
  ]) {
    const r = run(["--check-suppressed", "some subject", ...other], root);
    assert.equal(r.status, 1, `--check-suppressed + ${other[0]} must be rejected`);
    assert.match(r.stderr, /cannot be combined/);
  }
});

// G1-b: --extract and --check-recurrence both dispatch and return before --check-suppressed's
// own handler, so without this pair a combined invocation silently ran the other subcommand
// and printed a payload with no `suppressed` key at all — which a caller parsing for
// `{"suppressed": ...}` reads as a confident (and wrong) "not suppressed".
test("cli: --check-suppressed cannot be combined with --extract or --check-recurrence", () => {
  const root = realpathSync(repo());
  for (const other of [["--extract", "some-session"], ["--check-recurrence"]]) {
    const r = run(["--check-suppressed", "some subject", ...other], root);
    assert.equal(r.status, 1, `--check-suppressed + ${other[0]} must be rejected`);
    assert.match(r.stderr, /cannot be combined/);
  }
});

// G1-a: `subject` is a normalized multi-word phrase (the skill's own example: "scenario
// evidence sections omitted"). A caller passing it unquoted lets the shell split it into
// several argv elements — reproduced here directly, without a shell, by passing each word as
// its own array element (spawnSync's array form never re-quotes, so this is exactly what a
// split unquoted invocation looks like to the process). Matching on the first word alone
// would silently answer for a phrase that was never actually checked against the landed
// signature below, so the extra words must be rejected rather than dropped.
test("cli: --check-suppressed rejects a subject split across several argv elements instead of matching the first word", () => {
  const root = realpathSync(repo());
  recordPromotion(root, { ...REC, clusterSignature: "scenario evidence sections omitted" });
  const r = run(["--check-suppressed", "scenario", "evidence", "sections", "omitted"], root);
  assert.equal(r.status, 1, "a split subject must be rejected, not matched on its first word");
  assert.match(r.stderr, /^dream: /m);
  assert.equal(r.stdout.trim(), "", "no {\"suppressed\": ...} payload on the rejected path");
});

test("extractSession: returns decoded message text for one session", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [
    [
      "s1",
      [
        {
          timestamp: "2026-08-05T12:00:00Z",
          type: "assistant",
          message: { content: [{ type: "text", text: "line one\nline two" }] },
        },
      ],
    ],
  ]);
  const text = extractSession({ repoRoot: root, projectsDir: proj, sessionId: "s1" });
  assert.match(text, /line one\nline two/);
});

test("extractSession: an unknown session id fails rather than returning empty", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [["s1", [plainRecord("2026-08-05T12:00:00Z")]]]);
  assert.throws(
    () => extractSession({ repoRoot: root, projectsDir: proj, sessionId: "nope" }),
    /no transcript for session: nope/,
  );
});

test("CLI --extract prints text; an unknown id exits 1 with a dream: message", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [
    [
      "s1",
      [
        {
          timestamp: "2026-08-05T12:00:00Z",
          type: "assistant",
          message: { content: [{ type: "text", text: "hello corpus" }] },
        },
      ],
    ],
  ]);
  const ok = spawnSync(process.execPath, [SCRIPT, "--extract", "s1"], {
    cwd: root,
    env: { ...process.env, CLAUDE_DREAM_PROJECTS: proj },
    encoding: "utf8",
  });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /hello corpus/);

  const bad = spawnSync(process.execPath, [SCRIPT, "--extract", "nope"], {
    cwd: root,
    env: { ...process.env, CLAUDE_DREAM_PROJECTS: proj },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^dream: no transcript for session: nope/m);
});

test("archives: a same-date ledger carries its glob and index together", () => {
  const root = realpathSync(repo());
  for (const name of ["archive-2026-08-02-feat-alpha", "archive-2026-08-02-fix-beta"]) {
    mkdirSync(join(root, ".devcycle", name), { recursive: true });
    writeFileSync(join(root, ".devcycle", name, "ledger.md"), "# ledger\n");
  }
  const m = planCorpus({
    repoRoot: root,
    projectsDir: projectsWith(root, [["s1", [plainRecord("2026-08-05T12:00:00Z")]]]),
    since: null,
  });
  const [first, second] = m.archives;
  assert.deepEqual(first.ledger, { glob: ".devcycle/archive-2026-08-02-*/ledger.md", index: 1 });
  assert.deepEqual(second.ledger, { glob: ".devcycle/archive-2026-08-02-*/ledger.md", index: 2 });
  // Still no branch slug anywhere in the manifest.
  assert.ok(!JSON.stringify(m).includes("feat-alpha"));
});

test("the manifest still carries no message text", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [
    [
      "s1",
      [
        {
          timestamp: "2026-08-05T12:00:00Z",
          type: "assistant",
          message: { content: [{ type: "text", text: "SECRET-CANARY-STRING" }] },
        },
      ],
    ],
  ]);
  const m = planCorpus({ repoRoot: root, projectsDir: proj, since: null });
  assert.ok(!JSON.stringify(m).includes("SECRET-CANARY-STRING"));
});

test("recordPromotion accepts enforcement-gap and rejects extract-to-script", () => {
  const root = realpathSync(repo());
  const ok = recordPromotion(root, {
    title: "Fix dispatches must not instruct the implementer to commit",
    promotionType: "enforcement-gap",
    clusterSignature: "implementer instructed to commit by its own brief",
    filesTouched: "playbooks/reviewing-the-branch.md",
    landed: "2026-08-05",
    commit: "abc1234",
  });
  assert.match(ok, /docs\/devcycle\/promotions\/2026-08-05-/);
  assert.throws(
    () =>
      recordPromotion(root, {
        title: "dead type",
        promotionType: "extract-to-script",
        clusterSignature: "sig",
        filesTouched: "x.md",
        landed: "2026-08-05",
        commit: "abc1234",
      }),
    /promotionType/,
  );
});

test("--check-recurrence reports failures as dream: <message>, not a stack trace", () => {
  const root = realpathSync(repo());
  // A projects root that exists but is a file, not a directory: readable-path failure, which
  // §9 requires to surface as a failure rather than an empty success.
  const notADir = join(root, "not-a-dir");
  writeFileSync(notADir, "x\n");
  const r = spawnSync(process.execPath, [SCRIPT, "--check-recurrence"], {
    cwd: root,
    env: { ...process.env, CLAUDE_DREAM_PROJECTS: notADir },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^dream: /m);
  assert.doesNotMatch(r.stderr, /at .*dream\.mjs:\d+/, "no raw stack trace");
});

test("--record-promotion cannot be combined with the other subcommands", () => {
  const root = realpathSync(repo());
  const json = JSON.stringify({
    title: "t",
    promotionType: "doc-edit",
    clusterSignature: "s",
    filesTouched: "x.md",
    landed: "2026-08-05",
    commit: "abc1234",
  });
  for (const other of [["--plan"], ["--check-recurrence"], ["--commit-checkpoint", "2026-08-05T12:00:00Z"]]) {
    const r = spawnSync(process.execPath, [SCRIPT, "--record-promotion", json, ...other], {
      cwd: root,
      env: { ...process.env, CLAUDE_DREAM_PROJECTS: join(root, "projects") },
      encoding: "utf8",
    });
    assert.equal(r.status, 1, `--record-promotion + ${other[0]} must be rejected`);
    assert.match(r.stderr, /cannot be combined/);
  }
});

test("a missing projects root fails rather than reporting an empty corpus", () => {
  const root = realpathSync(repo());
  const r = spawnSync(process.execPath, [SCRIPT, "--plan"], {
    cwd: root,
    env: { ...process.env, CLAUDE_DREAM_PROJECTS: join(root, "no-such-projects-root") },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^dream: projects root does not exist/m);
});

test("messageText: decodes string and text-block content, ignores tool blocks", () => {
  assert.equal(messageText({ message: { content: "plain string" } }), "plain string");
  assert.equal(
    messageText({
      message: {
        content: [
          { type: "text", text: "kept" },
          { type: "tool_use", name: "Bash", input: { command: "dropped" } },
          { type: "text", text: "also kept" },
        ],
      },
    }),
    "kept\nalso kept",
  );
  assert.equal(messageText({ message: {} }), "");
  assert.equal(messageText({}), "");
});

test("a promotion record round-trips the two provenance fields", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "Example promotion",
    promotionType: "doc-edit",
    clusterSignature: "example signature",
    filesTouched: ["references/example.md"],
    landed: "2026-08-12",
    commit: "abc1234",
    pluginVersion: "0.13.0",
    sourcedFromMemory: true,
  });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^- plugin-version: 0\.13\.0$/m);
  assert.match(text, /^- sourced-from-memory: true$/m);

  const [rec] = readPromotions(root);
  assert.equal(rec.pluginVersion, "0.13.0");
  assert.equal(rec.sourcedFromMemory, true);
});

test("a promotion recorded without either provenance key round-trips both as absent, not false", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "No provenance supplied",
    promotionType: "doc-edit",
    clusterSignature: "no provenance",
    filesTouched: ["a.md"],
    landed: "2026-08-12",
    commit: "abc1234",
  });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^- plugin-version: $/m);
  assert.match(text, /^- sourced-from-memory: $/m);

  const [rec] = readPromotions(root);
  assert.equal(rec.pluginVersion, null);
  assert.equal(rec.sourcedFromMemory, null);
});

test("a promotion recorded with sourcedFromMemory explicitly false round-trips as false, not absent", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "Explicit false provenance",
    promotionType: "doc-edit",
    clusterSignature: "explicit false",
    filesTouched: ["a.md"],
    landed: "2026-08-12",
    commit: "abc1234",
    sourcedFromMemory: false,
  });
  assert.match(readFileSync(path, "utf8"), /^- sourced-from-memory: false$/m);

  const [rec] = readPromotions(root);
  assert.equal(rec.sourcedFromMemory, false);
});

test("a non-boolean sourcedFromMemory (a hand-authored \"true\" string) is refused, not silently written as false", () => {
  const root = repo();
  assert.throws(
    () =>
      recordPromotion(root, {
        title: "String provenance",
        promotionType: "doc-edit",
        clusterSignature: "string provenance",
        filesTouched: ["a.md"],
        landed: "2026-08-12",
        commit: "abc1234",
        sourcedFromMemory: "true",
      }),
    /sourced-from-memory must be a boolean or absent/,
  );
});

test("a record written before these fields existed parses with both absent, not defaulted", () => {
  const root = repo();
  mkdirSync(join(root, "docs/devcycle/promotions"), { recursive: true });
  writeFileSync(join(root, "docs/devcycle/promotions/2026-08-05-legacy.md"),
    "# Legacy\n- promotion-type: doc-edit\n- cluster-signature: old\n" +
    "- files-touched: a.md\n- landed: 2026-08-05\n- commit: abc1234\n");
  const [rec] = readPromotions(root);
  assert.equal(rec.pluginVersion, null);
  assert.equal(rec.sourcedFromMemory, null);
});

test("readPromotions reads the culprit id a promotion shipped", () => {
  // Hand-written rather than round-tripped through recordPromotion: that writer gains the
  // field in Phase 3, and the reader has to understand a record before one is ever written —
  // otherwise doctor's Shipped column is empty by construction rather than for want of data.
  const root = repo();
  mkdirSync(join(root, "docs/devcycle/promotions"), { recursive: true });
  writeFileSync(join(root, "docs/devcycle/promotions/2026-08-05-shipped.md"),
    "# Shipped\n- promotion-type: doc-edit\n- cluster-signature: sig\n- files-touched: a.md\n" +
    "- landed: 2026-08-05\n- commit: abc1234\n- plugin-version: 0.13.0\n" +
    "- culprit-id: partial-evidence-capture\n");
  const [rec] = readPromotions(root);
  assert.equal(rec.culpritId, "partial-evidence-capture");
  assert.equal(rec.pluginVersion, "0.13.0");
});

test("a record written before culprit-id existed parses it as absent, not as an empty string", () => {
  const root = repo();
  mkdirSync(join(root, "docs/devcycle/promotions"), { recursive: true });
  writeFileSync(join(root, "docs/devcycle/promotions/2026-08-05-legacy-culprit.md"),
    "# Legacy\n- promotion-type: doc-edit\n- cluster-signature: old\n- files-touched: a.md\n" +
    "- landed: 2026-08-05\n- commit: abc1234\n");
  assert.equal(readPromotions(root)[0].culpritId, null);
});

test("a newline inside a provenance value cannot forge a second field line", () => {
  const root = repo();
  const path = recordPromotion(root, {
    title: "Injection attempt",
    promotionType: "doc-edit",
    clusterSignature: "sig",
    filesTouched: ["a.md"],
    landed: "2026-08-12",
    commit: "abc1234",
    pluginVersion: "0.13.0\n- landed: 1999-01-01",
    sourcedFromMemory: false,
  });
  assert.equal(readFileSync(path, "utf8").match(/^- landed:/gm).length, 1);
});
