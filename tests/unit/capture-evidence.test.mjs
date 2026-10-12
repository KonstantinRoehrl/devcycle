import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/capture-evidence.mjs", import.meta.url).pathname;
const CHECK = new URL("../../scripts/evidence-completeness-check.mjs", import.meta.url).pathname;
const GATE = `node -e "console.log('ℹ pass 1')"`;
const PLAN = ["# P", "", `**Verification gate:** \`${GATE}\``, "",
  "### Task 3: T", "**Files:**", "- Modify: a.mjs", "**Evidence:** green-green (behavior-preserving)", "**Quality constraints:** none", "",
  "## Dispatch Map", "", "- Wave 1: Task 3", ""].join("\n");

function checkout({ plan = PLAN } = {}) {
  const repo = makeRepo();
  mkdirSync(join(repo, ".devcycle"), { recursive: true });
  writeFileSync(join(repo, ".devcycle/ledger.md"), "Plan: `docs/plan.md`\n");
  if (plan) {
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs/plan.md"), plan);
  }
  return repo;
}
const capture = (repo, args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
const evidence = (repo, name) => readFileSync(join(repo, ".devcycle/evidence", name), "utf8");

test("with no --cmd it runs the task's resolved gate, and the header is that exact string", () => {
  const repo = checkout();
  const r = capture(repo, ["--task", "3", "--phase", "after"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(evidence(repo, "3-after.txt"), `# devcycle-cmd: ${GATE}\nℹ pass 1\n# exit 0\n`);
  assert.equal(r.stdout, `- Evidence: <class> | cmd: ${GATE}\n- After: .devcycle/evidence/3-after.txt (exit 0)\n`);
});

test("a --cmd carrying $VAR and quotes is recorded as typed, never as the shell expanded it", () => {
  const repo = checkout();
  const cmd = `GREETING=hi; echo "$GREETING" '$HOME' && exit 3`;
  const r = capture(repo, ["--task", "3", "--phase", "before", "--cmd", cmd]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(evidence(repo, "3-before.txt"), `# devcycle-cmd: ${cmd}\nhi $HOME\n# exit 3\n`);
  assert.match(r.stdout, /^- Before: \.devcycle\/evidence\/3-before\.txt \(exit 3\)$/m);
});

test("a red capture needs --cmd and prints only its own line", () => {
  const repo = checkout();
  const refused = capture(repo, ["--task", "3", "--phase", "red"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^capture-evidence: --phase red needs --cmd/);
  const r = capture(repo, ["--task", "3", "--phase", "red", "--cmd", "exit 1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "- Red: .devcycle/evidence/3-red.txt (exit 1)\n");
});

test("with no resolvable gate it refuses unless --cmd names the command", () => {
  const repo = checkout({ plan: null });
  const refused = capture(repo, ["--task", "3", "--phase", "after"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no gate command resolves for task 3 .*— pass --cmd/);
  assert.equal(capture(repo, ["--task", "fast", "--phase", "after", "--cmd", "true"]).status, 0);
});

test("bad flags are refused: an unknown phase, a malformed task id, a multi-line --cmd", () => {
  const repo = checkout();
  assert.match(capture(repo, ["--task", "3", "--phase", "during"]).stderr, /--phase must be one of before, after, red/);
  assert.match(capture(repo, ["--task", "../3", "--phase", "after"]).stderr, /--task must be a plan task id/);
  assert.match(capture(repo, ["--task", "3", "--phase", "after", "--cmd", "true\nfalse"]).stderr, /--cmd must be one line/);
});

test("a report built from the helper's printed lines passes the evidence check against the task's gate", () => {
  const repo = checkout();
  const lines = ["before", "after"].flatMap((phase) => capture(repo, ["--task", "3", "--phase", phase]).stdout.trim().split("\n"));
  const [evidenceLine] = lines;
  const report = ["## Task report", evidenceLine.replace("<class>", "green-green"),
    ...lines.filter((l) => /^- (Before|After):/.test(l)), "- Deviations: none", ""].join("\n");
  mkdirSync(join(repo, ".devcycle/reports"), { recursive: true });
  writeFileSync(join(repo, ".devcycle/reports/3.md"), report);
  const r = spawnSync(process.execPath, [CHECK, ".devcycle/reports/3.md", "--task", "3"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
