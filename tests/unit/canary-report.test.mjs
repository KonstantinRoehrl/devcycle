// scripts/canary-report.mjs: which failures are a Claude Code break, and what the bump PR into dev does.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bumpSubject, computeVerdict, decideAction, report } from "../../scripts/canary-report.mjs";
import { statesIssueRelation } from "../../scripts/pr-body-check.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const OK = { outcome: "success" };
const FAIL = { outcome: "failure" };
const SKIP = { outcome: "skipped" };
const green = { install: OK, validate_marketplace: OK, validate_manifest: OK, hooks_tests: OK, marketplace_add: OK, plugin_install: OK, load_check: OK, golden_path: OK, pin: SKIP };
const pinWith = (outputs) => ({ outcome: "success", outputs: { install: "success", ...outputs } });


test("all green passes", () => {
  assert.deepEqual(computeVerdict(green), { verdict: "pass", step: null });
});

test("latest fails and the pin passes: a Claude Code break, naming the step", () => {
  assert.deepEqual(computeVerdict({ ...green, hooks_tests: FAIL, pin: pinWith({ hooks_tests: "success" }) }), { verdict: "break", step: "hooks_tests" });
  assert.deepEqual(computeVerdict({ ...green, load_check: FAIL, pin: pinWith({ load_check: "success" }) }), { verdict: "break", step: "load_check" });
});

test("latest and the pin both fail: repo-side", () => {
  assert.deepEqual(computeVerdict({ ...green, hooks_tests: FAIL, pin: pinWith({ hooks_tests: "failure" }) }), { verdict: "repo-side", step: "hooks_tests" });
});

test("a failed npm or marketplace step is infrastructure, whatever else failed", () => {
  assert.equal(computeVerdict({ ...green, install: FAIL, validate_marketplace: SKIP, validate_manifest: SKIP, hooks_tests: SKIP, plugin_install: SKIP, load_check: SKIP, golden_path: OK }).verdict, "infrastructure");
  assert.equal(computeVerdict({ ...green, marketplace_add: FAIL, plugin_install: SKIP, load_check: SKIP }).verdict, "infrastructure");
  assert.equal(computeVerdict({ ...green, hooks_tests: FAIL, pin: { outcome: "success", outputs: { install: "failure" } } }).verdict, "infrastructure");
});

test("a failing plugin install is judged by the pin like any other Claude Code step", () => {
  const installFails = { ...green, plugin_install: FAIL, load_check: SKIP };
  assert.deepEqual(computeVerdict({ ...installFails, plugin_install_confirm: FAIL, pin: pinWith({ plugin_install: "success" }) }), { verdict: "break", step: "plugin_install" });
  assert.deepEqual(computeVerdict({ ...installFails, pin: pinWith({ plugin_install: "failure" }) }), { verdict: "repo-side", step: "plugin_install" });
  assert.equal(computeVerdict({ ...installFails, pin: { outcome: "success", outputs: { install: "failure" } } }).verdict, "infrastructure");
  assert.equal(computeVerdict({ ...installFails, pin: SKIP }).verdict, "infrastructure", "no pin re-run means no break is called");
});

test("an install that failed on latest and passed on the pin is a break only when a second try on latest fails too", () => {
  const installFails = { ...green, plugin_install: FAIL, load_check: SKIP, pin: pinWith({ plugin_install: "success" }) };
  assert.deepEqual(computeVerdict({ ...installFails, plugin_install_confirm: FAIL }), { verdict: "break", step: "plugin_install" });
  assert.deepEqual(computeVerdict({ ...installFails, plugin_install_confirm: OK }), { verdict: "infrastructure", step: null }, "the first failure was a blip");
  for (const absent of [undefined, SKIP]) {
    const verdict = computeVerdict({ ...installFails, plugin_install_confirm: absent });
    assert.notEqual(verdict.verdict, "break", "no failed confirmation, no break");
    assert.equal(verdict.verdict, "infrastructure");
  }
});

test("a confirmation only matters for the install: an install that fails on both is repo-side, the other steps need none", () => {
  const installFails = { ...green, plugin_install: FAIL, load_check: SKIP };
  assert.deepEqual(computeVerdict({ ...installFails, pin: pinWith({ plugin_install: "failure" }), plugin_install_confirm: OK }), { verdict: "repo-side", step: "plugin_install" });
  assert.deepEqual(computeVerdict({ ...green, hooks_tests: FAIL, pin: pinWith({ hooks_tests: "success" }) }), { verdict: "break", step: "hooks_tests" });
  assert.deepEqual(computeVerdict({ ...green, load_check: FAIL, pin: pinWith({ load_check: "success" }) }), { verdict: "break", step: "load_check" });
  assert.deepEqual(computeVerdict({ ...green, hooks_tests: FAIL, plugin_install: FAIL, load_check: SKIP, pin: pinWith({ hooks_tests: "success", plugin_install: "success" }), plugin_install_confirm: OK }), { verdict: "break", step: "hooks_tests" }, "a transient install does not hide a real break");
});

test("the pin's marketplace outage is infrastructure, not repo-side", () => {
  const outage = (latest, pinOutputs) => computeVerdict({ ...green, ...latest, pin: pinWith({ marketplace_add: "failure", ...pinOutputs }) });
  assert.deepEqual(outage({ plugin_install: FAIL, load_check: SKIP }, {}), { verdict: "infrastructure", step: null });
  assert.deepEqual(outage({ load_check: FAIL }, {}), { verdict: "infrastructure", step: null });
  assert.deepEqual(outage({ plugin_install: FAIL, load_check: SKIP }, { plugin_install: "failure" }), { verdict: "infrastructure", step: null });
  assert.deepEqual(outage({ load_check: FAIL }, { load_check: "failure" }), { verdict: "infrastructure", step: null });
  assert.deepEqual(outage({ plugin_install: FAIL, load_check: SKIP, plugin_install_confirm: FAIL }, {}), { verdict: "infrastructure", step: null });
  assert.equal(computeVerdict({ ...green, load_check: FAIL, pin: pinWith({ marketplace_add: "success", load_check: "failure" }) }).verdict, "repo-side", "a pin whose marketplaces were fine is judged as before");
});

test("golden-path failing alone is repo-side for the run, but counts as a pass for Claude Code", () => {
  assert.deepEqual(computeVerdict({ ...green, golden_path: FAIL }), { verdict: "pass", step: null });
});

// --- what the bump PR does ---

const P = (number, kind, to, { ownOnly = kind === "canary", marker = null } = {}) => ({ number, kind, to, ownOnly, marker });
const decide = (over) => decideAction({ verdict: "break", version: "2.1.340", step: "hooks_tests", devPin: "2.1.332", prs: [], ...over });

test("a break that no PR covers opens one", () => {
  assert.deepEqual(decide({}), { kind: "open", target: null, close: [] });
});

test("a break dev already tests at or past is left to dev's own check", () => {
  assert.deepEqual(decide({ devPin: "2.1.340" }), { kind: "dev-ahead", target: null, close: [] });
  assert.deepEqual(decide({ devPin: "2.1.341" }), { kind: "dev-ahead", target: null, close: [] });
});

test("an open Dependabot PR at or past the version takes the comment, and Canary's own PR closes", () => {
  assert.deepEqual(decide({ prs: [P(5, "canary", "2.1.335"), P(9, "dependabot", "2.1.341")] }), { kind: "comment", target: 9, close: [5] });
  assert.deepEqual(decide({ prs: [P(9, "dependabot", "2.1.339")] }), { kind: "open", target: null, close: [] }, "an older Dependabot bump does not cover the break");
});

test("the newest marker keeps a repeat quiet, and a changed step comments again", () => {
  const seen = P(9, "dependabot", "2.1.340", { marker: { version: "2.1.340", step: "hooks_tests" } });
  assert.deepEqual(decide({ prs: [seen] }), { kind: "none", target: 9, close: [] });
  assert.deepEqual(decide({ prs: [seen], step: "load_check" }), { kind: "comment", target: 9, close: [] });
});

test("Canary's own PR for the same version is the target, and an older own one closes", () => {
  assert.deepEqual(decide({ prs: [P(4, "canary", "2.1.336"), P(6, "canary", "2.1.340")] }), { kind: "comment", target: 6, close: [4] });
});

test("an older Canary PR that holds only its own commit is replaced", () => {
  assert.deepEqual(decide({ prs: [P(4, "canary", "2.1.336")] }), { kind: "open", target: null, close: [4] });
});

test("an older Canary PR someone pushed a fix to gets the comment, and no second PR opens", () => {
  assert.deepEqual(decide({ prs: [P(4, "canary", "2.1.336", { ownOnly: false }), P(3, "canary", "2.1.333")] }), { kind: "comment", target: 4, close: [3] });
});

test("a pass closes only Canary's own PRs; repo-side, infrastructure and an unknown version do nothing", () => {
  const prs = [P(4, "canary", "2.1.336"), P(5, "canary", "2.1.337", { ownOnly: false }), P(9, "dependabot", "2.1.341")];
  assert.deepEqual(decide({ verdict: "pass", step: "", prs }), { kind: "none", target: null, close: [4] });
  for (const verdict of ["repo-side", "infrastructure"]) assert.deepEqual(decide({ verdict, prs }), { kind: "none", target: null, close: [] });
  assert.deepEqual(decide({ version: "unknown", prs }), { kind: "none", target: null, close: [] });
});

test("the bump subject is one template that both of CI's Conventional Commits checks accept", () => {
  const subject = bumpSubject("2.1.332", "2.1.340");
  assert.equal(subject, "ci(deps): bump @anthropic-ai/claude-code from 2.1.332 to 2.1.340");
  const validate = readFileSync(".github/workflows/validate.yml", "utf8");
  const prTitle = validate.match(/grep -qE '([^']+)'/)[1];
  const commitConvention = validate.match(/grep -Eq '([^']+)'/)[1];
  assert.match(subject, new RegExp(prTitle));
  assert.match(subject, new RegExp(commitConvention));
});

const SUBJECT = (from, to) => `ci(deps): bump @anthropic-ai/claude-code from ${from} to ${to}`;
const owner = (current) =>
  JSON.stringify({ private: true, description: "x", claudeCodeFloor: "2.1.287", devDependencies: { "@anthropic-ai/claude-code": current } }, null, 2) + "\n";
const DEPENDABOT_HEAD = "dependabot/npm_and_yarn/dot-github/claude-code/claude-code-0a1b2c";
const pr = (number, headRefName, commits, markerAt = null) => ({
  number,
  headRefName,
  body: "",
  comments: markerAt ? [{ body: `<!-- canary version=${markerAt[0]} step=${markerAt[1]} -->` }] : [],
  commits: commits.map((messageHeadline) => ({ messageHeadline })),
});
const canaryPr = (number, version, extra = [], markerAt = null) => pr(number, `canary/claude-code-${version}`, [SUBJECT("2.1.332", version), ...extra], markerAt);

// gh and git record every call; `gh api` answers with the owner file at a PR's head, `git show` with dev's,
// and `git ls-remote --exit-code` throws (exit 2) unless the branch is listed in `remoteBranches`.
function fakes({ prs = [], heads = {}, devPin = "2.1.332", remoteBranches = [] } = {}) {
  const calls = [];
  const gh = (a) => {
    calls.push(["gh", ...a]);
    if (a[0] === "pr" && a[1] === "list") return JSON.stringify(prs);
    if (a[0] === "api") {
      const head = decodeURIComponent(a.at(-1).split("?ref=")[1]);
      if (!(head in heads)) throw new Error(`gh: Not Found (HTTP 404) for ${head}`);
      return owner(heads[head]);
    }
    return "";
  };
  const git = (a) => {
    calls.push(["git", ...a]);
    if (a[0] === "ls-remote") {
      const branch = a.at(-1).replace("refs/heads/", "");
      if (!remoteBranches.includes(branch)) throw Object.assign(new Error("git ls-remote: exit 2"), { status: 2 });
      return `0123456789abcdef0123456789abcdef01234567\t${a.at(-1)}\n`;
    }
    return a[0] === "show" ? owner(devPin) : "";
  };
  return { calls, gh, git };
}
const run = (f, over = {}) => {
  const root = makeTempDir("devcycle-canary-report-");
  try {
    const action = report({ verdict: "break", version: "2.1.340", step: "hooks_tests", runUrl: "https://example.test/run/1", gh: f.gh, git: f.git, root, token: "t0ken", repo: "o/r", ...over });
    const written = join(root, ".github/claude-code/package.json");
    return { action, ownerText: existsSync(written) ? readFileSync(written, "utf8") : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const at = (calls, ...prefix) => calls.findIndex((c) => prefix.every((p, i) => c[i] === p));
const named = (calls, ...prefix) => calls.filter((c) => prefix.every((p, i) => c[i] === p));

test("a break no PR covers authenticates, branches from dev, commits the bump, pushes, opens the PR and dispatches its checks", () => {
  const f = fakes();
  const { action, ownerText } = run(f);
  assert.equal(action.kind, "open");
  assert.deepEqual(f.calls[at(f.calls, "git", "remote")], ["git", "remote", "set-url", "origin", "https://x-access-token:t0ken@github.com/o/r.git"]);
  assert.deepEqual(f.calls[at(f.calls, "git", "fetch")], ["git", "fetch", "--no-tags", "--depth=1", "origin", "+refs/heads/dev:refs/remotes/origin/dev"]);
  assert.ok(at(f.calls, "git", "remote") < at(f.calls, "git", "fetch"), "authenticates before it fetches");
  assert.deepEqual(f.calls[at(f.calls, "git", "checkout")], ["git", "checkout", "-B", "canary/claude-code-2.1.340", "origin/dev"]);
  assert.deepEqual(JSON.parse(ownerText), JSON.parse(owner("2.1.340")), "the current version is bumped and the floor kept");
  const commit = f.calls.find((c) => c[0] === "git" && c.includes("commit"));
  assert.equal(commit[commit.indexOf("-m") + 1], SUBJECT("2.1.332", "2.1.340"));
  assert.ok(commit.includes("user.name=github-actions[bot]"));
  const push = f.calls[at(f.calls, "git", "push")];
  assert.deepEqual(push, ["git", "push", "origin", "HEAD:refs/heads/canary/claude-code-2.1.340"]);
  assert.ok(!push.some((a) => a.includes("force")), "never a force-push");
  assert.ok(at(f.calls, "git", "remote") < at(f.calls, "git", "push"), "authenticates before it pushes");
  assert.deepEqual(f.calls[at(f.calls, "git", "ls-remote")], ["git", "ls-remote", "--exit-code", "--heads", "origin", "refs/heads/canary/claude-code-2.1.340"]);
  assert.ok(at(f.calls, "git", "remote") < at(f.calls, "git", "ls-remote"), "authenticates before it asks the remote");
  assert.ok(at(f.calls, "git", "ls-remote") < at(f.calls, "git", "checkout"), "looks for an existing branch before it creates one");
  const create = f.calls[at(f.calls, "gh", "pr", "create")];
  const flag = (name) => create[create.indexOf(name) + 1];
  assert.equal(flag("--base"), "dev");
  assert.equal(flag("--head"), "canary/claude-code-2.1.340");
  assert.equal(flag("--title"), SUBJECT("2.1.332", "2.1.340"));
  assert.equal(flag("--label"), "canary");
  const body = flag("--body");
  assert.match(body, /the hooks module's tests/);
  assert.match(body, /https:\/\/example\.test\/run\/1/);
  assert.match(body, /^No issue$/m);
  assert.ok(statesIssueRelation(body), "the body passes the PR-body check");
  assert.match(body, /<!-- canary version=2\.1\.340 step=hooks_tests -->/);
  assert.ok(at(f.calls, "gh", "label", "create") < at(f.calls, "gh", "pr", "create"), "the label exists before the PR uses it");
  assert.deepEqual(f.calls[at(f.calls, "gh", "workflow")], ["gh", "workflow", "run", "validate.yml", "--ref", "canary/claude-code-2.1.340"]);
  assert.ok(at(f.calls, "gh", "pr", "create") < at(f.calls, "gh", "workflow"), "the checks are dispatched after the PR opens");
});

test("a break whose branch already sits on the remote with no PR reuses it: no commit, no push, and the PR, label and checks still follow", () => {
  const f = fakes({ remoteBranches: ["canary/claude-code-2.1.340"] });
  const { action, ownerText } = run(f);
  assert.equal(action.kind, "open");
  assert.ok(at(f.calls, "git", "remote") < at(f.calls, "git", "ls-remote"), "authenticates before it asks the remote");
  assert.equal(f.calls.filter((c) => c[0] === "git" && ["checkout", "add", "commit", "push"].some((verb) => c.includes(verb))).length, 0, "no branch, commit or push");
  assert.equal(ownerText, null, "the owner file is not rewritten");
  const create = f.calls[at(f.calls, "gh", "pr", "create")];
  assert.equal(create[create.indexOf("--head") + 1], "canary/claude-code-2.1.340");
  assert.ok(at(f.calls, "gh", "label", "create") < at(f.calls, "gh", "pr", "create"), "the label exists before the PR uses it");
  assert.deepEqual(f.calls[at(f.calls, "gh", "workflow")], ["gh", "workflow", "run", "validate.yml", "--ref", "canary/claude-code-2.1.340"]);
});

test("a break dev already tests at or past pushes nothing, opens nothing, and returns dev's pin", () => {
  const f = fakes({ devPin: "2.1.341" });
  const { action } = run(f);
  assert.equal(action.kind, "dev-ahead");
  assert.equal(action.devPin, "2.1.341");
  assert.equal(at(f.calls, "git", "push"), -1);
  assert.equal(at(f.calls, "gh", "pr", "create"), -1);
  assert.equal(at(f.calls, "gh", "pr", "comment"), -1);
});

test("a covering Dependabot PR gets the comment, read from its head's owner file, and Canary's own PR closes with its branch", () => {
  const f = fakes({ prs: [canaryPr(5, "2.1.335"), pr(9, DEPENDABOT_HEAD, ["ci(deps-dev): bump the claude-code group"])], heads: { "canary/claude-code-2.1.335": "2.1.335", [DEPENDABOT_HEAD]: "2.1.341" } });
  assert.equal(run(f).action.kind, "comment");
  const comment = f.calls[at(f.calls, "gh", "pr", "comment")];
  assert.equal(comment[3], "9");
  assert.match(comment.at(-1), /https:\/\/example\.test\/run\/1[\s\S]*<!-- canary version=2\.1\.340 step=hooks_tests -->/);
  assert.deepEqual(named(f.calls, "gh", "pr", "close").map((c) => c.slice(0, 5)), [["gh", "pr", "close", "5", "--delete-branch"]]);
  assert.equal(at(f.calls, "git", "push"), -1);
});

test("a covering PR whose newest marker names this version and step gets no second comment", () => {
  const f = fakes({ prs: [canaryPr(6, "2.1.340", [], ["2.1.340", "hooks_tests"])], heads: { "canary/claude-code-2.1.340": "2.1.340" } });
  assert.equal(run(f).action.kind, "none");
  assert.equal(at(f.calls, "gh", "pr", "comment"), -1);
  assert.equal(at(f.calls, "gh", "pr", "close"), -1);
});

test("an older Canary PR holding only its own commit closes before the new one opens", () => {
  const f = fakes({ prs: [canaryPr(4, "2.1.336")], heads: { "canary/claude-code-2.1.336": "2.1.336" } });
  assert.equal(run(f).action.kind, "open");
  const closeAt = at(f.calls, "gh", "pr", "close");
  assert.notEqual(closeAt, -1, "the older PR is closed");
  const close = f.calls[closeAt];
  assert.deepEqual(close.slice(0, 5), ["gh", "pr", "close", "4", "--delete-branch"]);
  assert.match(close.at(-1), /2\.1\.340/);
  assert.ok(at(f.calls, "gh", "pr", "close") < at(f.calls, "gh", "pr", "create"));
});

test("an older Canary PR someone pushed a fix to gets the comment and stays open, and no new PR opens", () => {
  const f = fakes({ prs: [canaryPr(4, "2.1.336", ["fix(mod): handle the new event"])], heads: { "canary/claude-code-2.1.336": "2.1.336" } });
  assert.equal(run(f).action.kind, "comment");
  assert.equal(f.calls[at(f.calls, "gh", "pr", "comment")][3], "4");
  assert.equal(at(f.calls, "gh", "pr", "close"), -1);
  assert.equal(at(f.calls, "gh", "pr", "create"), -1);
});

test("a pass closes only Canary's own PRs, naming the passing version, and touches no git", () => {
  const f = fakes({ prs: [canaryPr(4, "2.1.336"), canaryPr(5, "2.1.337", ["fix(mod): x"]), pr(9, DEPENDABOT_HEAD, ["ci(deps-dev): bump"])], heads: { "canary/claude-code-2.1.336": "2.1.336", "canary/claude-code-2.1.337": "2.1.337", [DEPENDABOT_HEAD]: "2.1.341" } });
  run(f, { verdict: "pass", step: "" });
  const closes = named(f.calls, "gh", "pr", "close");
  assert.deepEqual(closes.map((c) => c[3]), ["4"]);
  assert.match(closes[0].at(-1), /passes again on Claude Code 2\.1\.340/);
  assert.equal(f.calls.filter((c) => c[0] === "git").length, 0);
});

test("a repo-side or infrastructure verdict makes no gh or git call at all", () => {
  for (const verdict of ["repo-side", "infrastructure"]) {
    const f = fakes({ prs: [canaryPr(4, "2.1.336")] });
    assert.equal(run(f, { verdict }).action.kind, "none");
    assert.deepEqual(f.calls, []);
  }
});

const workflow = () => readFileSync(".github/workflows/canary.yml", "utf8");

test("the workflow is scheduled, least-privilege, and pins every action by SHA", () => {
  const text = workflow();
  assert.match(text, /schedule:\n\s+- cron:/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /^permissions:\n\s+contents: read/m);
  assert.match(text, /^concurrency:\n\s+group: canary-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/m);
  for (const [, ref] of text.matchAll(/uses:\s+\S+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  const reportAt = text.indexOf("\n  report:");
  for (const grant of ["contents: write", "pull-requests: write", "actions: write"]) {
    assert.equal(text.split(grant).length - 1, 1, `${grant} is granted once`);
    assert.ok(text.indexOf(grant) > reportAt, `${grant} sits inside the report job`);
  }
  assert.doesNotMatch(text, /issues: write/);
  assert.match(text, /default_branch/);
  assert.doesNotMatch(text, /ANTHROPIC_API_KEY/);
});

test("the pin step re-runs a failed plugin install, and the run still fails when only the marketplace step does", () => {
  const text = workflow();
  const pinIf = text.match(/id: pin\n\s+if: >-\n((?:\s+.*\n)+?)\s+continue-on-error/)[1];
  assert.match(pinIf, /steps\.plugin_install\.outcome == 'failure'/);
  assert.match(text, /PLUGIN_INSTALL: \$\{\{ steps\.plugin_install\.outcome \}\}/);
  const failRun = text.match(/- name: Fail the run when any check failed\n\s+if: >-\n((?:\s+.*\n)+?)\s+run:/)[1];
  for (const id of ["install", "validate_marketplace", "validate_manifest", "hooks_tests", "marketplace_add", "plugin_install", "load_check", "golden_path"]) {
    assert.match(failRun, new RegExp(`steps\\.${id}\\.outcome == 'failure'`), `${id} missing from the final failure gate`);
  }
});

test("the workflow confirms a failed install on latest, only when the pin passed it, and the run still fails on it", () => {
  const text = workflow();
  const confirmIf = text.match(/id: plugin_install_confirm\n\s+if: (.*)\n\s+continue-on-error/)[1];
  assert.match(confirmIf, /steps\.plugin_install\.outcome == 'failure'/);
  assert.match(confirmIf, /steps\.pin\.outputs\.plugin_install == 'success'/);
  assert.ok(text.indexOf("id: plugin_install_confirm") > text.indexOf("id: pin\n"), "the confirmation runs after the pin");
  assert.ok(text.indexOf("id: plugin_install_confirm") < text.indexOf("id: verdict"), "and before the verdict reads it");
  const failRun = text.match(/- name: Fail the run when any check failed\n\s+if: >-\n((?:\s+.*\n)+?)\s+run:/)[1];
  assert.match(failRun, /steps\.plugin_install_confirm\.outcome == 'failure'/);
});
