import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeComments, wrapPaste, normalizeBody, commentKey,
  dedupeAgainst, priorKeysFrom, intake, defaultGhRunner,
} from "../../scripts/pr-review-intake.mjs";

test("normalizeComments drops resolved threads by REST comment id and keeps diff_hunk + in_reply_to", () => {
  // resolvedThreadIds carries the REST inline-comment ids of comments in GitHub-resolved threads
  // (databaseId of each resolved PullRequestReviewThread's comments) — the ids that match c.id.
  const out = normalizeComments({
    inline: [
      { id: 1, user: { login: "a" }, body: "x", path: "f.js", line: 3, diff_hunk: "@@", in_reply_to_id: null },
      { id: 2, user: { login: "b" }, body: "y", path: "g.js", line: 4, diff_hunk: "@@2", in_reply_to_id: 1 },
    ],
    resolvedThreadIds: [2],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].kind, "inline");
  assert.equal(out[0].diff_hunk, "@@");
  assert.equal(out[0].resolved, false);
});

test("intake drops a GitHub-resolved thread's comment against a realistic defaultGhRunner response", () => {
  // Realistic wiring: defaultGhRunner reads inline comments (REST) plus reviewThreads (GraphQL),
  // correlating resolution to REST ids via each resolved thread's comments' databaseId. Comment 100
  // lives in a resolved thread; comment 200 does not. Only 100 must be dropped.
  const inline = [
    { id: 100, user: { login: "bot" }, body: "resolved take", path: "a.js", line: 1, diff_hunk: "@@", in_reply_to_id: null },
    { id: 200, user: { login: "human" }, body: "open take", path: "b.js", line: 2, diff_hunk: "@@", in_reply_to_id: null },
  ];
  const graphql = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              { isResolved: true, comments: { nodes: [{ databaseId: 100 }] } },
              { isResolved: false, comments: { nodes: [{ databaseId: 200 }] } },
            ],
          },
        },
      },
    },
  };
  const exec = (_bin, args) => {
    if (args.includes("graphql")) return JSON.stringify(graphql);
    if (args.some((a) => a.endsWith("/pulls/5/comments"))) return JSON.stringify(inline);
    return "[]";
  };
  const env = intake({
    repo: "o/r", pr: 5, mode: "gh", scratchDir: ".devcycle/tmp",
    ghRunner: (repo, pr) => defaultGhRunner(repo, pr, exec),
    redactRunner: (d) => d,
  });
  assert.equal(env.available, true);
  assert.equal(env.counts.fetched, 2);
  assert.equal(env.counts.resolvedDropped, 1);
  assert.equal(env.comments.length, 1);
  assert.equal(env.comments[0].id, 200);
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
  // A gh-api reply post is POST-by-default with a `-f/-F body=` field (or --field/--raw-field);
  // that idiom carries no `-X POST`, so the checks above miss it. This is read-only intake: reject
  // any field-flagged `body=` write while still permitting the reviewThreads GraphQL read (which
  // only passes `-F owner=/name=/pr=`, never `body=`) and the three REST reads.
  assert.doesNotMatch(src, /-(?:f|F|-field|-raw-field)\s+["']?body=/);
});
