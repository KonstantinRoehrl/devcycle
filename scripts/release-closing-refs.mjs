#!/usr/bin/env node
// Lists the issues a release closes, as `Closes #n` lines for the release PR body.
//
// GitHub closes an issue only when a closing keyword reaches the default branch. Work lands on dev
// first, so a `Closes #n` in a feature PR closes nothing, and the release PR (main <- dev) is the one
// place the keyword can take effect. `Prepare release` therefore collects the keywords from the PRs
// squashed into dev since the previous release and writes them into the release PR's body, so the
// issues close when the fix actually ships rather than when it merges to dev.
//
// A PR is found through the `(#n)` its squash subject ends with, walking dev's log from the tip down
// to the previous release's `chore(release): prepare vX.Y.Z` line — the only trustworthy lower bound,
// because no ref-range on dev separates released work from unreleased (see CONTRIBUTING.md § Releasing).
// `Refs #n` is not a closing keyword, so a partial fix keeps its issue open.
//
//   --version <X.Y.Z>   the release being prepared; its own prepare commit is not the lower bound
//   --repo <owner/name> the repository whose PRs to read; defaults to $GITHUB_REPOSITORY
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.mjs";

const PREPARE_SUBJECT = /^chore\(release\): prepare v(\S+)$/;
const SQUASHED_PR = /\(#(\d+)\)\s*$/;
// GitHub's own keyword list. The colon is optional; a cross-repo `owner/repo#n` is not matched,
// because this repository's release can only close this repository's issues.
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi;

/** PR numbers squashed into dev since the previous release, newest first. `subjects` is dev's log
 *  from the tip down; the walk stops at the first prepare line for a version other than `version`. */
export function pullNumbersSince(subjects, version) {
  const numbers = [];
  for (const subject of subjects) {
    const prepared = subject.match(PREPARE_SUBJECT)?.[1];
    if (prepared !== undefined && prepared !== version) break;
    const number = subject.match(SQUASHED_PR)?.[1];
    if (number) numbers.push(Number(number));
  }
  return numbers;
}

/** Issue numbers a PR body closes. Code spans and fences are ignored, so prose that explains the
 *  keyword (`Closes #n`) cannot close anything. */
export function closingIssues(body) {
  const prose = (body ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(CLOSING_KEYWORD)].map((m) => Number(m[1]));
}

/** The release PR body lines, ascending and deduplicated. */
export function closesLines(issueNumbers) {
  return [...new Set(issueNumbers)].sort((a, b) => a - b).map((n) => `Closes #${n}`);
}

/** A squash subject's `(#n)` can be an issue number — the release's own squash cites one — and the
 *  pulls endpoint answers 404 for it. That is the only failure read as "not a PR". */
function pullBody(repo, number) {
  try {
    return execFileSync("gh", ["api", `repos/${repo}/pulls/${number}`, "--jq", ".body"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (/HTTP 404|Not Found/.test(String(error.stderr))) return "";
    throw new Error(`could not read PR #${number}: ${String(error.stderr).trim() || error.message}`);
  }
}

const FLAGS = { "--version": "value", "--repo": "value" };

function main() {
  const { flags } = parseFlags(process.argv.slice(2), FLAGS, { requireValues: "nonEmpty" });
  const version = flags["--version"];
  if (!version) throw new Error("--version requires the release version");
  const repo = flags["--repo"] ?? process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("--repo is required when GITHUB_REPOSITORY is unset");

  const subjects = execFileSync("git", ["log", "--format=%s", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  const issues = pullNumbersSince(subjects, version).flatMap((n) => closingIssues(pullBody(repo, n)));
  const lines = closesLines(issues);
  if (lines.length) console.log(lines.join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-closing-refs: ${error.message}`);
    process.exit(1);
  }
}
