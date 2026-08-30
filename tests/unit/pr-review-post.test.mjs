import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  FOOTER_MARKER, footer, withFooter, alreadyPosted, runReply, runResolve, runReview,
} from "../../scripts/pr-review-post.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/pr-review-post.mjs", import.meta.url));

// Spawn the real CLI dispatch path with a fake `gh` on PATH so no network is touched — the fake
// exits 0 and prints `[]` (a valid empty listReplies payload). This exercises the argument gate
// exactly as an operator would, which is the surface the unit tests calling runReply directly miss.
function runCli(args) {
  const ghDir = mkdtempSync(join(tmpdir(), "fakegh-"));
  const ghPath = join(ghDir, "gh");
  writeFileSync(ghPath, "#!/bin/sh\necho '[]'\nexit 0\n");
  chmodSync(ghPath, 0o755);
  const bodyFile = join(mkdtempSync(join(tmpdir(), "prbody-")), "body.md");
  writeFileSync(bodyFile, "Fixed in abc123: intake now carries thread_id.");
  const commentsFile = join(mkdtempSync(join(tmpdir(), "prcomments-")), "comments.json");
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

test("alreadyPosted matches marker on the same comment only", () => {
  const replies = [{ in_reply_to_id: 5, body: `done\n\n---\n${FOOTER_MARKER} @x` }];
  assert.equal(alreadyPosted(replies, 5), true);
  assert.equal(alreadyPosted(replies, 6), false);
  assert.equal(alreadyPosted([{ in_reply_to_id: 5, body: "plain human reply" }], 5), false);
});

test("runReply refuses an empty login", () => {
  assert.throws(() => runReply({ repo: "o/n", pr: 7, commentId: 5, body: "x", login: "", runner: {} }),
    /refusing to post/);
});

test("runReply posts a footer-stamped body to the replies endpoint", () => {
  const calls = [];
  const runner = {
    listReplies: () => [],
    postReply: (repo, pr, commentId, body) => calls.push(["postReply", repo, pr, commentId, body]),
  };
  const r = runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "octocat", runner });
  assert.equal(r.status, "posted");
  assert.ok(typeof r.replyHash === "string" && r.replyHash.length > 0);
  assert.equal(calls[0][0], "postReply");
  assert.deepEqual(calls[0].slice(1, 4), ["o/n", 7, 5]);
  assert.ok(calls[0][4].includes(FOOTER_MARKER));
});

test("runReply skips when an identical-marker reply already exists", () => {
  const runner = {
    listReplies: () => [{ in_reply_to_id: 5, body: `x\n\n---\n${FOOTER_MARKER} @octocat` }],
    postReply: () => { throw new Error("must not post"); },
  };
  const r = runReply({ repo: "o/n", pr: 7, commentId: 5, body: "Fixed in abc.", login: "octocat", runner });
  assert.deepEqual(r, { status: "skipped", reason: "already-posted" });
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
    "reply", "--repo", "o/n", "--pr", "7", "--body-file", "@body", "--login", "octocat", "--pr-level",
  ]);
  assert.doesNotMatch(res.stderr ?? "", /--comment-id is required/, res.stderr);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^posted /);
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

test("runReview refuses an empty login", () => {
  assert.throws(() => runReview({
    repo: "o/n", pr: 7, commitId: "abc", event: "COMMENT", body: "x", comments: [], login: "", runner: {},
  }), /refusing to post/);
});

test("runReview posts a fresh batched review when no pending review exists", () => {
  const calls = [];
  const runner = {
    findPendingReview: () => null,
    createReview: (repo, pr, payload) => calls.push(["createReview", repo, pr, payload]),
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
    "--body-file", "@body", "--comments-file", "@comments", "--login", "octocat",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^reviewed /);
});

test("runReply (pr-level) skips when an identical-marker top-level comment already exists", () => {
  const runner = {
    listPrLevelComments: () => [{ body: withFooter("Fixed in abc.", "octocat") }],
    postPrLevel: () => { throw new Error("must not post"); },
  };
  const r = runReply({ repo: "o/n", pr: 7, body: "Fixed in abc.", login: "octocat", prLevel: true, runner });
  assert.deepEqual(r, { status: "skipped", reason: "already-posted" });
});

test("runReply (pr-level) posts when no matching top-level comment exists", () => {
  const calls = [];
  const runner = {
    listPrLevelComments: () => [],
    postPrLevel: (repo, pr, body) => calls.push(["postPrLevel", repo, pr, body]),
  };
  const r = runReply({ repo: "o/n", pr: 7, body: "Fixed in abc.", login: "octocat", prLevel: true, runner });
  assert.equal(r.status, "posted");
  assert.equal(calls.length, 1);
  assert.ok(calls[0][3].includes(FOOTER_MARKER));
});

test("runReply's replyHash is the shared djb2(normalizeBody(...)) hash from pr-review-intake.mjs", async () => {
  const { djb2, normalizeBody } = await import("../../scripts/pr-review-intake.mjs");
  const runner = { listReplies: () => [], postReply: () => {} };
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

test("defaultPostRunner.postPrLevel removes its mkdtempSync temp dir after posting", async () => {
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

test("defaultPostRunner.createReview removes its mkdtempSync temp dir after posting", async () => {
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
  };
  const r = runReview({
    repo: "o/n", pr: 7, commitId: "abc", event: "COMMENT", body: "Summary.",
    login: "octocat", mergeInto: "PRR_z", runner,
  });
  assert.deepEqual(r, { status: "submitted", merged: true, commentCount: 0 });
});
