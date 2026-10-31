// scripts/canary-report.mjs: which failures are a Claude Code break, and what the rolling issue does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeVerdict, currentPin, decideAction, report } from "../../scripts/canary-report.mjs";

const OK = { outcome: "success" };
const FAIL = { outcome: "failure" };
const SKIP = { outcome: "skipped" };
const green = { install: OK, validate_marketplace: OK, validate_manifest: OK, hooks_tests: OK, marketplace_add: OK, plugin_install: OK, load_check: OK, golden_path: OK, pin: SKIP };
const pinWith = (outputs) => ({ outcome: "success", outputs: { install: "success", ...outputs } });

test("the pin is the last of validate.yml's matrix", () => {
  assert.equal(currentPin('cli: ["2.1.287", "2.1.292"]'), "2.1.292");
  assert.match(currentPin(readFileSync(".github/workflows/validate.yml", "utf8")), /^\d+\.\d+\.\d+$/);
  assert.throws(() => currentPin("no matrix here"), /matrix/);
});

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
  assert.deepEqual(computeVerdict({ ...installFails, pin: pinWith({ plugin_install: "success" }) }), { verdict: "break", step: "plugin_install" });
  assert.deepEqual(computeVerdict({ ...installFails, pin: pinWith({ plugin_install: "failure" }) }), { verdict: "repo-side", step: "plugin_install" });
  assert.equal(computeVerdict({ ...installFails, pin: { outcome: "success", outputs: { install: "failure" } } }).verdict, "infrastructure");
  assert.equal(computeVerdict({ ...installFails, pin: SKIP }).verdict, "infrastructure", "no pin re-run means no break is called");
});

test("golden-path failing alone is repo-side for the run, but counts as a pass for Claude Code", () => {
  assert.deepEqual(computeVerdict({ ...green, golden_path: FAIL }), { verdict: "pass", step: null });
});

const open = { number: 7, marker: { version: "2.1.400", step: "hooks_tests" } };

test("the issue table", () => {
  const decide = (verdict, issue, version = "2.1.400", step = "hooks_tests") => decideAction({ verdict, version, step, issue }).kind;
  assert.equal(decide("break", null), "open");
  assert.equal(decide("break", open), "none", "same version and step");
  assert.equal(decide("break", open, "2.1.401"), "comment");
  assert.equal(decide("break", open, "2.1.400", "load_check"), "comment");
  assert.equal(decide("pass", null), "none");
  assert.equal(decide("pass", open), "close");
  for (const verdict of ["repo-side", "infrastructure"]) {
    assert.equal(decide(verdict, null), "none");
    assert.equal(decide(verdict, open), "none");
  }
});

function fakeGh(openIssues = []) {
  const calls = [];
  return { calls, gh: (args) => {
    calls.push(args);
    return args[0] === "issue" && args[1] === "list" ? JSON.stringify(openIssues) : "";
  } };
}
const issueWith = (version, step) => ({ number: 7, body: "x", comments: [{ body: `<!-- canary version=${version} step=${step} -->` }] });
const args = { version: "2.1.400", step: "hooks_tests", runUrl: "https://example.test/run/1" };

test("a break with no issue creates the label, then opens one naming the version, step and run link", () => {
  const f = fakeGh();
  report({ ...args, verdict: "break", gh: f.gh });
  assert.deepEqual(f.calls[0].slice(0, 3), ["label", "create", "canary"]);
  const create = f.calls.find((c) => c[0] === "issue" && c[1] === "create");
  const text = create.join(" ");
  assert.match(text, /2\.1\.400/);
  assert.match(text, /hooks module/i);
  assert.match(text, /example\.test\/run\/1/);
  assert.match(text, /<!-- canary version=2\.1\.400 step=hooks_tests -->/);
});

test("the marker comes from the newest place it appears, so a repeat stays quiet and a change comments", () => {
  const quiet = fakeGh([issueWith("2.1.400", "hooks_tests")]);
  assert.equal(report({ ...args, verdict: "break", gh: quiet.gh }).kind, "none");
  assert.equal(quiet.calls.some((c) => c[1] === "comment"), false);
  const moved = fakeGh([issueWith("2.1.399", "hooks_tests")]);
  assert.equal(report({ ...args, verdict: "break", gh: moved.gh }).kind, "comment");
  assert.ok(moved.calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "7"));
});

test("recovery closes the open issue with the passing version", () => {
  const f = fakeGh([issueWith("2.1.399", "hooks_tests")]);
  report({ ...args, step: "", verdict: "pass", gh: f.gh });
  const close = f.calls.find((c) => c[0] === "issue" && c[1] === "close");
  assert.equal(close[2], "7");
  assert.match(close.join(" "), /2\.1\.400/);
});

const workflow = () => readFileSync(".github/workflows/canary.yml", "utf8");

test("the workflow is scheduled, least-privilege, and pins every action by SHA", () => {
  const text = workflow();
  assert.match(text, /schedule:\n\s+- cron:/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /^permissions:\n\s+contents: read/m);
  assert.match(text, /^concurrency:\n\s+group: canary-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/m);
  for (const [, ref] of text.matchAll(/uses:\s+\S+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  assert.equal(text.match(/issues: write/g).length, 1);
  assert.ok(text.indexOf("issues: write") > text.indexOf("\n  report:"), "issues: write sits outside the report job");
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
