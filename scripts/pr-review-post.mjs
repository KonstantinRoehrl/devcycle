#!/usr/bin/env node
// Write-side data plane for the reconcile flow: the ONLY surface that mutates PR state. Posts
// threaded / PR-level replies (always footer-stamped) and resolves review threads via the
// resolveReviewThread GraphQL mutation. gh is wrapped like pr-review-intake.mjs's defaultGhRunner:
// short timeout, and a throw propagates so the caller degrades with a named reason. This file is
// the deliberate write-side counterpart to the read-only pr-review-intake.mjs.
//
// Verified gh shapes (confirm once via the opt-in manual smoke, then trust):
//   reply (primary):  gh api repos/<o>/<n>/pulls/<pr>/comments/<id>/replies -f body=<text>
//   reply (fallback): gh api repos/<o>/<n>/pulls/<pr>/comments -f in_reply_to=<id> -f body=<text>
//   pr-level:         gh pr comment <pr> --repo <o>/<n> --body-file <tmp>   (footer already applied)
//   resolve:          gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<threadId>
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFlags, requireValue } from "./cli-flags.mjs";

export const FOOTER_MARKER = "🤖 Posted by Claude Code on behalf of";

export function footer(login) {
  return `\n\n---\n${FOOTER_MARKER} @${login}`;
}

export function withFooter(body, login) {
  return String(body ?? "").replace(/\s*$/, "") + footer(login);
}

export function alreadyPosted(existingReplies, commentId) {
  return (existingReplies ?? []).some(
    (r) => r?.in_reply_to_id === commentId && String(r?.body ?? "").includes(FOOTER_MARKER)
  );
}

// Audit-only hash (djb2, base36). Correctness of idempotency rests on alreadyPosted() against
// GitHub, never on this hash — a reworded re-draft hashes differently by design.
function hash(str) {
  let h = 5381;
  const s = String(str ?? "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export const defaultPostRunner = (exec = execFileSync) => {
  const api = (args) => exec("gh", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return {
    listReplies: (repo, pr) =>
      JSON.parse(api(["api", `repos/${repo}/pulls/${pr}/comments`, "--paginate"]) || "[]"),
    postReply: (repo, pr, commentId, body) => {
      try {
        api(["api", `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`, "-f", `body=${body}`]);
      } catch {
        api(["api", `repos/${repo}/pulls/${pr}/comments`, "-f", `in_reply_to=${commentId}`, "-f", `body=${body}`]);
      }
    },
    postPrLevel: (repo, pr, body) => {
      const dir = mkdtempSync(join(tmpdir(), "prpost-"));
      const f = join(dir, "body.md");
      writeFileSync(f, body);
      api(["pr", "comment", String(pr), "--repo", repo, "--body-file", f]);
    },
    resolveThread: (threadId) =>
      api(["api", "graphql", "-f",
        "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
        "-F", `id=${threadId}`]),
  };
};

export function runReply({ repo, pr, commentId, body, login, prLevel = false, runner = defaultPostRunner() }) {
  if (!login) throw new Error("refusing to post: no --login (gh api user returned no login)");
  const id = Number(commentId);
  if (!prLevel) {
    const existing = runner.listReplies(repo, pr);
    if (alreadyPosted(existing, id)) return { status: "skipped", reason: "already-posted" };
  }
  const stamped = withFooter(body, login);
  if (prLevel) runner.postPrLevel(repo, pr, stamped);
  else runner.postReply(repo, pr, id, stamped);
  return { status: "posted", replyHash: hash(stamped) };
}

export function runResolve({ repo, threadId, runner = defaultPostRunner() }) {
  runner.resolveThread(threadId);
  return { status: "resolved" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [sub, ...rest] = process.argv.slice(2);
    const { flags } = parseFlags(rest, {
      "--repo": "value", "--pr": "value", "--comment-id": "value",
      "--body-file": "value", "--login": "value", "--pr-level": "none", "--thread-id": "value",
    });
    // requireValue returns undefined for an absent flag (only empty values throw), so guard each
    // required flag explicitly — an absent one must fail here, not propagate as NaN / an ENOENT.
    const must = (name, noun) => {
      const v = requireValue(flags, name, noun);
      if (v === undefined) throw new Error(`${name} is required (${noun})`);
      return v;
    };
    const repo = must("--repo", "an owner/name");
    if (sub === "reply") {
      const prLevel = "--pr-level" in flags;
      const body = readFileSync(must("--body-file", "a draft path"), "utf8");
      // --comment-id anchors an inline reply, so it is required only off the pr-level path; a
      // pr-level reply has no anchor and runReply ignores commentId there.
      const r = runReply({
        repo, pr: Number(must("--pr", "a number")),
        commentId: prLevel ? undefined : must("--comment-id", "a comment id"), body,
        login: must("--login", "a github login"),
        prLevel,
      });
      console.log(r.status === "posted" ? `posted ${r.replyHash}` : `skipped: ${r.reason}`);
    } else if (sub === "resolve") {
      runResolve({ repo, threadId: must("--thread-id", "a PRRT_ node id") });
      console.log("resolved");
    } else {
      throw new Error("usage: pr-review-post.mjs <reply|resolve> [flags]");
    }
  } catch (e) {
    console.error(`pr-review-post: ${e.message}`);
    process.exit(1);
  }
}
