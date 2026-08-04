import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCheckpoint,
  writeCheckpoint,
  planCorpus,
  artifactFresh,
  recordPromotion,
  readPromotions,
  checkRecurrence,
} from "../../scripts/dream.mjs";

const repo = () => mkdtempSync(join(tmpdir(), "dream-repo-"));

function projects(sessions) {
  const dir = mkdtempSync(join(tmpdir(), "dream-proj-"));
  const slug = join(dir, "-some-project");
  mkdirSync(slug, { recursive: true });
  for (const [id, ts] of sessions) {
    const rec = { timestamp: ts, type: "assistant", message: { content: [] } };
    writeFileSync(join(slug, `${id}.jsonl`), JSON.stringify(rec) + "\n");
  }
  return dir;
}

test("checkpoint initializes to never and round-trips", () => {
  const root = repo();
  assert.deepEqual(readCheckpoint(root), { lastDreamedThrough: null, lastArtifact: null });
  writeCheckpoint(root, { lastDreamedThrough: "2026-08-01T00:00:00Z", lastArtifact: "a.md" });
  assert.deepEqual(readCheckpoint(root), {
    lastDreamedThrough: "2026-08-01T00:00:00Z",
    lastArtifact: "a.md",
  });
});

test("the cap keeps the most recent sessions and flags that it bound the input", () => {
  const many = Array.from({ length: 7 }, (_, i) => [
    `sess-${String(i).padStart(2, "0")}`,
    `2026-08-0${i + 1}T00:00:00Z`,
  ]);
  const m = planCorpus({ repoRoot: repo(), projectsDir: projects(many), since: null, cap: 3 });
  assert.equal(m.capped, true);
  assert.equal(m.sessions.length, 3);
  assert.deepEqual(m.sessions.map((s) => s.id), ["sess-06", "sess-05", "sess-04"]);
});

test("an uncapped corpus reports capped false", () => {
  const m = planCorpus({
    repoRoot: repo(),
    projectsDir: projects([["a", "2026-08-01T00:00:00Z"]]),
    since: null,
    cap: 100,
  });
  assert.equal(m.capped, false);
  assert.equal(m.sessions.length, 1);
});

test("since excludes sessions that ended before the checkpoint", () => {
  const m = planCorpus({
    repoRoot: repo(),
    projectsDir: projects([["old", "2026-07-01T00:00:00Z"], ["new", "2026-08-02T00:00:00Z"]]),
    since: "2026-08-01T00:00:00Z",
    cap: 100,
  });
  assert.deepEqual(m.sessions.map((s) => s.id), ["new"]);
});

test("archives are enumerated by their dated directory prefix", () => {
  const root = repo();
  const arch = join(root, ".devcycle", "archive-2026-08-02-fix-thing");
  mkdirSync(join(arch, "evidence"), { recursive: true });
  writeFileSync(join(arch, "ledger.md"), "# ledger\n");
  writeFileSync(join(arch, "evidence", "1-before.txt"), "x\n");
  const m = planCorpus({ repoRoot: root, projectsDir: projects([]), since: null, cap: 100 });
  assert.equal(m.archives.length, 1);
  assert.equal(m.archives[0].date, "2026-08-02");
  assert.equal(m.archives[0].evidenceCount, 1);
});

test("artifact freshness is true only for an artifact covering the current range", () => {
  const root = repo();
  mkdirSync(join(root, ".devcycle", "dreaming"), { recursive: true });
  assert.equal(artifactFresh(root, "2026-08-01T00:00:00Z").fresh, false);
  writeFileSync(join(root, ".devcycle", "dreaming", "2026-08-03-dream.md"), "# dream\n");
  assert.equal(artifactFresh(root, "2026-08-01T00:00:00Z").fresh, true);
  assert.equal(artifactFresh(root, "2026-08-04T00:00:00Z").fresh, false);
});

// The literal root below must not look like an absolute home directory:
// scripts/redaction-check.mjs fails any tracked file containing one, and this test file
// is tracked.
test("memoryDir follows the escaped-cwd rule, not basename", () => {
  const m = planCorpus({
    repoRoot: "/srv/code/Programming/thing",
    projectsDir: projects([]),
    since: null,
    cap: 100,
  });
  assert.match(m.memoryDir, /-srv-code-Programming-thing\/memory$/);
});

test("the manifest leaks no message text", () => {
  const dir = mkdtempSync(join(tmpdir(), "dream-secret-"));
  const slug = join(dir, "-some-project");
  mkdirSync(slug, { recursive: true });
  writeFileSync(
    join(slug, "s1.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-02T00:00:00Z",
      type: "assistant",
      message: { content: [{ type: "text", text: "SUPERSECRETPAYLOAD" }] },
    }) + "\n",
  );
  const m = planCorpus({ repoRoot: repo(), projectsDir: dir, since: null, cap: 100 });
  assert.equal(JSON.stringify(m).includes("SUPERSECRETPAYLOAD"), false);
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
});

test("two promotions on one day get distinct filenames", () => {
  const root = repo();
  recordPromotion(root, REC);
  recordPromotion(root, { ...REC, title: "Something else entirely" });
  assert.equal(readPromotions(root).length, 2);
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
