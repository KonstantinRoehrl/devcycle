import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import {
  FOOTER_MARKER, footer, withFooter, alreadyPosted, runReply, runResolve, runReview,
  parkProblems, toSnapshot, compareRestored, runRestorePending, SNAPSHOT_DIR,
} from "../../scripts/pr-review-post.mjs";
import { makeRepo, makeFakeBin } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/pr-review-post.mjs", import.meta.url));

// Spawn the real CLI dispatch path with a fake `gh` on PATH so no network is touched — by default
// the fake exits 0 and prints `[]` (a valid empty listReplies payload); a test that needs other gh
// output passes its own shell body. This exercises the argument gate exactly as an operator would,
// which is the surface the unit tests calling runReply directly miss.
function runCli(args, ghScript = "echo '[]'") {
  const ghDir = makeTempDir("fakegh-");
  const ghPath = join(ghDir, "gh");
  writeFileSync(ghPath, `#!/bin/sh\n${ghScript}\nexit 0\n`);
  chmodSync(ghPath, 0o755);
  const bodyFile = join(makeTempDir("prbody-"), "body.md");
  writeFileSync(bodyFile, "Fixed in abc123: intake now carries thread_id.");
  const commentsFile = join(makeTempDir("prcomments-"), "comments.json");
  writeFileSync(commentsFile, "[]");
  return spawnSync(process.execPath, [SCRIPT, ...args.map((a) => {
    if (a === "@body") return bodyFile;
    if (a === "@comments") return commentsFile;
    return a;
  })], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` },
  });
}

test("footer/withFooter carry the marker and login", () => {
  assert.ok(footer("octocat").includes(FOOTER_MARKER));
  assert.ok(footer("octocat").trimEnd().endsWith("@octocat"));
  const b = withFooter("Fixed in abc123: intake now carries thread_id.", "octocat");
  assert.ok(b.includes(FOOTER_MARKER));
  assert.ok(b.startsWith("Fixed in abc123"));
});

test("alreadyPosted matches an identical stamped body on the same comment only", () => {
  const stamped = withFooter("done", "x");
  const replies = [{ in_reply_to_id: 5, body: stamped }];
  assert.equal(alreadyPosted(replies, 5, stamped), true);
  assert.equal(alreadyPosted(replies, 5, withFooter("a different reply", "x")), false);
  assert.equal(alreadyPosted(replies, 6, stamped), false);
  assert.equal(alreadyPosted([{ in_reply_to_id: 5, body: "plain human reply" }], 5, "plain human reply"), false);
});

test("runReply refuses when the derived login is empty", () => {
  assert.throws(
    () => runReply({ repo: "o/n", pr: 7, commentId: 5, body: "x", runner: { whoami: () => "" } }),
    /refusing to post/);
});

test("the posting login is derived, not taken from the caller", () => {
  const bodies = [];
  const runner = {
    listReplies: () => [],
    postReply: (repo, pr, commentId, body) => bodies.push(body),
    whoami: () => "real-account",
  };
  runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", runner });
  assert.match(bodies[0], /@real-account/);
});

test("a --login that disagrees with the derived login aborts", () => {
  const runner = {
    listReplies: () => [],
    postReply: () => { throw new Error("must not post"); },
    whoami: () => "real-account",
  };
  assert.throws(
    () => runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "someone-else", runner }),
    /someone-else[\s\S]*real-account|real-account[\s\S]*someone-else/
  );
});

test("a --login that agrees is accepted", () => {
  const runner = {
    listReplies: () => [],
    postReply: () => {},
    whoami: () => "real-account",
  };
  assert.doesNotThrow(() =>
    runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "real-account", runner })
  );
});

test("runReply posts a footer-stamped body to the replies endpoint", () => {
  const calls = [];
  const runner = {
    listReplies: () => [],
    postReply: (repo, pr, commentId, body) => calls.push(["postReply", repo, pr, commentId, body]),
    whoami: () => "octocat",
  };
  const r = runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "octocat", runner });
  assert.equal(r.status, "posted");
  assert.ok(typeof r.replyHash === "string" && r.replyHash.length > 0);
  assert.equal(calls[0][0], "postReply");
  assert.deepEqual(calls[0].slice(1, 4), ["o/n", 7, 5]);
  assert.ok(calls[0][4].includes(FOOTER_MARKER));
});

test("runReply posts a different reply to a thread that already carries a stamped reply", () => {
  const posted = [];
  const runner = {
    listReplies: () => [{ in_reply_to_id: 5, body: withFooter("Looking into it.", "octocat") }],
    postReply: (repo, pr, commentId, body) => posted.push(body),
    whoami: () => "octocat",
  };
  const r = runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "octocat", runner });
  assert.equal(r.status, "posted");
  assert.equal(posted.length, 1);
  assert.ok(posted[0].startsWith("Fixed in abc."));
});

test("runReply skips an identical stamped reply that differs only in whitespace", () => {
  const runner = {
    listReplies: () => [{ in_reply_to_id: 5, body: `Fixed  in\r\nabc.\n\n---\n${FOOTER_MARKER} @octocat\n` }],
    postReply: () => { throw new Error("must not post"); },
    whoami: () => "octocat",
  };
  const r = runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "octocat", runner });
  assert.deepEqual(r, { status: "skipped", reason: "identical-reply-posted" });
});

test("runResolve issues the resolveReviewThread mutation for the node id", () => {
  const calls = [];
  const runner = { resolveThread: (id) => calls.push(id) };
  const r = runResolve({ repo: "o/n", threadId: "PRRT_z", runner });
  assert.equal(r.status, "resolved");
  assert.deepEqual(calls, ["PRRT_z"]);
});

test("CLI reply --pr-level posts without a --comment-id", () => {
  const res = runCli([
    "reply", "--repo", "o/n", "--pr", "7", "--body-file", "@body", "--pr-level",
  ]);
  assert.doesNotMatch(res.stderr ?? "", /--comment-id is required/, res.stderr);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^posted /);
});

test("CLI reply reports a skipped identical reply in words, not as a hash", () => {
  const stored = JSON.stringify([
    { in_reply_to_id: 5, body: withFooter("Fixed in abc123: intake now carries thread_id.", "octocat") },
  ]);
  const ghScript = `if [ "$2" = user ]; then echo octocat; else cat <<'JSON'\n${stored}\nJSON\nfi`;
  const res = runCli([
    "reply", "--repo", "o/n", "--pr", "7", "--comment-id", "5", "--body-file", "@body",
  ], ghScript);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "skipped: identical reply already posted\n");
});

test("CLI reply without --pr-level still requires --comment-id", () => {
  const res = runCli([
    "reply", "--repo", "o/n", "--pr", "7", "--body-file", "@body", "--login", "octocat",
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--comment-id is required/);
});

test("defaultPostRunner builds the documented argv shapes", async () => {
  const { defaultPostRunner } = await import("../../scripts/pr-review-post.mjs");
  const seen = [];
  const exec = (_bin, args) => { seen.push(args); return "[]"; };
  const runner = defaultPostRunner(exec);
  runner.postReply("o/n", 7, 5, "body");
  runner.resolveThread("PRRT_z");
  assert.ok(seen[0].join(" ").includes("repos/o/n/pulls/7/comments/5/replies"));
  assert.ok(seen[0].join(" ").includes("-f"));
  assert.ok(seen[1].join(" ").includes("resolveReviewThread"));
  assert.ok(seen[1].join(" ").includes("PRRT_z"));
});

test("runReview refuses when the derived login is empty", () => {
  assert.throws(() => runReview({
    repo: "o/n", pr: 7, commitId: "abc", event: "COMMENT", body: "x", comments: [],
    runner: { whoami: () => "" },
  }), /refusing to post/);
});

test("runReview posts a fresh batched review when no pending review exists", () => {
  const calls = [];
  const runner = {
    findPendingReview: () => null,
    createReview: (repo, pr, payload) => calls.push(["createReview", repo, pr, payload]),
    whoami: () => "octocat",
  };
  const comments = [
    { path: "a.js", line: 3, side: "RIGHT", body: "fix this" },
    { path: "b.js", line: 9, side: "RIGHT", body: "and this" },
  ];
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc123", event: "COMMENT", body: "Summary.",
    comments, login: "octocat", runner,
  });
  assert.equal(r.status, "submitted");
  assert.equal(r.commentCount, 2);
  assert.equal(calls.length, 1);
  const [, repo, pr, payload] = calls[0];
  assert.equal(repo, "o/n");
  assert.equal(pr, 7);
  assert.equal(payload.commit_id, "abc123");
  assert.equal(payload.event, "COMMENT");
  assert.ok(payload.body.includes(FOOTER_MARKER));
  assert.equal(payload.comments.length, 2);
  for (const c of payload.comments) assert.ok(c.body.includes(FOOTER_MARKER));
});

test("runReview reports a pending review without --merge-into and writes nothing", () => {
  const runner = {
    findPendingReview: () => "PRR_z",
    createReview: () => { throw new Error("must not create"); },
    addReviewThread: () => { throw new Error("must not add"); },
    whoami: () => "octocat",
  };
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc123", event: "COMMENT", body: "Summary.",
    comments: [], login: "octocat", runner,
  });
  assert.deepEqual(r, { status: "pending-review-exists", pendingReviewId: "PRR_z" });
});

test("runReview merges into a pending review when --merge-into is given", () => {
  const addCalls = [];
  const submitCalls = [];
  const runner = {
    findPendingReview: () => "PRR_z",
    addReviewThread: (reviewId, c) => addCalls.push([reviewId, c]),
    submitReview: (reviewId, event, body) => submitCalls.push([reviewId, event, body]),
    whoami: () => "octocat",
  };
  const comments = [
    { path: "a.js", line: 3, side: "RIGHT", body: "fix this" },
    { path: "b.js", line: 9, side: "RIGHT", body: "and this" },
  ];
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc123", event: "COMMENT", body: "Summary.",
    comments, login: "octocat", mergeInto: "PRR_z", runner,
  });
  assert.deepEqual(r, { status: "submitted", merged: true, commentCount: 2 });
  assert.equal(addCalls.length, 2);
  for (const [reviewId, c] of addCalls) {
    assert.equal(reviewId, "PRR_z");
    assert.ok(c.body.includes(FOOTER_MARKER));
  }
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls[0].slice(0, 2), ["PRR_z", "COMMENT"]);
  assert.ok(submitCalls[0][2].includes(FOOTER_MARKER));
});

test("runReview refuses a self-PR verdict for a non-COMMENT event", () => {
  const runner = {
    getPrAuthor: () => "octocat",
    findPendingReview: () => { throw new Error("must not be consulted"); },
    whoami: () => "octocat",
  };
  assert.throws(() => runReview({
    repo: "o/n", pr: 7, commitId: "abc123", event: "REQUEST_CHANGES", body: "Summary.",
    comments: [], login: "octocat", runner,
  }), /refusing to REQUEST_CHANGES your own PR \(author @octocat\)/);
});

test("runReview allows a self-PR COMMENT and reaches the fresh path", () => {
  const calls = [];
  const runner = {
    getPrAuthor: () => "octocat",
    findPendingReview: () => null,
    createReview: (repo, pr, payload) => calls.push(["createReview", repo, pr, payload]),
    whoami: () => "octocat",
  };
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc123", event: "COMMENT", body: "Summary.",
    comments: [], login: "octocat", runner,
  });
  assert.equal(r.status, "submitted");
  assert.equal(calls.length, 1);
});

test("CLI review posts a batched review and reports the comment count", () => {
  const res = runCli([
    "review", "--repo", "o/n", "--pr", "7", "--commit-id", "abc", "--event", "COMMENT",
    "--body-file", "@body", "--comments-file", "@comments",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^reviewed /);
});

test("runReply (pr-level) skips when an identical-marker top-level comment already exists", () => {
  const runner = {
    listPrLevelComments: () => [{ body: withFooter("Fixed in abc.", "octocat") }],
    postPrLevel: () => { throw new Error("must not post"); },
    whoami: () => "octocat",
  };
  const r = runReply({ repo: "o/n", pr: 7, body: "Fixed in abc.", login: "octocat", prLevel: true, runner });
  assert.deepEqual(r, { status: "skipped", reason: "identical-reply-posted" });
});

test("runReply (pr-level) posts when no matching top-level comment exists", () => {
  const calls = [];
  const runner = {
    listPrLevelComments: () => [],
    postPrLevel: (repo, pr, body) => calls.push(["postPrLevel", repo, pr, body]),
    whoami: () => "octocat",
  };
  const r = runReply({ repo: "o/n", pr: 7, body: "Fixed in abc.", login: "octocat", prLevel: true, runner });
  assert.equal(r.status, "posted");
  assert.equal(calls.length, 1);
  assert.ok(calls[0][3].includes(FOOTER_MARKER));
});

test("runReply's replyHash is the shared djb2(normalizeBody(...)) hash from pr-review-intake.mjs", async () => {
  const { djb2, normalizeBody } = await import("../../scripts/pr-review-intake.mjs");
  const runner = { listReplies: () => [], postReply: () => {}, whoami: () => "octocat" };
  const r = runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "octocat", runner });
  assert.equal(r.replyHash, djb2(normalizeBody(withFooter("Fixed in abc.", "octocat"))));
});

test("defaultPostRunner.listPrLevelComments hits the issue-comments endpoint with --paginate", async () => {
  const { defaultPostRunner } = await import("../../scripts/pr-review-post.mjs");
  const seen = [];
  const exec = (_bin, args) => { seen.push(args); return "[]"; };
  const runner = defaultPostRunner(exec);
  runner.listPrLevelComments("o/n", 7);
  assert.ok(seen[0].join(" ").includes("repos/o/n/issues/7/comments"));
  assert.ok(seen[0].includes("--paginate"));
});

test("defaultPostRunner.postPrLevel removes its temp dir after posting", async () => {
  const { defaultPostRunner } = await import("../../scripts/pr-review-post.mjs");
  let capturedDir;
  const exec = (_bin, args) => {
    const i = args.indexOf("--body-file");
    if (i !== -1) capturedDir = dirname(args[i + 1]);
    return "";
  };
  const runner = defaultPostRunner(exec);
  runner.postPrLevel("o/n", 7, "hello");
  assert.ok(capturedDir, "expected --body-file to be captured");
  assert.equal(existsSync(capturedDir), false);
});

test("defaultPostRunner.createReview removes its temp dir after posting", async () => {
  const { defaultPostRunner } = await import("../../scripts/pr-review-post.mjs");
  let capturedDir;
  const exec = (_bin, args) => {
    const i = args.indexOf("--input");
    if (i !== -1) capturedDir = dirname(args[i + 1]);
    return "";
  };
  const runner = defaultPostRunner(exec);
  runner.createReview("o/n", 7, { commit_id: "abc", event: "COMMENT", body: "hi", comments: [] });
  assert.ok(capturedDir, "expected --input to be captured");
  assert.equal(existsSync(capturedDir), false);
});

test("runReview's returned commentCount does not throw when comments is nullish (createReview path)", () => {
  const runner = {
    findPendingReview: () => null,
    createReview: () => {},
    whoami: () => "octocat",
  };
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc", event: "COMMENT", body: "Summary.",
    login: "octocat", runner,
  });
  assert.equal(r.status, "submitted");
  assert.equal(r.commentCount, 0);
});

test("runReview's returned commentCount does not throw when comments is nullish (merge-into path)", () => {
  const runner = {
    findPendingReview: () => "PRR_z",
    addReviewThread: () => {},
    submitReview: () => {},
    whoami: () => "octocat",
  };
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc", event: "COMMENT", body: "Summary.",
    login: "octocat", mergeInto: "PRR_z", runner,
  });
  assert.deepEqual(r, { status: "submitted", merged: true, commentCount: 0 });
});

// --- park and restore-pending -------------------------------------------------------------------

// A normalized pending review as readPendingReview returns it: a line comment and a file comment,
// both lone top-level comments of `id` on the review's commit.
function draftReview(id = "PRR_z") {
  const own = (body) => ({ body, reviewId: id, isReply: false, originalCommitOid: "c0ffee" });
  return {
    reviewId: id, pullRequestId: "PR_1", body: "My draft summary.", commitOid: "c0ffee",
    commentCount: 2, threadsTruncated: false,
    threads: [
      { path: "a.js", line: 3, startLine: 1, side: "RIGHT", startSide: "RIGHT", subjectType: "LINE",
        comments: [own("Rename this.")] },
      { path: "docs/b.md", line: null, startLine: null, side: "RIGHT", startSide: null, subjectType: "FILE",
        comments: [own("@team 123")] },
    ],
  };
}

// A temp git repo that ignores .devcycle/, so park may write its snapshot there.
function ignoringRepo() {
  const dir = makeRepo();
  writeFileSync(join(dir, ".gitignore"), ".devcycle/\n");
  return dir;
}

const snapshotsIn = (repoDir) => {
  const dir = join(repoDir, SNAPSHOT_DIR);
  return existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)) : [];
};

// Records every runner call by name. The original review reads back as `review`; the restored one
// (any other id) as `restored(id)`. `fail` names the calls that throw.
function parkRunner({ review = draftReview(), restored = draftReview, fail = [], pending = "PRR_z" } = {}) {
  const calls = [];
  const call = (name, fn) => (...args) => {
    calls.push(name);
    if (fail.includes(name)) throw new Error(`${name} exploded`);
    return fn(...args);
  };
  return {
    calls,
    whoami: () => "octocat",
    findPendingReview: call("findPendingReview", () => pending),
    readPendingReview: call("readPendingReview", (_repo, _pr, id) => (id === review.reviewId ? review : restored(id))),
    deletePendingReview: call("deletePendingReview", () => {}),
    createReview: call("createReview", () => {}),
    createPendingReview: call("createPendingReview", () => "PRR_new"),
    addPendingThread: call("addPendingThread", () => {}),
    addReviewThread: call("addReviewThread", () => {}),
    submitReview: call("submitReview", () => {}),
  };
}

const WRITES = ["deletePendingReview", "createReview", "createPendingReview", "addPendingThread",
  "addReviewThread", "submitReview"];

const parkArgs = (runner, cwd, extra = {}) => ({
  repo: "o/n", pr: 7, commitId: "abc123", event: "COMMENT", body: "Summary.",
  comments: [{ path: "a.js", line: 3, side: "RIGHT", body: "fix this" }],
  login: "octocat", park: "PRR_z", cwd, runner, ...extra,
});

test("parkProblems passes a review of lone top-level comments on its own commit", () => {
  assert.deepEqual(parkProblems(draftReview()), []);
  assert.deepEqual(parkProblems({ ...draftReview(), threads: [], commentCount: 0 }), []);
});

test("parkProblems names every shape the restore cannot recreate", () => {
  const r = draftReview();
  const [line, file] = r.threads;
  const reply = { ...line.comments[0], isReply: true };
  const foreign = { body: "theirs", reviewId: "PRR_other", isReply: false, originalCommitOid: "c0ffee" };
  const cases = [
    [{ threads: [{ ...line, comments: [reply] }, file] }, /a reply inside an existing thread on a\.js/],
    [{ threads: [{ ...line, comments: [foreign, line.comments[0]] }, file] }, /another review's comments/],
    [{ threads: [{ ...line, comments: [line.comments[0], line.comments[0]] }, file], commentCount: 3 },
      /2 comments of this review in one thread on a\.js/],
    [{ threads: [{ ...line, comments: [{ ...line.comments[0], originalCommitOid: "deadbe" }] }, file] },
      /different commit/],
    [{ threads: [{ ...line, line: null }, file] }, /a line comment on a\.js with no line/],
    [{ threadsTruncated: true }, /more review threads/],
    [{ commentCount: 3 }, /holds 3 comment\(s\) but 2 could be read/],
  ];
  for (const [patch, reason] of cases) assert.match(parkProblems({ ...r, ...patch }).join("\n"), reason);
});

test("compareRestored accepts a faithful restore and ignores whitespace-only body changes", () => {
  const snapshot = toSnapshot(draftReview(), { repo: "o/n", pr: 7 });
  const restored = draftReview("PRR_new");
  restored.threads[0].comments[0].body = "  Rename   this.\n";
  assert.deepEqual(compareRestored(snapshot, restored), []);
});

test("compareRestored names a count mismatch, then body, path and line mismatches in order", () => {
  const snapshot = toSnapshot(draftReview(), { repo: "o/n", pr: 7 });
  const short = { ...draftReview("PRR_new"), commentCount: 1 };
  short.threads = short.threads.slice(0, 1);
  assert.match(compareRestored(snapshot, short)[0], /restored 1 comment\(s\).*holds 2/);
  const moved = draftReview("PRR_new");
  moved.threads[0] = { ...moved.threads[0], line: 4, comments: [{ ...moved.threads[0].comments[0], body: "Other." }] };
  assert.deepEqual(compareRestored(snapshot, moved), [
    "comment 1 (a.js): body differs",
    "comment 1 (a.js): restored on line 4, expected 3",
  ]);
});

test("park snapshots, deletes, posts, restores and compares in that order, then removes the snapshot", () => {
  const cwd = ignoringRepo();
  const runner = parkRunner();
  const added = [];
  runner.addPendingThread = (id, c) => { runner.calls.push("addPendingThread"); added.push([id, c]); };
  const r = runReview(parkArgs(runner, cwd));
  assert.deepEqual(r, { status: "submitted", parked: true, commentCount: 1 });
  assert.deepEqual(runner.calls, [
    "findPendingReview", "readPendingReview", "deletePendingReview", "createReview",
    "createPendingReview", "addPendingThread", "addPendingThread", "readPendingReview",
  ]);
  assert.deepEqual(added.map(([id, c]) => [id, c.path, c.line, c.startLine, c.subjectType]), [
    ["PRR_new", "a.js", 3, 1, "LINE"],
    ["PRR_new", "docs/b.md", null, null, "FILE"],
  ]);
  assert.deepEqual(snapshotsIn(cwd), []);
});

test("park with an id other than the found pending review is refused with no writes", () => {
  for (const pending of ["PRR_other", null]) {
    const cwd = ignoringRepo();
    const runner = parkRunner({ pending });
    assert.throws(() => runReview(parkArgs(runner, cwd)), /refusing to park PRR_z/);
    assert.deepEqual(runner.calls, ["findPendingReview"]);
    assert.deepEqual(snapshotsIn(cwd), []);
  }
});

test("park with --merge-into is refused before any runner call", () => {
  const runner = parkRunner();
  runner.whoami = () => { throw new Error("must not be called"); };
  assert.throws(() => runReview(parkArgs(runner, ignoringRepo(), { mergeInto: "PRR_z" })), /mutually exclusive/);
  assert.deepEqual(runner.calls, []);
});

test("park is refused with no writes where .devcycle/ is not ignored", () => {
  const cwd = makeRepo();
  const runner = parkRunner();
  assert.throws(() => runReview(parkArgs(runner, cwd)), /add \.devcycle\/ to \.gitignore/);
  assert.equal(runner.calls.some((c) => WRITES.includes(c) || c === "readPendingReview"), false);
  assert.equal(existsSync(join(cwd, ".devcycle")), false);
});

test("park is refused while a kept snapshot for the same PR exists", () => {
  const cwd = ignoringRepo();
  mkdirSync(join(cwd, SNAPSHOT_DIR), { recursive: true });
  const kept = join(cwd, SNAPSHOT_DIR, "PRR_old-1.json");
  writeFileSync(kept, JSON.stringify(toSnapshot(draftReview("PRR_old"), { repo: "o/n", pr: 7 })));
  const runner = parkRunner();
  assert.throws(() => runReview(parkArgs(runner, cwd)), /a kept snapshot for o\/n#7 exists/);
  assert.equal(runner.calls.some((c) => WRITES.includes(c)), false);
  assert.deepEqual(snapshotsIn(cwd), [kept]);
});

test("park refuses an unrestorable comment shape before deleting anything", () => {
  const cwd = ignoringRepo();
  const review = draftReview();
  review.threads[0].comments[0].isReply = true;
  const runner = parkRunner({ review });
  assert.throws(() => runReview(parkArgs(runner, cwd)), /refusing to park PRR_z[\s\S]*a reply inside an existing thread/);
  assert.deepEqual(runner.calls, ["findPendingReview", "readPendingReview"]);
  assert.deepEqual(snapshotsIn(cwd), []);
});

test("a failed post still restores the draft, keeps the snapshot and names it", () => {
  const cwd = ignoringRepo();
  const runner = parkRunner({ fail: ["createReview"] });
  let message;
  assert.throws(() => runReview(parkArgs(runner, cwd)), (e) => { message = e.message; return true; });
  assert.ok(runner.calls.includes("createPendingReview"), "step 5 must run after a failed step 4");
  const [kept] = snapshotsIn(cwd);
  assert.ok(kept, "the snapshot must be kept");
  assert.match(message, /step 4 \(post the agent's review\): createReview exploded/);
  assert.match(message, /restored as pending and verified/);
  assert.ok(message.includes(kept));
});

test("a failed restore keeps the snapshot and names it with the replay command", () => {
  const cwd = ignoringRepo();
  const runner = parkRunner({ fail: ["createPendingReview"] });
  let message;
  assert.throws(() => runReview(parkArgs(runner, cwd)), (e) => { message = e.message; return true; });
  const [kept] = snapshotsIn(cwd);
  assert.ok(kept, "the snapshot must be kept");
  assert.match(message, /step 5 \(restore your draft\)/);
  assert.match(message, /NOT restored/);
  assert.ok(message.includes(`restore-pending --repo o/n --pr 7 --snapshot "${kept}"`));
  assert.doesNotMatch(message, /delete it on GitHub/);
});

test("a restore that fails the compare says to delete the partial pending review before replaying", () => {
  const cwd = ignoringRepo();
  const runner = parkRunner({ restored: (id) => ({ ...draftReview(id), commentCount: 1, threads: [] }) });
  assert.throws(() => runReview(parkArgs(runner, cwd)),
    /step 6 \(compare the restored draft\)[\s\S]*Pending review PRR_new was created but does not match the snapshot: delete it on GitHub first/);
  assert.equal(snapshotsIn(cwd).length, 1);
});

// A re-read that hit GitHub's one-page thread limit: only the first thread of the restored review
// comes back, though the review itself reports both comments.
const truncatedRead = (id) => {
  const full = draftReview(id);
  return { ...full, threadsTruncated: true, threads: full.threads.slice(0, 1) };
};

function assertUnverified(message, { snapshot, reviewId }) {
  assert.match(message, new RegExp(`pending review ${reviewId} was created`, "i"));
  assert.match(message, /could not be verified[\s\S]*more than one page of review threads/);
  assert.match(message, new RegExp(`check pending review ${reviewId} on GitHub`, "i"));
  assert.ok(message.includes(snapshot), "the snapshot path must be named");
  assert.doesNotMatch(message, /NOT restored/);
  assert.doesNotMatch(message, /delete/i);
}

test("a park whose re-read is truncated and short keeps the snapshot and does not say the draft was lost", () => {
  const cwd = ignoringRepo();
  const runner = parkRunner({ restored: truncatedRead });
  let message;
  assert.throws(() => runReview(parkArgs(runner, cwd)), (e) => { message = e.message; return true; });
  const [kept] = snapshotsIn(cwd);
  assert.ok(kept, "the snapshot must be kept");
  assert.match(message, /step 6 \(compare the restored draft\)/);
  assertUnverified(message, { snapshot: kept, reviewId: "PRR_new" });
});

test("a truncated re-read whose comments all match is a verified restore", () => {
  const cwd = ignoringRepo();
  const runner = parkRunner({ restored: (id) => ({ ...draftReview(id), threadsTruncated: true }) });
  assert.deepEqual(runReview(parkArgs(runner, cwd)), { status: "submitted", parked: true, commentCount: 1 });
  assert.deepEqual(snapshotsIn(cwd), []);
});

test("CLI review --park exits non-zero naming the kept snapshot when the re-read is truncated and short", () => {
  const { res, cwd } = runParkCli(["--park", "PRR_z"], { truncateRestore: true });
  assert.equal(res.status, 1);
  const [kept] = snapshotsIn(cwd);
  assert.ok(kept, "the snapshot must be kept");
  assert.ok(res.stderr.includes(kept), res.stderr);
  assert.doesNotMatch(res.stderr, /NOT restored|delete/i);
});

function keptSnapshot() {
  const dir = makeTempDir("prsnap-");
  const path = join(dir, "PRR_z-1.json");
  writeFileSync(path, JSON.stringify(toSnapshot(draftReview(), { repo: "o/n", pr: 7 })));
  return path;
}

test("restore-pending replays a snapshot and removes it on a verified compare", () => {
  const snapshotPath = keptSnapshot();
  const runner = parkRunner({ pending: null });
  const r = runRestorePending({ repo: "o/n", pr: 7, snapshotPath, runner });
  assert.deepEqual(r, { status: "restored", commentCount: 2 });
  assert.deepEqual(runner.calls, [
    "findPendingReview", "createPendingReview", "addPendingThread", "addPendingThread", "readPendingReview",
  ]);
  assert.equal(existsSync(snapshotPath), false);
});

test("restore-pending refuses while a pending review exists", () => {
  const snapshotPath = keptSnapshot();
  const runner = parkRunner({ pending: "PRR_y" });
  assert.throws(() => runRestorePending({ repo: "o/n", pr: 7, snapshotPath, runner }), /already have pending review PRR_y/);
  assert.deepEqual(runner.calls, ["findPendingReview"]);
  assert.equal(existsSync(snapshotPath), true);
});

test("restore-pending keeps the snapshot on a failed compare", () => {
  const snapshotPath = keptSnapshot();
  const runner = parkRunner({ pending: null, restored: (id) => ({ ...draftReview(id), body: "x", commentCount: 0, threads: [] }) });
  assert.throws(() => runRestorePending({ repo: "o/n", pr: 7, snapshotPath, runner }), /step 6[\s\S]*PRR_new/);
  assert.equal(existsSync(snapshotPath), true);
});

test("restore-pending keeps the snapshot and does not say the draft was lost when the re-read is truncated and short", () => {
  const snapshotPath = keptSnapshot();
  const runner = parkRunner({ pending: null, restored: truncatedRead });
  let message;
  assert.throws(() => runRestorePending({ repo: "o/n", pr: 7, snapshotPath, runner }), (e) => { message = e.message; return true; });
  assert.equal(existsSync(snapshotPath), true);
  assertUnverified(message, { snapshot: snapshotPath, reviewId: "PRR_new" });
});

test("restore-pending removes the snapshot when a truncated re-read still matches in full", () => {
  const snapshotPath = keptSnapshot();
  const runner = parkRunner({ pending: null, restored: (id) => ({ ...draftReview(id), threadsTruncated: true }) });
  assert.deepEqual(runRestorePending({ repo: "o/n", pr: 7, snapshotPath, runner }), { status: "restored", commentCount: 2 });
  assert.equal(existsSync(snapshotPath), false);
});

// A stateless fake gh for the CLI: one pending review PRR_z owned by octocat, read back under
// whatever id is asked for; the batched-review POST fails when FAKE_GH_FAIL_POST is set, and a read
// of any other review id returns a truncated thread page with no threads when FAKE_GH_TRUNCATE_RESTORE is.
const FAKE_GH = `
const args = process.argv.slice(2);
const query = (args.find((a) => a.startsWith("query=")) ?? "").slice(6);
const id = (args.find((a) => a.startsWith("id=")) ?? "").slice(3);
const out = (data) => process.stdout.write(JSON.stringify({ data }));
if (args[1] === "user") process.stdout.write("octocat\\n");
else if (args.includes("--input")) {
  if (process.env.FAKE_GH_FAIL_POST) { process.stderr.write("HTTP 422"); process.exit(1); }
} else if (query.includes("states:[PENDING]"))
  out({ repository: { pullRequest: { reviews: { nodes: [{ id: "PRR_z", author: { login: "octocat" } }] } } } });
else if (query.includes("reviewThreads")) {
  const truncated = Boolean(process.env.FAKE_GH_TRUNCATE_RESTORE) && id !== "PRR_z";
  out({
    repository: { pullRequest: { id: "PR_1", reviewThreads: { pageInfo: { hasNextPage: truncated }, nodes: truncated ? [] : [
      { path: "a.js", originalLine: 3, originalStartLine: null, diffSide: "RIGHT", startDiffSide: null, subjectType: "LINE",
        comments: { nodes: [{ body: "Rename this.", replyTo: null, pullRequestReview: { id }, originalCommit: { oid: "c0ffee" } }] } },
    ] } } },
    node: { id, state: "PENDING", body: "My draft.", commit: { oid: "c0ffee" }, comments: { totalCount: 1 } },
  });
} else if (query.includes("addPullRequestReview("))
  out({ addPullRequestReview: { pullRequestReview: { id: "PRR_new" } } });
else out({});
`;

function runParkCli(extraArgs, { failPost = false, truncateRestore = false } = {}) {
  const cwd = ignoringRepo();
  const ghDir = makeFakeBin("gh", FAKE_GH);
  const bodyFile = join(makeTempDir("prbody-"), "body.md");
  writeFileSync(bodyFile, "Summary.");
  const commentsFile = join(makeTempDir("prcomments-"), "comments.json");
  writeFileSync(commentsFile, "[]");
  const res = spawnSync(process.execPath, [SCRIPT, "review", "--repo", "o/n", "--pr", "7",
    "--commit-id", "abc", "--event", "COMMENT", "--body-file", bodyFile, "--comments-file", commentsFile,
    ...extraArgs], {
    cwd, encoding: "utf8",
    env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}`, ...(failPost ? { FAKE_GH_FAIL_POST: "1" } : {}),
      ...(truncateRestore ? { FAKE_GH_TRUNCATE_RESTORE: "1" } : {}) },
  });
  return { res, cwd };
}

test("CLI review names --merge-into, --park and abort when a pending review exists", () => {
  const { res } = runParkCli([]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--merge-into PRR_z[\s\S]*submit your draft[\s\S]*--park PRR_z[\s\S]*abort/);
});

test("CLI review --park reports the parked review on success", () => {
  const { res, cwd } = runParkCli(["--park", "PRR_z"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^reviewed 0 comment\(s\)\n.*parked and restored/);
  assert.deepEqual(snapshotsIn(cwd), []);
});

test("CLI review --park exits non-zero naming the kept snapshot when the post fails", () => {
  const { res, cwd } = runParkCli(["--park", "PRR_z"], { failPost: true });
  assert.equal(res.status, 1);
  const [kept] = snapshotsIn(cwd);
  assert.ok(kept, "the snapshot must be kept");
  assert.ok(res.stderr.includes(kept), res.stderr);
  assert.match(res.stderr, /step 4/);
});

test("defaultPostRunner passes park strings with -f, integers with -F, and no anchor for a file-level thread", async () => {
  const { defaultPostRunner } = await import("../../scripts/pr-review-post.mjs");
  const seen = [];
  const exec = (_bin, args) => {
    seen.push(args);
    return JSON.stringify({ data: { addPullRequestReview: { pullRequestReview: { id: "PRR_new" } } } });
  };
  const runner = defaultPostRunner(exec);
  assert.equal(runner.createPendingReview("PR_1", "c0ffee", "123"), "PRR_new");
  runner.addPendingThread("PRR_new", { path: "a.js", line: 3, side: "RIGHT", startLine: null, startSide: null, subjectType: "LINE", body: "@x" });
  runner.addPendingThread("PRR_new", { path: "b.md", line: null, side: "RIGHT", startLine: null, startSide: null, subjectType: "FILE", body: "true" });
  runner.deletePendingReview("PRR_z");
  const flagOf = (args, value) => args[args.indexOf(value) - 1];
  assert.equal(flagOf(seen[0], "body=123"), "-f");
  assert.equal(flagOf(seen[1], "body=@x"), "-f");
  assert.equal(flagOf(seen[1], "line=3"), "-F");
  assert.equal(seen[1].some((a) => a.startsWith("startLine=")), false);
  assert.equal(flagOf(seen[2], "body=true"), "-f");
  assert.equal(seen[2].some((a) => a.startsWith("line=")), false);
  assert.equal(seen[2].some((a) => a.startsWith("side=")), false, "a file-level thread sends no side");
  assert.equal(flagOf(seen[2], "subjectType=FILE"), "-f");
  assert.ok(seen[3].join(" ").includes("deletePullRequestReview"));
  assert.equal(flagOf(seen[3], "id=PRR_z"), "-f");
});

test("defaultPostRunner.readPendingReview keeps only the review's threads and maps the thread anchor", async () => {
  const { defaultPostRunner } = await import("../../scripts/pr-review-post.mjs");
  const comment = (reviewId, extra = {}) =>
    ({ body: "b", replyTo: null, pullRequestReview: { id: reviewId }, originalCommit: { oid: "c0ffee" }, ...extra });
  const payload = { data: {
    repository: { pullRequest: { id: "PR_1", reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [
      { path: "a.js", originalLine: 5, originalStartLine: 2, diffSide: "LEFT", startDiffSide: "LEFT", subjectType: "LINE",
        comments: { nodes: [comment("PRR_other"), comment("PRR_z", { replyTo: { id: "C_1" } })] } },
      { path: "c.js", originalLine: 1, originalStartLine: null, diffSide: "RIGHT", startDiffSide: null, subjectType: "LINE",
        comments: { nodes: [comment("PRR_other")] } },
    ] } } },
    node: { id: "PRR_z", state: "PENDING", body: "draft", commit: { oid: "c0ffee" }, comments: { totalCount: 1 } },
  } };
  const seen = [];
  const runner = defaultPostRunner((_bin, args) => { seen.push(args); return JSON.stringify(payload); });
  const review = runner.readPendingReview("o/n", 7, "PRR_z");
  assert.equal(flagOf(seen[0], "pr=7"), "-F");
  assert.equal(flagOf(seen[0], "id=PRR_z"), "-f");
  assert.deepEqual(review, {
    reviewId: "PRR_z", pullRequestId: "PR_1", body: "draft", commitOid: "c0ffee", commentCount: 1,
    threadsTruncated: true,
    threads: [{
      path: "a.js", line: 5, startLine: 2, side: "LEFT", startSide: "LEFT", subjectType: "LINE",
      comments: [
        { body: "b", reviewId: "PRR_other", isReply: false, originalCommitOid: "c0ffee" },
        { body: "b", reviewId: "PRR_z", isReply: true, originalCommitOid: "c0ffee" },
      ],
    }],
  });
  function flagOf(args, value) { return args[args.indexOf(value) - 1]; }
});
