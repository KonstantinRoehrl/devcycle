import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  FOOTER_MARKER, footer, withFooter, alreadyPosted, runReply, runResolve,
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
  return spawnSync(process.execPath, [SCRIPT, ...args.map((a) => (a === "@body" ? bodyFile : a))], {
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
