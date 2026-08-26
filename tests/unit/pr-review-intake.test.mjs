import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeComments, wrapPaste, normalizeBody, commentKey,
  dedupeAgainst, priorKeysFrom, intake, defaultGhRunner,
} from "../../scripts/pr-review-intake.mjs";

test("normalizeComments drops resolved threads and keeps diff_hunk + in_reply_to", () => {
  const out = normalizeComments({
    inline: [
      { id: 1, user: { login: "a" }, body: "x", path: "f.js", line: 3, diff_hunk: "@@", in_reply_to_id: null, pull_request_review_id: 10 },
      { id: 2, user: { login: "b" }, body: "y", path: "g.js", line: 4, diff_hunk: "@@2", in_reply_to_id: 1, pull_request_review_id: 11 },
    ],
    resolvedThreadIds: [11],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].kind, "inline");
  assert.equal(out[0].diff_hunk, "@@");
  assert.equal(out[0].resolved, false);
});

test("wrapPaste makes one pr-level entry per paragraph with author (pasted)", () => {
  const out = wrapPaste("first comment\n\nsecond comment");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.author), ["(pasted)", "(pasted)"]);
  assert.equal(out[0].id, null);
  assert.equal(out[0].kind, "pr-level");
  assert.equal(out[1].body, "second comment");
});

test("commentKey is stable under body whitespace normalization", () => {
  const a = commentKey({ path: "f.js", line: 3, body: "Use  the\twrapper" });
  const b = commentKey({ path: "f.js", line: 3, body: "Use the wrapper\n" });
  assert.equal(a, b);
  assert.notEqual(a, commentKey({ path: "f.js", line: 4, body: "Use the wrapper" }));
});

test("dedupeAgainst drops repeats and keeps fresh", () => {
  const prior = priorKeysFrom([JSON.stringify({ comments: [{ path: "f.js", line: 3, body: "same" }] })]);
  const { kept, dropped } = dedupeAgainst(
    [{ path: "f.js", line: 3, body: "same" }, { path: "f.js", line: 9, body: "new" }],
    prior,
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.equal(kept[0].line, 9);
});

test("intake degrades to {available:false, reason} when gh throws", () => {
  const throwingGh = () => { throw new Error("gh not installed"); };
  const noRedact = (dir) => dir;
  const env = intake({ repo: "o/r", pr: 5, mode: "gh", scratchDir: ".devcycle/tmp", ghRunner: throwingGh, redactRunner: noRedact });
  assert.equal(env.available, false);
  assert.match(env.reason, /gh not installed/);
  assert.deepEqual(env.comments, []);
});

test("defaultGhRunner fails closed: a single failing read throws, never fabricates an empty result", () => {
  // Three REST reads succeed with empty arrays; the graphql review-threads read fails (rate limit).
  // A fail-OPEN runner would swallow that and return a truthy { …, resolvedThreadIds: [] } that is
  // indistinguishable from a PR with no comments; fail-CLOSED must let it throw so intake degrades.
  const exec = (_bin, args) => {
    if (args.includes("graphql")) throw new Error("gh api: HTTP 429 rate limited");
    return "[]";
  };
  assert.throws(() => defaultGhRunner("o/r", 5, exec), /429/);
});

test("intake degrades to {available:false, reason} on a partial gh read failure, not just a top-level throw", () => {
  const exec = (_bin, args) => {
    if (args.includes("graphql")) throw new Error("gh api: HTTP 429 rate limited");
    return "[]";
  };
  const env = intake({
    repo: "o/r", pr: 5, mode: "gh", scratchDir: ".devcycle/tmp",
    ghRunner: (repo, pr) => defaultGhRunner(repo, pr, exec),
    redactRunner: (d) => d,
  });
  assert.equal(env.available, false);
  assert.match(env.reason, /429/);
  assert.deepEqual(env.comments, []);
});

test("the intake script never calls a mutating gh subcommand", () => {
  const src = readFileSync(new URL("../../scripts/pr-review-intake.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /-X\s+(POST|PATCH|PUT|DELETE)/);
  assert.doesNotMatch(src, /resolveReviewThread/);
  assert.doesNotMatch(src, /\bgh\b[^\n]*\b(pr|api)\b[^\n]*\b(merge|close|edit|review|comment)\b\s+--/);
});
