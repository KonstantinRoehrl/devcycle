#!/usr/bin/env node
// Write-side data plane for the reconcile flow: the ONLY surface that mutates PR state. Posts
// threaded / PR-level replies (always footer-stamped), resolves review threads via the
// resolveReviewThread GraphQL mutation, and posts batched PR reviews over already-anchored
// comments (it never calls the anchoring module), parking the user's own pending review around
// that post when asked (`--park`, `restore-pending`). gh is wrapped like pr-review-intake.mjs's
// defaultGhRunner: short timeout, and a throw propagates so the caller degrades with a named
// reason. This file is the deliberate write-side counterpart to the read-only
// pr-review-intake.mjs.
//
// Verified gh shapes (confirm once via the opt-in manual smoke, then trust):
//   reply (primary):  gh api repos/<o>/<n>/pulls/<pr>/comments/<id>/replies -f body=<text>
//   reply (fallback): gh api repos/<o>/<n>/pulls/<pr>/comments -f in_reply_to=<id> -f body=<text>
//   pr-level:         gh pr comment <pr> --repo <o>/<n> --body-file <tmp>   (footer already applied)
//   resolve:          gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<threadId>
//   author:  gh api repos/<o>/<n>/pulls/<pr> --jq .user.login
//   pending: gh api graphql -f query='query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviews(first:50,states:[PENDING]){nodes{id author{login}}}}}}' -F o=<o> -F n=<n> -F pr=<pr>
//   create:  gh api repos/<o>/<n>/pulls/<pr>/reviews --method POST --input <tmp.json>
//            tmp.json = {"commit_id":"<sha>","event":"<EVENT>","body":"<summary>","comments":[{"path":"..","line":N,"side":"RIGHT","body":".."}]}
//   merge:   gh api graphql -f query='mutation($id:ID!,$path:String!,$line:Int!,$side:DiffSide!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$id,path:$path,line:$line,side:$side,body:$body}){thread{id}}}' -F id=<PRR_> -F path=<p> -F line=<n> -F side=RIGHT -F body=<b>
//   submit:  gh api graphql -f query='mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$id,event:$event,body:$body}){pullRequestReview{state}}}' -F id=<PRR_> -F event=<EVENT> -F body=<b>
//
// Park shapes. PullRequestReviewComment has no side field, so the side comes from its thread.
// Strings go with -f and integers with -F: -F would type a body of `123` as a number and read a
// body starting with `@` as a file.
//   read:    gh api graphql -f query='query($o:String!,$n:String!,$pr:Int!,$id:ID!){repository(owner:$o,name:$n){pullRequest(number:$pr){id reviewThreads(first:100){pageInfo{hasNextPage} nodes{path originalLine originalStartLine diffSide startDiffSide subjectType comments(first:100){nodes{body replyTo{id} pullRequestReview{id} originalCommit{oid}}}}}}} node(id:$id){... on PullRequestReview{id state body commit{oid} comments{totalCount}}}}' -f o=<o> -f n=<n> -F pr=<pr> -f id=<PRR_>
//   delete:  gh api graphql -f query='mutation($id:ID!){deletePullRequestReview(input:{pullRequestReviewId:$id}){pullRequestReview{id}}}' -f id=<PRR_>
//   recreate (no event, so it stays PENDING):
//            gh api graphql -f query='mutation($pr:ID!,$commit:GitObjectID!,$body:String){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$commit,body:$body}){pullRequestReview{id}}}' -f pr=<PR_> -f commit=<sha> -f body=<b>
//   thread:  gh api graphql -f query=<ADD_PENDING_THREAD> -f id=<PRR_> -f path=<p> -f body=<b> [-F line=<n> -f side=<s>] [-F startLine=<n> -f startSide=<s>] -f subjectType=<LINE|FILE>
//            only the variables that are set are passed; a FILE-subject thread sends no line or side.
//
// Manual smoke for park and restore-pending. It writes to GitHub, so run it only with the user's
// consent, against a scratch PR on a repo whose .gitignore lists .devcycle/:
//   1. In the GitHub UI, start a review on the scratch PR and leave it pending: a summary, a
//      single-line comment, a multi-line comment and a file-level comment.
//   2. `review --park <PRR_…>` with one agent comment: expect `reviewed 1 comment(s)`, the agent's
//      review submitted, and your draft pending again (under a new id) with all four parts.
//   3. `review --park` with a stale PRR_ id: expect a refusal and no change on GitHub.
//   4. `review --park <the new PRR_…> --commit-id <40 zeros>` so step 4 fails: expect exit 1, your
//      draft pending again, and stderr naming the kept snapshot and the restore-pending command.
//   5. Discard the pending draft in the UI, then run that restore-pending command: expect the
//      draft back and the snapshot removed.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { djb2, normalizeBody } from "./pr-review-intake.mjs";
import { makeTempDir } from "./temp-dir.mjs";

export const FOOTER_MARKER = "🤖 Posted by Claude Code on behalf of";

export function footer(login) {
  return `\n\n---\n${FOOTER_MARKER} @${login}`;
}

export function withFooter(body, login) {
  return String(body ?? "").replace(/\s*$/, "") + footer(login);
}

// A retry of the same reply is skipped; a different reply to the same thread is not. Bodies are
// compared normalized, so whitespace drift between the stored and the new reply still matches.
export function alreadyPosted(existingReplies, commentId, stampedBody) {
  const wanted = djb2(normalizeBody(stampedBody));
  return (existingReplies ?? []).some((r) => {
    const body = String(r?.body ?? "");
    return r?.in_reply_to_id === commentId && body.includes(FOOTER_MARKER)
      && djb2(normalizeBody(body)) === wanted;
  });
}

// A pr-level reply has no comment_id to key an in_reply_to_id match against, so idempotency here
// rests on the stamped body alone, matched exactly -- withFooter is deterministic for the same
// (body, login) pair, so this is sufficient.
export function alreadyPostedPrLevel(existingComments, stampedBody) {
  return (existingComments ?? []).some((c) => c?.body === stampedBody);
}

const READ_PENDING_REVIEW =
  "query($o:String!,$n:String!,$pr:Int!,$id:ID!){repository(owner:$o,name:$n){pullRequest(number:$pr){id reviewThreads(first:100){pageInfo{hasNextPage} nodes{path originalLine originalStartLine diffSide startDiffSide subjectType comments(first:100){nodes{body replyTo{id} pullRequestReview{id} originalCommit{oid}}}}}}} node(id:$id){... on PullRequestReview{id state body commit{oid} comments{totalCount}}}}";
const ADD_PENDING_THREAD =
  "mutation($id:ID!,$path:String!,$body:String!,$line:Int,$side:DiffSide,$startLine:Int,$startSide:DiffSide,$subjectType:PullRequestReviewThreadSubjectType){addPullRequestReviewThread(input:{pullRequestReviewId:$id,path:$path,body:$body,line:$line,side:$side,startLine:$startLine,startSide:$startSide,subjectType:$subjectType}){thread{id}}}";

// The read shape flattened to what park needs: only the threads holding at least one comment of
// `reviewId`, each keeping every comment so a thread shared with another review stays visible.
function normalizePendingReview(data, reviewId) {
  const pull = data?.repository?.pullRequest;
  const review = data?.node;
  if (!pull?.id || review?.id !== reviewId) throw new Error(`review ${reviewId} not found on that PR`);
  if (review.state !== "PENDING") throw new Error(`review ${reviewId} is ${review.state}, not PENDING`);
  const threads = (pull.reviewThreads?.nodes ?? []).map((t) => ({
    path: t.path,
    line: t.originalLine ?? null,
    startLine: t.originalStartLine ?? null,
    side: t.diffSide ?? null,
    startSide: t.startDiffSide ?? null,
    subjectType: t.subjectType ?? null,
    comments: (t.comments?.nodes ?? []).map((c) => ({
      body: c.body ?? "",
      reviewId: c.pullRequestReview?.id ?? null,
      isReply: Boolean(c.replyTo),
      originalCommitOid: c.originalCommit?.oid ?? null,
    })),
  }));
  return {
    reviewId,
    pullRequestId: pull.id,
    body: review.body ?? "",
    commitOid: review.commit?.oid ?? null,
    commentCount: review.comments?.totalCount ?? 0,
    threadsTruncated: Boolean(pull.reviewThreads?.pageInfo?.hasNextPage),
    threads: threads.filter((t) => t.comments.some((c) => c.reviewId === reviewId)),
  };
}

export const defaultPostRunner = (exec = execFileSync) => {
  const api = (args) => exec("gh", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return {
    whoami: () => api(["api", "user", "--jq", ".login"]).trim(),
    listReplies: (repo, pr) =>
      JSON.parse(api(["api", `repos/${repo}/pulls/${pr}/comments`, "--paginate"]) || "[]"),
    listPrLevelComments: (repo, pr) =>
      JSON.parse(api(["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]) || "[]"),
    postReply: (repo, pr, commentId, body) => {
      try {
        api(["api", `repos/${repo}/pulls/${pr}/comments/${commentId}/replies`, "-f", `body=${body}`]);
      } catch {
        api(["api", `repos/${repo}/pulls/${pr}/comments`, "-f", `in_reply_to=${commentId}`, "-f", `body=${body}`]);
      }
    },
    postPrLevel: (repo, pr, body) => {
      const dir = makeTempDir("prpost-");
      try {
        const f = join(dir, "body.md");
        writeFileSync(f, body);
        api(["pr", "comment", String(pr), "--repo", repo, "--body-file", f]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    resolveThread: (threadId) =>
      api(["api", "graphql", "-f",
        "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}",
        "-F", `id=${threadId}`]),
    getPrAuthor: (repo, pr) =>
      api(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".user.login"]).trim(),
    findPendingReview: (repo, pr, login) => {
      const [owner, name] = repo.split("/");
      const out = api(["api", "graphql", "-f",
        "query=query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviews(first:50,states:[PENDING]){nodes{id author{login}}}}}}",
        "-F", `o=${owner}`, "-F", `n=${name}`, "-F", `pr=${pr}`]);
      const nodes = JSON.parse(out || "{}")?.data?.repository?.pullRequest?.reviews?.nodes ?? [];
      const match = nodes.find((n) => n?.author?.login === login);
      return match ? match.id : null;
    },
    createReview: (repo, pr, payload) => {
      const dir = makeTempDir("prreview-");
      try {
        const f = join(dir, "review.json");
        writeFileSync(f, JSON.stringify(payload));
        api(["api", `repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", f]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    addReviewThread: (reviewId, { path, line, side, body }) =>
      api(["api", "graphql", "-f",
        "query=mutation($id:ID!,$path:String!,$line:Int!,$side:DiffSide!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$id,path:$path,line:$line,side:$side,body:$body}){thread{id}}}",
        "-F", `id=${reviewId}`, "-F", `path=${path}`, "-F", `line=${line}`, "-F", `side=${side}`,
        "-F", `body=${body}`]),
    submitReview: (reviewId, event, body) =>
      api(["api", "graphql", "-f",
        "query=mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$id,event:$event,body:$body}){pullRequestReview{state}}}",
        "-F", `id=${reviewId}`, "-F", `event=${event}`, "-F", `body=${body}`]),
    readPendingReview: (repo, pr, reviewId) => {
      const [owner, name] = repo.split("/");
      const out = api(["api", "graphql", "-f", `query=${READ_PENDING_REVIEW}`,
        "-f", `o=${owner}`, "-f", `n=${name}`, "-F", `pr=${pr}`, "-f", `id=${reviewId}`]);
      return normalizePendingReview(JSON.parse(out || "{}")?.data, reviewId);
    },
    deletePendingReview: (reviewId) =>
      api(["api", "graphql", "-f",
        "query=mutation($id:ID!){deletePullRequestReview(input:{pullRequestReviewId:$id}){pullRequestReview{id}}}",
        "-f", `id=${reviewId}`]),
    createPendingReview: (pullRequestId, commitOid, body) => {
      const out = api(["api", "graphql", "-f",
        "query=mutation($pr:ID!,$commit:GitObjectID!,$body:String){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$commit,body:$body}){pullRequestReview{id}}}",
        "-f", `pr=${pullRequestId}`, "-f", `commit=${commitOid}`, "-f", `body=${body}`]);
      const id = JSON.parse(out || "{}")?.data?.addPullRequestReview?.pullRequestReview?.id;
      if (!id) throw new Error("addPullRequestReview returned no review id");
      return id;
    },
    addPendingThread: (reviewId, { path, line, side, startLine, startSide, subjectType, body }) => {
      // A file-level thread has no anchor inside the file, so it sends no line and no side.
      const anchored = subjectType !== "FILE";
      const strings = { id: reviewId, path, body, subjectType, ...(anchored && { side, startSide }) };
      const ints = anchored ? { line, startLine } : {};
      const set = (v) => v !== null && v !== undefined;
      api(["api", "graphql", "-f", `query=${ADD_PENDING_THREAD}`,
        ...Object.entries(strings).filter(([, v]) => set(v)).flatMap(([k, v]) => ["-f", `${k}=${v}`]),
        ...Object.entries(ints).filter(([, v]) => set(v)).flatMap(([k, v]) => ["-F", `${k}=${v}`])]);
    },
  };
};

export function runReply({ repo, pr, commentId, body, login, prLevel = false, runner = defaultPostRunner() }) {
  const derived = runner.whoami();
  if (!derived) throw new Error("refusing to post: gh api user returned no login");
  if (login && login !== derived)
    throw new Error(`refusing to post: --login ${login} disagrees with the authenticated account ${derived}`);
  const actor = derived;
  const id = Number(commentId);
  const stamped = withFooter(body, actor);
  if (prLevel) {
    const existing = runner.listPrLevelComments(repo, pr);
    if (alreadyPostedPrLevel(existing, stamped)) return { status: "skipped", reason: "identical-reply-posted" };
    runner.postPrLevel(repo, pr, stamped);
  } else {
    const existing = runner.listReplies(repo, pr);
    if (alreadyPosted(existing, id, stamped)) return { status: "skipped", reason: "identical-reply-posted" };
    runner.postReply(repo, pr, id, stamped);
  }
  return { status: "posted", replyHash: djb2(normalizeBody(stamped)) };
}

export function runResolve({ repo, threadId, runner = defaultPostRunner() }) {
  runner.resolveThread(threadId);
  return { status: "resolved" };
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const SNAPSHOT_DIR = ".devcycle/pending-review-snapshots";

// The review's own comments, each carrying its thread's anchor: one per thread once parkProblems
// has passed, which is the shape both the snapshot and the compare work in.
function ownComments(review) {
  return review.threads.flatMap(({ path, line, side, startLine, startSide, subjectType, comments }) =>
    comments
      .filter((c) => c.reviewId === review.reviewId)
      .map((c) => ({ path, line, side, startLine, startSide, subjectType, body: c.body })));
}

// Every reason the restore could not recreate this pending review as the user wrote it. The
// restore makes one new thread per comment on the review's commit, so anything that is not a lone
// top-level comment on that commit would come back different.
export function parkProblems(review) {
  const problems = [];
  for (const t of review.threads) {
    const own = t.comments.filter((c) => c.reviewId === review.reviewId);
    if (own.some((c) => c.isReply)) problems.push(`a reply inside an existing thread on ${t.path}`);
    if (own.length < t.comments.length) problems.push(`a thread on ${t.path} that also holds another review's comments`);
    if (own.length > 1) problems.push(`${own.length} comments of this review in one thread on ${t.path}`);
    if (own.some((c) => c.originalCommitOid !== review.commitOid))
      problems.push(`a comment on ${t.path} written against a different commit than the review's`);
    if (t.subjectType === "LINE" && t.line === null) problems.push(`a line comment on ${t.path} with no line`);
  }
  if (review.threadsTruncated) problems.push("more review threads on the PR than one read returns");
  const readable = ownComments(review).length;
  if (readable !== review.commentCount)
    problems.push(`the review holds ${review.commentCount} comment(s) but ${readable} could be read`);
  return problems;
}

export function toSnapshot(review, { repo, pr }) {
  return {
    repo, pr,
    reviewId: review.reviewId,
    pullRequestId: review.pullRequestId,
    commitOid: review.commitOid,
    body: review.body,
    commentCount: review.commentCount,
    comments: ownComments(review),
  };
}

export function compareRestored(snapshot, restored) {
  const got = ownComments(restored);
  const want = snapshot.comments;
  if (restored.commentCount !== want.length || got.length !== want.length)
    return [`restored ${restored.commentCount} comment(s) (${got.length} readable), the snapshot holds ${want.length}`];
  const mismatches = [];
  want.forEach((w, i) => {
    const g = got[i];
    const at = `comment ${i + 1} (${w.path})`;
    if (normalizeBody(g.body) !== normalizeBody(w.body)) mismatches.push(`${at}: body differs`);
    if (g.path !== w.path) mismatches.push(`${at}: restored on ${g.path}`);
    if (g.line !== w.line) mismatches.push(`${at}: restored on line ${g.line}, expected ${w.line}`);
  });
  return mismatches;
}

// Steps 5 and 6: recreate the pending review from a snapshot, then re-read and compare it. Never
// throws -- the caller needs to know, either way, whether a pending review now exists.
function restoreSnapshot(snapshot, { repo, pr, runner }) {
  let reviewId = null;
  let step = "step 5 (restore your draft)";
  try {
    reviewId = runner.createPendingReview(snapshot.pullRequestId, snapshot.commitOid, snapshot.body);
    for (const c of snapshot.comments) runner.addPendingThread(reviewId, c);
    step = "step 6 (compare the restored draft)";
    const problems = compareRestored(snapshot, runner.readPendingReview(repo, pr, reviewId));
    return { reviewId, step, problems };
  } catch (e) {
    return { reviewId, step, problems: [e.message] };
  }
}

const replayCommand = ({ snapshotPath, repo, pr }) =>
  `node "${SCRIPT_PATH}" restore-pending --repo ${repo} --pr ${pr} --snapshot "${snapshotPath}"`;

function replayAdvice({ restore, snapshotPath, repo, pr }) {
  const partial = restore.reviewId
    ? ` Pending review ${restore.reviewId} was created but does not match the snapshot: delete it on GitHub first.`
    : "";
  return `Your draft was NOT restored (${restore.problems.join("; ")}).${partial} ` +
    `The snapshot is kept at ${snapshotPath}; replay it with: ${replayCommand({ snapshotPath, repo, pr })}`;
}

function gitToplevel(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`refusing to park: ${cwd} is not inside a git repository, so the snapshot has nowhere ignored to go`);
  }
}

function keptSnapshotFor(dir, repo, pr) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    let kept;
    try {
      kept = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (kept?.repo === repo && Number(kept?.pr) === Number(pr)) return join(dir, name);
  }
  return null;
}

// The snapshot holds the user's private draft, so it is written only where git ignores it, and
// never beside a kept one for the same PR -- a re-run must not snapshot a half-restored copy.
function snapshotPathFor({ repo, pr, reviewId, cwd }) {
  const toplevel = gitToplevel(cwd);
  const rel = `${SNAPSHOT_DIR}/${reviewId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  if (spawnSync("git", ["-C", toplevel, "check-ignore", "-q", rel]).status !== 0)
    throw new Error(`refusing to park: ${SNAPSHOT_DIR}/ is not ignored in ${toplevel}, and the snapshot holds your draft; add .devcycle/ to .gitignore`);
  const kept = keptSnapshotFor(join(toplevel, SNAPSHOT_DIR), repo, pr);
  if (kept)
    throw new Error(`refusing to park: a kept snapshot for ${repo}#${pr} exists at ${kept}; replay it with restore-pending, or delete it once your draft is back`);
  return join(toplevel, rel);
}

function writeSnapshot(snapshotPath, snapshot) {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  let back;
  try {
    back = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    back = null;
  }
  if (!isDeepStrictEqual(back, snapshot)) {
    rmSync(snapshotPath, { force: true });
    throw new Error(`refusing to park: the snapshot at ${snapshotPath} did not read back intact; nothing was deleted`);
  }
}

// Park: snapshot the pending review, delete it, post, restore it and verify the restore. Nothing
// is deleted on GitHub before a snapshot that reads back intact and passes parkProblems, and no
// failure after the delete removes the snapshot.
function parkAndPost({ repo, pr, reviewId, cwd, runner, post }) {
  const snapshotPath = snapshotPathFor({ repo, pr, reviewId, cwd });
  const review = runner.readPendingReview(repo, pr, reviewId);
  const snapshot = toSnapshot(review, { repo, pr });
  writeSnapshot(snapshotPath, snapshot);
  const problems = parkProblems(review);
  if (problems.length) {
    rmSync(snapshotPath, { force: true });
    throw new Error(`refusing to park ${reviewId}, the restore could not recreate it as written: ` +
      `${problems.join("; ")}. Nothing was changed; merge into it or abort`);
  }
  try {
    runner.deletePendingReview(reviewId);
  } catch (e) {
    throw new Error(`park failed at step 3 (delete your pending review): ${e.message}. The snapshot ` +
      `is kept at ${snapshotPath}. Check the PR: if your draft is still pending, nothing changed and ` +
      `the snapshot can be deleted; if it is gone, replay it with: ${replayCommand({ snapshotPath, repo, pr })}`);
  }
  let postError = null;
  try {
    post();
  } catch (e) {
    postError = e;
  }
  const restore = restoreSnapshot(snapshot, { repo, pr, runner });
  if (!postError && !restore.problems.length) {
    rmSync(snapshotPath, { force: true });
    return;
  }
  const failed = [
    ...(postError ? [`step 4 (post the agent's review): ${postError.message}`] : []),
    ...(restore.problems.length ? [restore.step] : []),
  ];
  const draft = restore.problems.length
    ? replayAdvice({ restore, snapshotPath, repo, pr })
    : `Your draft was restored as pending and verified; the snapshot is kept at ${snapshotPath}, delete it once you have checked the draft.`;
  throw new Error(`park failed at ${failed.join(" and ")}. ${draft}`);
}

export function runRestorePending({ repo, pr, snapshotPath, runner = defaultPostRunner() }) {
  const actor = runner.whoami();
  if (!actor) throw new Error("refusing to restore: gh api user returned no login");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (snapshot.repo !== repo || Number(snapshot.pr) !== Number(pr))
    throw new Error(`refusing to restore: ${snapshotPath} is a snapshot of ${snapshot.repo}#${snapshot.pr}, not ${repo}#${pr}`);
  const pending = runner.findPendingReview(repo, pr, actor);
  if (pending)
    throw new Error(`refusing to restore: you already have pending review ${pending} on ${repo}#${pr}, and GitHub allows one`);
  const restore = restoreSnapshot(snapshot, { repo, pr, runner });
  if (restore.problems.length)
    throw new Error(`restore-pending failed at ${restore.step}. ${replayAdvice({ restore, snapshotPath, repo, pr })}`);
  rmSync(snapshotPath, { force: true });
  return { status: "restored", commentCount: snapshot.comments.length };
}

export function runReview({
  repo, pr, commitId, event, body, comments, login, mergeInto, park, cwd = process.cwd(),
  runner = defaultPostRunner(),
}) {
  if (park && mergeInto)
    throw new Error("--park and --merge-into are mutually exclusive: merge submits your draft, park keeps it pending");
  const derived = runner.whoami();
  if (!derived) throw new Error("refusing to post: gh api user returned no login");
  if (login && login !== derived)
    throw new Error(`refusing to post: --login ${login} disagrees with the authenticated account ${derived}`);
  const actor = derived;
  if (event !== "COMMENT") {
    const author = runner.getPrAuthor(repo, pr);
    if (author === actor) throw new Error(`refusing to ${event} your own PR (author @${actor})`);
  }
  const pendingReviewId = runner.findPendingReview(repo, pr, actor);
  if (park && park !== pendingReviewId)
    throw new Error(`refusing to park ${park}: ` +
      (pendingReviewId ? `your pending review on ${repo}#${pr} is ${pendingReviewId}` : `you have no pending review on ${repo}#${pr}`));
  if (pendingReviewId && !mergeInto && !park) return { status: "pending-review-exists", pendingReviewId };
  const stampedSummary = withFooter(body, actor);
  const stampedComments = (comments ?? []).map((c) => ({ ...c, body: withFooter(c.body, actor) }));
  if (mergeInto) {
    for (const c of stampedComments) runner.addReviewThread(mergeInto, c);
    runner.submitReview(mergeInto, event, stampedSummary);
    return { status: "submitted", merged: true, commentCount: stampedComments.length };
  }
  const post = () => runner.createReview(repo, pr, {
    commit_id: commitId, event, body: stampedSummary, comments: stampedComments,
  });
  if (park) {
    parkAndPost({ repo, pr, reviewId: park, cwd, runner, post });
    return { status: "submitted", parked: true, commentCount: stampedComments.length };
  }
  post();
  return { status: "submitted", commentCount: stampedComments.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [sub, ...rest] = process.argv.slice(2);
    const { flags } = parseFlags(rest, {
      "--repo": "value", "--pr": "value", "--comment-id": "value",
      "--body-file": "value", "--login": "value", "--pr-level": "none", "--thread-id": "value",
      "--commit-id": "value", "--event": "value", "--comments-file": "value",
      "--merge-into": "value", "--park": "value", "--snapshot": "value",
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
        login: requireValue(flags, "--login", "a github login"),
        prLevel,
      });
      console.log(r.status === "posted" ? `posted ${r.replyHash}` : "skipped: identical reply already posted");
    } else if (sub === "resolve") {
      runResolve({ repo, threadId: must("--thread-id", "a PRRT_ node id") });
      console.log("resolved");
    } else if (sub === "review") {
      const body = readFileSync(must("--body-file", "a draft path"), "utf8");
      const comments = JSON.parse(readFileSync(must("--comments-file", "a comments JSON path"), "utf8"));
      const r = runReview({
        repo, pr: Number(must("--pr", "a number")),
        commitId: must("--commit-id", "a commit sha"),
        event: must("--event", "a review event"),
        body, comments,
        login: requireValue(flags, "--login", "a github login"),
        mergeInto: requireValue(flags, "--merge-into", "a PRR_ node id"),
        park: requireValue(flags, "--park", "a PRR_ node id"),
      });
      if (r.status === "pending-review-exists") {
        const id = r.pendingReviewId;
        console.error(`pending review exists: ${id}. Pass --merge-into ${id} to add these comments to ` +
          `it and submit your draft with them, --park ${id} to post separately and restore your ` +
          "draft as pending, or abort.");
        process.exit(1);
      }
      console.log(`reviewed ${r.commentCount} comment(s)`);
      if (r.parked) console.log("your pending review was parked and restored as pending (it has a new id)");
    } else if (sub === "restore-pending") {
      const r = runRestorePending({
        repo, pr: Number(must("--pr", "a number")), snapshotPath: must("--snapshot", "a snapshot path"),
      });
      console.log(`restored ${r.commentCount} comment(s) as pending; snapshot removed`);
    } else {
      throw new Error("usage: pr-review-post.mjs <reply|resolve|review|restore-pending> [flags]");
    }
  } catch (e) {
    console.error(`pr-review-post: ${e.message}`);
    process.exit(1);
  }
}
