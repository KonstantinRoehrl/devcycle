import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { read, parseJobs } from "./workflow-yaml.mjs";
import { statesIssueRelation } from "../../scripts/pr-body-check.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/pr-body-check.mjs", import.meta.url));

test("statesIssueRelation: a closing keyword, a Refs line or a No issue line is accepted", () => {
  assert.equal(statesIssueRelation("Fixes #12"), true);
  assert.equal(statesIssueRelation("Refs #395"), true);
  assert.equal(statesIssueRelation("## Why\n\nNo issue\n"), true);
  assert.equal(statesIssueRelation("No issue."), true);
});

test("statesIssueRelation: a body silent about issues is refused", () => {
  assert.equal(statesIssueRelation("Just a change."), false);
  assert.equal(statesIssueRelation(""), false);
  assert.equal(statesIssueRelation(null), false);
  assert.equal(statesIssueRelation("see #12 for background"), false);
});

test("statesIssueRelation: the syntax quoted in a code span or fence does not satisfy the check", () => {
  assert.equal(statesIssueRelation("Write `Closes #1` or `Refs #2` in the body."), false);
  assert.equal(statesIssueRelation("```\nNo issue\n```"), false);
});

test("statesIssueRelation: 'no issue' inside a sentence is not the declaration", () => {
  assert.equal(statesIssueRelation("There is no issue with this approach."), false);
});

test("CLI: exits 0 for an accepted body and 1 with guidance for a silent one", () => {
  const run = (body) => spawnSync("node", [SCRIPT], { encoding: "utf8", env: { ...process.env, PR_BODY: body } });
  assert.equal(run("Closes #3").status, 0);
  const refused = run("nothing here");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Closes #n.*Refs #n.*No issue/s);
});

test("validate.yml: the PR-body check runs only on PRs into dev, skips workflow-written PRs, and reads the body from env", () => {
  const job = parseJobs(read(".github/workflows/validate.yml"))["pr-issue-reference"]?.join("\n");
  assert.ok(job, "validate.yml has no pr-issue-reference job");
  assert.match(job, /github\.base_ref == 'dev'/, "the check is not limited to PRs into dev");
  assert.match(job, /github\.head_ref != 'main'/, "the back-merge PR (main into dev) would be checked");
  assert.match(job, /github\.actor != 'dependabot\[bot\]'/, "a dependency bump would be refused");
  assert.match(job, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/, "the body is not passed through env");
  assert.ok(!/run:.*\$\{\{ github\.event\.pull_request\.body/.test(job), "the PR body is interpolated into a shell command");
});
