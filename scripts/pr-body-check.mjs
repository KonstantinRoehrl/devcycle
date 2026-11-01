#!/usr/bin/env node
// Fails a pull request into dev whose body says nothing about issues.
//
// A closing keyword only takes effect once the release PR carries it to main, so a PR that forgets
// it leaves its issue open until someone sweeps by hand (see CONTRIBUTING.md § Closing issues). The
// body must therefore do one of three things: close an issue (`Closes #n`), advance one without
// closing it (`Refs #n`), or say there is none (a line reading `No issue`). Reads the body from
// $PR_BODY rather than an argument, so PR text never reaches a shell command line.
import { pathToFileURL } from "node:url";
import { closingIssues } from "./release-closing-refs.mjs";

const REFS = /\brefs?:?\s+#\d+\b/i;
const NO_ISSUE = /^\s*no issue\.?\s*$/im;

/** True when the body closes an issue, references one, or states that none applies. Code spans and
 *  fences are ignored for the keywords, as they are when the release gathers them. */
export function statesIssueRelation(body) {
  const prose = (body ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return closingIssues(body).length > 0 || REFS.test(prose) || NO_ISSUE.test(prose);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (statesIssueRelation(process.env.PR_BODY)) process.exit(0);
  console.error(
    "pr-body-check: the PR body names no issue. Add `Closes #n` for an issue this PR fully fixes, " +
      "`Refs #n` for one it only advances, or a line reading `No issue`. " +
      "An issue is closed only by a keyword that reaches main with the release, so a forgotten one stays open."
  );
  process.exit(1);
}
