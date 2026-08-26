#!/usr/bin/env node
// Read-only PR-review intake for the reconcile flow. This is the DETERMINISTIC data plane: fetch a
// pull request's review comments (inline, review summaries, PR-level) READ-ONLY, drop threads
// GitHub already marks resolved before anything downstream sees them, redact untrusted third-party
// body text, dedupe against prior intake runs, and emit a normalized envelope. It NEVER mutates PR
// state: no thread-resolving, merging, closing, editing, or comment-writing subcommand appears
// anywhere here, by design, and pr-review-intake.test.mjs greps the source for exactly that. gh is
// wrapped like issue-intake.mjs's defaultGhRunner: short timeout, and any throw degrades to
// { available: false, reason } rather than failing the run. Redaction reuses
// scripts/redaction-check.mjs (--auto-redact --dir) exactly as issue-intake.mjs does.
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// A tiny deterministic string hash (Bernstein djb2), base-36, so the dedup key is stable across
// runs without pulling in a crypto dependency. Unsigned via >>>0 so the result never carries a sign.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The canonical body form the dedup hash keys on: CRLF collapsed to LF, trimmed, and every internal
// whitespace run (spaces, tabs, newlines) collapsed to a single space, so the same comment reworded
// only by whitespace hashes identically.
export function normalizeBody(body) {
  return String(body ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/\s+/g, " ");
}

export function commentKey({ path, line, body } = {}) {
  return `${path ?? ""}:${line ?? ""}:${djb2(normalizeBody(body))}`;
}

// Maps the three raw gh shapes onto the uniform Comment shape and drops any thread GitHub reports
// resolved. An inline comment's thread identity is carried by its review id, so a comment is dropped
// when either its own id or its pull_request_review_id is in the resolved set.
export function normalizeComments({ inline = [], reviews = [], prLevel = [], resolvedThreadIds = [] } = {}) {
  const resolved = new Set(resolvedThreadIds);
  const isResolved = (...ids) => ids.some((x) => x != null && resolved.has(x));
  const out = [];

  for (const c of inline) {
    if (isResolved(c.id, c.pull_request_review_id)) continue;
    out.push({
      id: c.id ?? null,
      kind: "inline",
      author: c.user?.login ?? null,
      body: c.body ?? null,
      path: c.path ?? null,
      line: c.line ?? null,
      diff_hunk: c.diff_hunk ?? null,
      in_reply_to: c.in_reply_to_id ?? null,
      resolved: false,
    });
  }

  for (const r of reviews) {
    if (isResolved(r.id)) continue;
    out.push({
      id: r.id ?? null,
      kind: "review-summary",
      author: r.user?.login ?? null,
      body: r.body ?? null,
      path: null,
      line: null,
      diff_hunk: null,
      in_reply_to: null,
      resolved: false,
    });
  }

  for (const p of prLevel) {
    if (isResolved(p.id)) continue;
    out.push({
      id: p.id ?? null,
      kind: "pr-level",
      author: p.user?.login ?? null,
      body: p.body ?? null,
      path: null,
      line: null,
      diff_hunk: null,
      in_reply_to: null,
      resolved: false,
    });
  }

  return out;
}

// Pasted free text: one pr-level Comment per blank-line-delimited paragraph, authored "(pasted)".
export function wrapPaste(text) {
  return String(text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((body) => ({
      id: null,
      kind: "pr-level",
      author: "(pasted)",
      body,
      path: null,
      line: null,
      diff_hunk: null,
      in_reply_to: null,
      resolved: false,
    }));
}

export function dedupeAgainst(comments, priorKeys) {
  const kept = [];
  const dropped = [];
  for (const c of comments) {
    if (priorKeys.has(commentKey(c))) dropped.push(c);
    else kept.push(c);
  }
  return { kept, dropped };
}

// Pure: takes already-read envelope JSON strings (not a directory) so it is unit-testable without
// touching disk. Collects the commentKey of every comment across every prior envelope.
export function priorKeysFrom(dirEntries) {
  const keys = new Set();
  for (const entry of dirEntries ?? []) {
    let env;
    try { env = JSON.parse(entry); } catch { continue; }
    const comments = Array.isArray(env?.comments) ? env.comments : [];
    for (const c of comments) keys.add(commentKey(c));
  }
  return keys;
}

export const defaultGhRunner = (repo, pr, exec = execFileSync) => {
  const [owner, name] = String(repo ?? "").split("/");
  // No inner catch: a failed read (gh missing / unauthenticated / rate-limited / offline) must THROW
  // so intake degrades to { available:false, reason }. Swallowing it to null/[] would fabricate a
  // truthy empty result indistinguishable from "the PR genuinely has no comments" — the fail-open
  // QC7's `available` flag exists to prevent. This mirrors issue-intake.mjs, which likewise lets its
  // runner's throw propagate and degrades at the intake level rather than inside the runner.
  const api = (args) =>
    JSON.parse(exec("gh", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }) || "null");
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const inline = asArray(api(["api", `repos/${repo}/pulls/${pr}/comments`]));
  const reviews = asArray(api(["api", `repos/${repo}/pulls/${pr}/reviews`]));
  const prLevel = asArray(api(["api", `repos/${repo}/issues/${pr}/comments`]));
  const threadQuery =
    "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){" +
    "pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved}}}}}";
  const threads = api([
    "api", "graphql",
    "-f", `query=${threadQuery}`,
    "-F", `owner=${owner}`,
    "-F", `name=${name}`,
    "-F", `pr=${pr}`,
  ]);
  let resolvedThreadIds = [];
  try {
    const root = threads?.data?.repository ?? threads?.repository;
    const nodes = root?.pullRequest?.reviewThreads?.nodes ?? [];
    resolvedThreadIds = nodes.filter((n) => n?.isResolved).map((n) => n.id);
  } catch {
    resolvedThreadIds = [];
  }
  return { inline, reviews, prLevel, resolvedThreadIds };
};

export const defaultRedactRunner = (dir) =>
  execFileSync("node", [join(SCRIPT_DIR, "redaction-check.mjs"), "--auto-redact", "--dir", dir], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });

// Redaction is a safety net, not a gate: each body is written to its own scratch file, the runner
// rewrites in place, and a failure leaves the originals rather than dropping a comment (mirrors
// issue-intake.mjs). A comment body is untrusted external text — screening it is part of intake.
function redactComments(comments, scratchDir, redactRunner) {
  if (!comments.length || !scratchDir) return comments;
  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch {
    return comments;
  }
  const files = comments.map((_, i) => join(scratchDir, `comment-${i}.md`));
  comments.forEach((c, i) => {
    try { writeFileSync(files[i], String(c.body ?? "")); } catch { /* keep original */ }
  });
  try { redactRunner(scratchDir); } catch { /* keep originals */ }
  comments.forEach((c, i) => {
    try { c.body = readFileSync(files[i], "utf8"); } catch { /* keep original */ }
  });
  return comments;
}

function degraded(repo, pr, mode, err) {
  return {
    available: false,
    target: repo,
    pr,
    mode,
    comments: [],
    counts: { fetched: 0, resolvedDropped: 0, deduped: 0, kept: 0 },
    reason: String(err?.message ?? err),
  };
}

export function intake({
  repo,
  pr,
  mode = "gh",
  pasteText = "",
  scratchDir,
  priorEnvelopes = [],
  ghRunner = defaultGhRunner,
  redactRunner = defaultRedactRunner,
} = {}) {
  const priorKeys = priorKeysFrom(priorEnvelopes);

  if (mode === "paste") {
    let comments = wrapPaste(pasteText);
    const fetched = comments.length;
    comments = redactComments(comments, scratchDir, redactRunner);
    const { kept, dropped } = dedupeAgainst(comments, priorKeys);
    return {
      available: true,
      target: repo,
      pr,
      mode,
      comments: kept,
      counts: { fetched, resolvedDropped: 0, deduped: dropped.length, kept: kept.length },
    };
  }

  let raw;
  try {
    raw = ghRunner(repo, pr);
  } catch (err) {
    return degraded(repo, pr, mode, err);
  }
  if (!raw) return degraded(repo, pr, mode, new Error("no data returned from gh"));

  const inline = raw.inline ?? [];
  const reviews = raw.reviews ?? [];
  const prLevel = raw.prLevel ?? [];
  const resolvedThreadIds = raw.resolvedThreadIds ?? [];
  const fetched = inline.length + reviews.length + prLevel.length;

  let comments = normalizeComments({ inline, reviews, prLevel, resolvedThreadIds });
  const resolvedDropped = fetched - comments.length;

  comments = redactComments(comments, scratchDir, redactRunner);

  const { kept, dropped } = dedupeAgainst(comments, priorKeys);

  return {
    available: true,
    target: repo,
    pr,
    mode,
    comments: kept,
    counts: { fetched, resolvedDropped, deduped: dropped.length, kept: kept.length },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { flags } = parseFlags(process.argv.slice(2), {
      "--repo": "value",
      "--pr": "value",
      "--from-paste": "none",
      "--paste-file": "value",
      "--run": "value",
      "--scratch": "value",
      "--prior": "value",
    });

    const run = requireValue(flags, "--run", "a run id");
    if (run === undefined) throw new Error("--run requires a run id");

    const fromPaste = "--from-paste" in flags;
    const mode = fromPaste ? "paste" : "gh";

    const repo = requireValue(flags, "--repo");
    if (mode === "gh" && repo === undefined) throw new Error("--repo requires an owner/name argument in gh mode");

    const prRaw = requireValue(flags, "--pr", "a number");
    const pr = prRaw === undefined ? undefined : Number(prRaw);

    let pasteText = "";
    if (fromPaste) {
      const pasteFile = requireValue(flags, "--paste-file");
      if (pasteFile) pasteText = readFileSync(pasteFile, "utf8");
    }

    const scratchDir = requireValue(flags, "--scratch") ?? join(".devcycle", "review-intake", run, "scratch");
    const priorDir = requireValue(flags, "--prior") ?? join(".devcycle", "review-intake");

    // priorKeysFrom is pure over already-read contents, so the disk read stays here in the CLI.
    let priorEnvelopes = [];
    try {
      if (existsSync(priorDir)) {
        priorEnvelopes = readdirSync(priorDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) => { try { return readFileSync(join(priorDir, f), "utf8"); } catch { return null; } })
          .filter((s) => s != null);
      }
    } catch {
      priorEnvelopes = [];
    }

    const env = intake({ repo, pr, mode, pasteText, scratchDir, priorEnvelopes });

    const out = join(".devcycle", "review-intake", `${run}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(env, null, 2) + "\n");
    // Read discipline: print only the path; the coordinator hands the path onward, never contents.
    console.log(out);
  } catch (e) {
    console.error(`pr-review-intake: ${e.message}`);
    process.exit(1);
  }
}
