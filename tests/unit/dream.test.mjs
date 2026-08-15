import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  readCheckpoint,
  writeCheckpoint,
  commitCheckpoint,
  planCorpus,
  artifactFresh,
  observationsDir,
  hasObservations,
  listObservations,
  readObservations,
  extractSession,
  messageText,
} from "../../scripts/dream.mjs";

// The promotion reader/writer moved to promotions.mjs; the record-shape tests below were
// written against it while it lived in dream.mjs and still pin the same behaviour, so they
// travel with the import rather than being dropped.
import { readPromotions, recordPromotion } from "../../scripts/promotions.mjs";
import { repoSlug } from "../../scripts/run-record.mjs";

const SCRIPT = new URL("../../scripts/dream.mjs", import.meta.url).pathname;
// This repo itself, for the criteria that must run against its real promotion records.
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

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

// F3-F6 fixtures need a session carrying real message text and, for F5, the ability to grow
// after planCorpus has already run once — plainRecord/selfRecord above only carry a timestamp.
// One session per call, always named CORPUS_SESSION_ID: sessionIdOf(root) hands that id back
// so a test never has to know it by magic string.
const CORPUS_SESSION_ID = "s1";
const sessionIdOf = () => CORPUS_SESSION_ID;

function corpusRecord({ role = "user", ts, text, toolResult }) {
  const content =
    toolResult !== undefined
      ? [{ type: "tool_result", content: toolResult }]
      : [{ type: "text", text: text ?? "" }];
  return { timestamp: ts, type: role, message: { role, content } };
}

// `text` is the common case of one user turn; `records` hands raw {role, ts, text|toolResult}
// shapes for a test that needs a specific block type (e.g. a tool_result). `padding` inflates
// on-disk bytes without inflating the extracted text, which is what F4's "extractBytes is far
// smaller than totalBytes" assertion needs something to divide by — it lands as trailing
// whitespace on the JSONL line, which JSON.parse ignores. `append` lets a test grow the session
// after planCorpus has already run once (F5's reopened-slice case).
function corpusWithSession({ text, records, padding = 0 } = {}) {
  const root = realpathSync(repo());
  const dir = mkdtempSync(join(tmpdir(), "dream-proj-"));
  const slug = join(dir, root.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(slug, { recursive: true });
  const file = join(slug, `${CORPUS_SESSION_ID}.jsonl`);
  const entries = records ?? [{ role: "user", ts: "2026-08-05T12:00:00Z", text }];
  const line = (r) => JSON.stringify(corpusRecord(r)) + (padding ? " ".repeat(padding) : "") + "\n";
  writeFileSync(file, entries.map(line).join(""));
  const append = (moreText) =>
    appendFileSync(file, line({ role: "user", ts: "2026-08-05T12:05:00Z", text: moreText }));
  return { root, projects: dir, append };
}

function writeObservationFile(root, id, observations) {
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), `${id}.json`), JSON.stringify(observations));
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

// F5: unmined and observations are now keyed by each session's slice id (session id + size +
// content hash), not the bare session id — a slice id is only knowable after planCorpus has
// looked at the session once, so this reads it back off the first call's own sessions list.
test("planCorpus: unmined lists exactly the sessions with no observation file", () => {
  const root = realpathSync(repo());
  const proj = projectsWith(root, [
    ["mined", [plainRecord("2026-08-05T12:00:00Z")]],
    ["fresh", [plainRecord("2026-08-05T12:30:00Z")]],
  ]);
  const before = planCorpus({ repoRoot: root, projectsDir: proj, since: null });
  const minedSlice = before.sessions.find((s) => s.id === "mined").slice;
  const freshSlice = before.sessions.find((s) => s.id === "fresh").slice;
  writeObservationFile(root, minedSlice, []);
  // A non-session slice: the memory store is mined at every profile and has no session id.
  writeObservationFile(root, "memory", []);
  const m = planCorpus({ repoRoot: root, projectsDir: proj, since: null });
  assert.deepEqual(m.unmined, [freshSlice], "unmined is the session-shaped work list");
  assert.deepEqual(m.observations, ["memory", minedSlice].sort(), "observations lists every slice id");
  assert.equal(hasObservations(root, minedSlice), true);
  assert.equal(hasObservations(root, freshSlice), false);
  assert.deepEqual(listObservations(root), ["memory", minedSlice].sort());
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

// G1-a: the argument is one culprit-id. A caller who passes anything else — an unquoted title
// the shell split into several argv elements, reproduced here by passing each word as its own
// array element — must be refused: answering for the first element alone would report on an id
// that was never actually checked.
test("cli: --check-suppressed rejects an argument split across several argv elements instead of answering for the first", () => {
  const root = realpathSync(repo());
  const r = run(["--check-suppressed", "scenario", "evidence", "sections", "omitted"], root);
  assert.equal(r.status, 1, "a split argument must be rejected, not matched on its first word");
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
  // The recurrence corpus is the journal now, so its readable-path failure is a journal line
  // that does not parse — which §9 requires to surface as a failure rather than as an empty
  // (and reassuring) result set.
  const { root, runsDir } = corpusWithJournal({
    promotions: [{ culpritId: "friction:x", rung: "r2", landed: "2026-01-01", verify: "journal-recurrence" }],
  });
  mkdirSync(join(runsDir, repoSlug(root)), { recursive: true });
  writeFileSync(join(runsDir, repoSlug(root), `${"a".repeat(16)}.jsonl`), "{not json\n");
  const r = run(["--check-recurrence"], root, { DEVCYCLE_RUNS_DIR: runsDir });
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

// F3: the role and timestamp are now part of the returned text (see F3's tests further down),
// so this asserts the prefixed shape rather than the old flat text.
test("messageText: decodes string and text-block content, ignores tool_use blocks", () => {
  assert.equal(
    messageText({ timestamp: "2026-08-05T12:00:00Z", type: "user", message: { content: "plain string" } }),
    "[2026-08-05T12:00:00Z] user: plain string",
  );
  assert.equal(
    messageText({
      timestamp: "2026-08-05T12:00:00Z",
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "kept" },
          { type: "tool_use", name: "Bash", input: { command: "dropped" } },
          { type: "text", text: "also kept" },
        ],
      },
    }),
    "[2026-08-05T12:00:00Z] assistant: kept\nalso kept",
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

test("F3: extracted text carries each message's role and timestamp", () => {
  const { root, projects } = corpusWithSession({ text: "hello world" });
  const out = extractSession({ repoRoot: root, projectsDir: projects, sessionId: sessionIdOf(root) });
  assert.match(out, /^\[2\d{3}-\d{2}-\d{2}T[\d:.]+Z?\] (user|assistant): /m,
    "a correction slice cannot separate user turns from assistant turns without the role");
});

test("F3: an AskUserQuestion answer arriving as a tool_result is not silently dropped", () => {
  const { root, projects } = corpusWithSession({
    records: [{ role: "user", ts: "2026-08-01T00:00:00Z", toolResult: "Other: keep the labels off" }],
  });
  const out = extractSession({ repoRoot: root, projectsDir: projects, sessionId: sessionIdOf(root) });
  assert.match(out, /keep the labels off/,
    "the answers to AskUserQuestion arrive as tool_result blocks — dropping them loses the corrections");
});

test("F4: the budgeting number is the extract sum, not the on-disk size", () => {
  const { root, projects } = corpusWithSession({ text: "hello world", padding: 50_000 });
  const m = planCorpus({ repoRoot: root, projectsDir: projects, since: null });
  assert.ok(m.extractBytes > 0, "extractBytes must be populated");
  assert.ok(m.extractBytes < m.totalBytes / 10,
    "the extract sum is the model-visible input; totalBytes is JSONL on disk and overstates it");
});

test("F5: a slice id carries the session's size and content hash", () => {
  const { root, projects } = corpusWithSession({ text: "one" });
  const [a] = planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined;
  assert.match(a, /@\d+-[0-9a-f]{8}$/);
});

test("F5: a session that grew is unmined again, under a new slice id", () => {
  const { root, projects, append } = corpusWithSession({ text: "one" });
  const first = planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined[0];
  writeObservationFile(root, first, [{ kind: "friction", subject: "s", quote: "q", target: null }]);
  assert.deepEqual(planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined, []);
  append("two");
  const after = planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined;
  assert.equal(after.length, 1, "growth reopens the slice");
  assert.notEqual(after[0], first, "under a new id, so the old observation file is not overwritten");
});

test("F6: an observation filename that is not a manifest slice id is reported", () => {
  const { root, projects } = corpusWithSession({ text: "one" });
  writeObservationFile(root, "truncated-id", [{ kind: "friction", subject: "s", quote: "q", target: null }]);
  const m = planCorpus({ repoRoot: root, projectsDir: projects, since: null });
  assert.deepEqual(m.orphanObservations, ["truncated-id"],
    "a file the manifest cannot address is named, never silently counted as mined");
});

test("happy-path gap: a truncated observation file counts as unmined, not as mined forever", () => {
  const { root, projects } = corpusWithSession({ text: "one" });
  const [id] = planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined;
  mkdirSync(observationsDir(root), { recursive: true });
  writeFileSync(join(observationsDir(root), `${id}.json`), "[{\"kind\":\"fricti");
  const m = planCorpus({ repoRoot: root, projectsDir: projects, since: null });
  assert.deepEqual(m.unmined, [id], "an unreadable file is work still to do");
});

test("happy-path gap: an observation file with an out-of-enum kind counts as unmined", () => {
  const { root, projects } = corpusWithSession({ text: "one" });
  const [id] = planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined;
  writeObservationFile(root, id, [{ kind: "guessed", subject: "s", quote: "q", target: null }]);
  assert.deepEqual(planCorpus({ repoRoot: root, projectsDir: projects, since: null }).unmined, [id]);
});

// The rewired CLI's own corpus: corpusWithSession's transcript fixture (QC2 — one corpus
// builder, extended, not a second one beside it) plus the two structured stores the engine now
// reads by id — the friction journal under DEVCYCLE_RUNS_DIR, and promotion records written by
// the same writer the CLI itself uses.
function corpusWithJournal({ events = [], promotions = [], text = "one" } = {}) {
  const { root, projects, append } = corpusWithSession({ text });
  const runsDir = mkdtempSync(join(tmpdir(), "dream-runs-"));
  const byRun = new Map();
  for (const e of events) {
    const runId = e.runId ?? "0".repeat(16);
    if (!byRun.has(runId)) byRun.set(runId, []);
    byRun.get(runId).push({
      kind: "event",
      runId,
      event: "gate-fail",
      stage: "execution",
      culprit: e.culprit,
      ts: e.ts,
    });
  }
  if (byRun.size) {
    const dir = join(runsDir, repoSlug(root));
    mkdirSync(dir, { recursive: true });
    for (const [runId, lines] of byRun)
      writeFileSync(join(dir, `${runId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  for (const p of promotions)
    recordPromotion(root, {
      title: `promotion for ${p.culpritId}`,
      promotionType: "doc-edit",
      clusterSignature: `signature for ${p.culpritId}`,
      filesTouched: [],
      commit: "abc1234",
      ...p,
    });
  return { root, projects, runsDir, append };
}

// The candidate file exactly as spec §3 pins it — no field added, renamed, dropped or re-typed
// (QC1). Written to a temp path so --render-report has a real file to read.
function writeCandidateFixture() {
  const dir = mkdtempSync(join(tmpdir(), "dream-candidates-"));
  const path = join(dir, "candidates.json");
  writeFileSync(
    path,
    JSON.stringify({
      repo: "devcycle",
      generatedAt: "2026-08-14T00:00:00Z",
      profile: "thorough",
      corpus: {
        sessions: 9,
        from: "2026-08-01",
        to: "2026-08-14",
        capped: false,
        journalEvents: 214,
        journalEmpty: false,
      },
      checkpoint: { before: "2026-08-01T00:00:00Z", after: "2026-08-14T00:00:00Z" },
      attribution: { vocabulary: 17, novel: 3 },
      candidates: [
        {
          title: "Flaky retry masks a real dependency-order bug",
          culpritId: "friction:flaky-test-retry",
          aliases: [],
          disposition: "landed",
          partition: "bulk",
          rung: "r2",
          whyNotHigher: "the fix is a repo-specific fixture ordering issue",
          locations: ["docs/devcycle/lessons.md#executing-waves"],
          fault: "repo",
          scope: "repo-devs",
          impact: 4.1,
          occurrences: 7,
          trend: "recurring",
          priorOccurrences: 4,
          evidenceSessions: 3,
          verify: "journal-recurrence",
          sourcedFromMemory: false,
          sensitive: false,
          legacyDuplicateOf: null,
          declineReason: null,
        },
      ],
      contradictions: [{ culpritId: "contradiction:x", sideA: "...", sideB: "...", chosen: "sideA" }],
      evictions: [{ culpritId: "friction:old-thing", section: "executing-waves", reason: "cap" }],
    }),
  );
  return path;
}

test("criterion 1: a non-empty journal issues zero mining dispatches for the journal slice", () => {
  const { root, projects, runsDir } = corpusWithJournal({
    events: [{ culprit: "friction:flaky-test-retry", ts: "2026-08-10T00:00:00Z" }],
  });
  const m = JSON.parse(
    run(["--plan"], root, { CLAUDE_DREAM_PROJECTS: projects, DEVCYCLE_RUNS_DIR: runsDir }).stdout,
  );
  assert.equal(m.journal.empty, false);
  assert.ok(m.journal.events > 0, "the fixture journal must be non-empty — an empty one passes this vacuously");
  assert.ok(
    !m.unmined.some((id) => id.startsWith("journal")),
    "the journal is already structured: it is never a mining slice",
  );
});

test("criterion 2: an empty journal reports `empty`, distinct from read-and-found-nothing", () => {
  const { root, projects, runsDir } = corpusWithJournal({ events: [] });
  const m = JSON.parse(
    run(["--plan"], root, { CLAUDE_DREAM_PROJECTS: projects, DEVCYCLE_RUNS_DIR: runsDir }).stdout,
  );
  assert.equal(m.journal.empty, true);
  assert.equal(m.journal.events, 0);
});

test("criterion 3: suppression is an id lookup", () => {
  const res = run(["--check-suppressed", "friction:flaky-test-retry"], REPO_ROOT);
  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { suppressed: false });

  // The other half of "an id lookup": a landed record carrying that exact id suppresses it,
  // and its own prose (title, cluster-signature) has nothing to do with the verdict.
  const { root } = corpusWithJournal({
    promotions: [{ culpritId: "friction:flaky-test-retry", rung: "r2", landed: "2026-01-01" }],
  });
  const hit = run(["--check-suppressed", "friction:flaky-test-retry"], root);
  assert.equal(hit.status, 0);
  assert.deepEqual(JSON.parse(hit.stdout), { suppressed: true });
});

test("criterion 4: a legacy record produces a hint, never a suppression", () => {
  const title = "Brace-group the chained evidence commands before redirecting";
  assert.deepEqual(
    JSON.parse(run(["--check-suppressed", "friction:bare-chained-redirect"], REPO_ROOT).stdout),
    { suppressed: false },
  );
  const hints = JSON.parse(run(["--legacy-similar", title], REPO_ROOT).stdout).hints;
  assert.ok(hints.length >= 1, "the legacy record with that title is hinted");
  assert.ok(hints.every((h) => h.path.startsWith("docs/devcycle/promotions/")));
});

test("--novel-slugs lists the novel ids the clustering dispatch must dedup against", () => {
  const res = run(["--novel-slugs"], REPO_ROOT);
  assert.equal(res.status, 0);
  assert.ok(Array.isArray(JSON.parse(res.stdout).slugs));
});

test("criterion 10: zero observed runs is unmeasurable, never held", () => {
  const { root, runsDir } = corpusWithJournal({
    events: [],
    promotions: [{ culpritId: "friction:x", rung: "r2", landed: "2026-01-01", verify: "journal-recurrence" }],
  });
  const out = JSON.parse(run(["--check-recurrence"], root, { DEVCYCLE_RUNS_DIR: runsDir }).stdout);
  const [r] = out.scoreboard;
  assert.equal(r.verdict, "unmeasurable");
  assert.equal(r.runsObserved, 0);
  assert.notEqual(r.verdict, "held");
});

test("--check-recurrence reports held with its run count, and recurred when the id reappears", () => {
  const { root, runsDir } = corpusWithJournal({
    promotions: [{ culpritId: "friction:x", rung: "r2", landed: "2026-01-01", verify: "journal-recurrence" }],
    events: [
      { culprit: "friction:y", ts: "2026-02-01T00:00:00Z", runId: "a".repeat(16) },
      { culprit: "friction:y", ts: "2026-03-01T00:00:00Z", runId: "b".repeat(16) },
    ],
  });
  const held = JSON.parse(run(["--check-recurrence"], root, { DEVCYCLE_RUNS_DIR: runsDir }).stdout).scoreboard[0];
  assert.equal(held.verdict, "held");
  assert.equal(held.runsObserved, 2);

  const { root: r2, runsDir: d2 } = corpusWithJournal({
    promotions: [{ culpritId: "friction:x", rung: "r2", landed: "2026-01-01", verify: "journal-recurrence" }],
    events: [{ culprit: "friction:x", ts: "2026-02-01T00:00:00Z", runId: "a".repeat(16) }],
  });
  const recurred = JSON.parse(run(["--check-recurrence"], r2, { DEVCYCLE_RUNS_DIR: d2 }).stdout).scoreboard[0];
  assert.equal(recurred.verdict, "recurred");
  assert.equal(recurred.recurrences, 1);
});

test("criterion 11: --record-promotion rejects an r3 verify that does not resolve", () => {
  const root = realpathSync(repo());
  const res = run(
    [
      "--record-promotion",
      JSON.stringify({
        title: "t",
        promotionType: "doc-edit",
        clusterSignature: "s",
        filesTouched: [],
        landed: "2026-08-14",
        commit: "abc",
        pluginVersion: "0.13.0",
        culpritId: "friction:x",
        rung: "r3",
        verify: "tests/unit/nope.test.mjs",
      }),
    ],
    root,
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /r3 verify "tests\/unit\/nope\.test\.mjs" resolves to no path/);
});

test("--lessons prints three labelled subsections and rejects an unknown stage", () => {
  const learnings = mkdtempSync(join(tmpdir(), "dream-learnings-"));
  const ok = run(["--lessons", "execution"], REPO_ROOT, { DEVCYCLE_LEARNINGS_DIR: learnings });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /repo \(docs\/devcycle\/lessons\.md\)/);
  const bad = run(["--lessons", "not-a-stage"], REPO_ROOT, { DEVCYCLE_LEARNINGS_DIR: learnings });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown stage "not-a-stage"/);
});

test("criterion 8: --render-report and --render-report --outcome agree on structure", () => {
  const path = writeCandidateFixture();
  const a = run(["--render-report", path], REPO_ROOT).stdout;
  const b = run(["--render-report", path, "--outcome"], REPO_ROOT).stdout;
  const heads = (s) => (s.match(/^#{2,3} .*$/gm) ?? []);
  assert.deepEqual(heads(a), heads(b));
  assert.match(a, /^# Learn Report \(proposal\)/m);
  assert.match(b, /^# Learn Report \(outcome\)/m);
});

test("--render-report on an unreadable file exits nonzero rather than printing an empty report", () => {
  const res = run(["--render-report", join(tmpdir(), "no-such-candidates.json")], REPO_ROOT);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /dream: /);
});

test("every new subcommand refuses to be combined with another", () => {
  const root = realpathSync(repo());
  for (const pair of [
    ["--lessons", "execution", "--plan"],
    ["--novel-slugs", "--check-recurrence"],
    ["--journal-events", "--plan"],
    ["--render-report", "x", "--check-suppressed", "y"],
  ]) {
    const res = run(pair, root);
    assert.notEqual(res.status, 0, `${pair.join(" ")} must not be accepted`);
    assert.match(res.stderr, /cannot be combined/);
  }
});

test("--journal-events keys the journal by culprit-id and says whether the store is empty", () => {
  const { root, runsDir } = corpusWithJournal({
    events: [
      { culprit: "friction:x", ts: "2026-02-01T00:00:00Z", runId: "a".repeat(16) },
      { culprit: "friction:x", ts: "2026-03-01T00:00:00Z", runId: "b".repeat(16) },
    ],
  });
  const out = JSON.parse(run(["--journal-events"], root, { DEVCYCLE_RUNS_DIR: runsDir }).stdout);
  assert.equal(out.journalEmpty, false);
  assert.equal(out.byCulprit["friction:x"].length, 2);

  const windowed = JSON.parse(
    run(["--journal-events", "--since", "2026-02-15T00:00:00Z"], root, { DEVCYCLE_RUNS_DIR: runsDir }).stdout,
  );
  assert.equal(windowed.events.length, 1, "--since bounds the window");
  assert.equal(windowed.journalEmpty, false, "a windowed-away event is not an empty store");
});

// The window the three verdicts hang on: an event dated on or before `landed` cannot say
// anything about a promotion that did not exist yet. Were pre-landed events counted,
// `runsObserved` would be non-zero from runs the promotion cannot have influenced and the
// verdict would read `held` off them — the F1 failure this engine exists to stop, and the
// Global Constraint "zero observed runs is never reported as held".
test("--check-recurrence ignores journal events dated on or before the promotion's landed date", () => {
  const { root, runsDir } = corpusWithJournal({
    promotions: [{ culpritId: "friction:x", rung: "r2", landed: "2026-05-01", verify: "journal-recurrence" }],
    events: [
      { culprit: "friction:x", ts: "2026-01-01T00:00:00Z", runId: "a".repeat(16) },
      // The boundary itself: a run on the landing day is not evidence about the landing.
      { culprit: "friction:x", ts: "2026-05-01T23:00:00Z", runId: "b".repeat(16) },
    ],
  });
  const [r] = JSON.parse(run(["--check-recurrence"], root, { DEVCYCLE_RUNS_DIR: runsDir }).stdout).scoreboard;
  assert.equal(r.verdict, "unmeasurable");
  assert.equal(r.runsObserved, 0, "runs that predate the landing are outside the window entirely");
  assert.equal(r.recurrences, 0);
  assert.notEqual(r.verdict, "held", "a run that predates the promotion is not evidence the lesson held");
});

// The pinned shape against the shared engine (verification.mjs): `--check-recurrence` now emits
// the engine's full output — `{ scoreboard, candidates, resolvedIn }`, a superset of the old
// `{ results }` — and each scoreboard row carries the engine's own key set. QC10 still holds: a
// promotion's title and cluster-signature are prose and neither may reach the caller's transcript.
test("--check-recurrence output matches the pinned engine shape and carries no record prose", () => {
  const { root, runsDir } = corpusWithJournal({
    promotions: [{ culpritId: "friction:x", rung: "r2", landed: "2026-01-01", verify: "journal-recurrence" }],
    events: [{ culprit: "friction:x", ts: "2026-02-01T00:00:00Z", runId: "a".repeat(16) }],
  });
  const res = run(["--check-recurrence"], root, { DEVCYCLE_RUNS_DIR: runsDir });
  const out = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(out).sort(), ["candidates", "resolvedIn", "scoreboard"]);
  assert.ok(Array.isArray(out.scoreboard));
  assert.ok(out.candidates && Array.isArray(out.candidates.escalation) && Array.isArray(out.candidates.retirement));
  assert.ok(Array.isArray(out.resolvedIn));

  const [r] = out.scoreboard;
  assert.deepEqual(
    Object.keys(r).sort(),
    ["culpritId", "detail", "recurrences", "rung", "runsObserved", "verdict"],
  );
  assert.equal(r.culpritId, "friction:x");
  assert.equal(r.verdict, "recurred");
  assert.equal(r.recurrences, 1);

  const [promo] = readPromotions(root);
  assert.equal(res.stdout.includes(promo.title), false, "a record's title is prose and must not be echoed");
  assert.equal(
    res.stdout.includes(promo.clusterSignature),
    false,
    "a cluster-signature is prose and must not be echoed",
  );
});

test("the deleted prose matchers are gone from the source", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(src, /suppressedByLandedSignature/, "the prose comparison is deleted (spec §5)");
  assert.doesNotMatch(src, /s\.normalized\.includes\(sig\)/, "raw-text recurrence matching is deleted");
});

// A lifecycle record (retirement/revert) is not a landing: --record-lifecycle writes it via the
// promotions store's own writer and it reads back tagged `lifecycle`, carrying none of the
// promotion-specific fields (spec §7 / Phase 4).
test("--record-lifecycle writes a lifecycle record that reads back tagged, not as a landing", () => {
  const root = realpathSync(repo());
  const res = run(
    [
      "--record-lifecycle",
      JSON.stringify({
        lifecycle: "retirement",
        title: "Retire the flaky-test-retry lesson",
        culpritId: "friction:flaky-test-retry",
        rung: "r2",
        landed: "2026-01-01",
        at: "2026-08-15",
        reason: "held 12 runs since 2026-01-01",
      }),
    ],
    root,
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout.trim(), /docs\/devcycle\/promotions\/2026-08-15-flaky-test-retry-retired\.md$/);

  const records = readPromotions(root);
  const rec = records.find((p) => p.culpritId === "friction:flaky-test-retry");
  assert.ok(rec, "the record reads back");
  assert.equal(rec.lifecycle, "retirement", "it is tagged as a lifecycle record");
  assert.equal(rec.promotionType, "", "it carries none of the promotion (landing) fields");
});

test("--record-lifecycle rejects a missing record argument with a dream: error", () => {
  const root = realpathSync(repo());
  const res = run(["--record-lifecycle"], root);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /dream: /);
});

// Spec §7 / QC5/QC6 (coordinator ruling): the --render-report path reports the always-loaded
// net-byte figure and hard-gates growth past the ceiling. A run whose landed always-loaded output
// exceeds ALWAYS_LOADED_CEILING (1200) without a same-run eviction/retirement is refused; the same
// growth paired with an eviction passes and renders the net-byte line. Fixtures carry real bloat
// (a >1200-byte landed line), never a vacuous zero.
function writeBudgetFixture({ evict }) {
  const dir = mkdtempSync(join(tmpdir(), "dream-budget-"));
  const path = join(dir, "candidates.json");
  writeFileSync(
    path,
    JSON.stringify({
      repo: "devcycle",
      generatedAt: "2026-08-15T00:00:00Z",
      profile: "thorough",
      corpus: { sessions: 3, from: "2026-08-01", to: "2026-08-15", capped: false, journalEvents: 4, journalEmpty: false },
      checkpoint: { before: "2026-08-01T00:00:00Z", after: "2026-08-15T00:00:00Z" },
      attribution: { vocabulary: 1, novel: 0 },
      candidates: [
        {
          title: "x".repeat(1300),
          culpritId: "friction:bloat",
          aliases: [],
          disposition: "landed",
          partition: "bulk",
          rung: "r2",
          whyNotHigher: "digest line",
          locations: ["docs/devcycle/lessons.md#executing-waves"],
          fault: "repo",
          scope: "repo-devs",
          impact: 1.0,
          occurrences: 2,
          trend: "new",
          priorOccurrences: 0,
          evidenceSessions: 1,
          verify: "journal-recurrence",
          sourcedFromMemory: false,
          sensitive: false,
          legacyDuplicateOf: null,
          declineReason: null,
        },
      ],
      contradictions: [],
      evictions: evict ? [{ culpritId: "friction:old-thing", section: "executing-waves", reason: "cap" }] : [],
    }),
  );
  return path;
}

test("--render-report refuses always-loaded growth past the ceiling without a same-run retirement", () => {
  const res = run(["--render-report", writeBudgetFixture({ evict: false })], REPO_ROOT);
  assert.notEqual(res.status, 0, "an over-ceiling run with no eviction is refused");
  assert.match(res.stderr, /dream: /);
  assert.match(res.stderr, /1200/, "the refusal names the ceiling");
});

test("--render-report passes the same growth when it is paired with an eviction, and renders the net-byte line", () => {
  const res = run(["--render-report", writeBudgetFixture({ evict: true })], REPO_ROOT);
  assert.equal(res.status, 0, res.stderr);
  const m = res.stdout.match(/^Always-loaded budget: (\d+) bytes \(within budget\)/m);
  assert.ok(m, "the net-byte line is rendered");
  assert.ok(Number(m[1]) > 1200, "the reported growth is real (>1200 bytes), not a vacuous zero");
  assert.match(res.stdout, /^# Learn Report \(proposal\)/m, "the report body still renders");
});
