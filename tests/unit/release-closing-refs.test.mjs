import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { closesLines, closingIssues, pullNumbersSince } from "../../scripts/release-closing-refs.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/release-closing-refs.mjs", import.meta.url));

test("closingIssues: every GitHub closing keyword form closes, case-insensitively", () => {
  const body = "Closes #1\nfixes #2, Resolved: #3\nFIXED #4\nclose #5";
  assert.deepEqual(closingIssues(body), [1, 2, 3, 4, 5]);
});

test("closingIssues: Refs and bare mentions keep an issue open", () => {
  assert.deepEqual(closingIssues("Refs #395\nsee #12\nrelated to #7"), []);
});

test("closingIssues: a keyword inside a code span or fence is explanation, not a close", () => {
  const body = "Write `Closes #9` to close.\n```\nFixes #10\n```\nCloses #11";
  assert.deepEqual(closingIssues(body), [11]);
});

test("closingIssues: a cross-repo reference and an empty body close nothing here", () => {
  assert.deepEqual(closingIssues("Closes other/repo#3"), []);
  assert.deepEqual(closingIssues(null), []);
});

test("closesLines: ascending and deduplicated", () => {
  assert.deepEqual(closesLines([30, 4, 30, 12]), ["Closes #4", "Closes #12", "Closes #30"]);
});

test("pullNumbersSince: stops at the previous release's prepare line, not this release's own", () => {
  const subjects = [
    "ci: run the required checks on the v0.30.0 release PR",
    "chore(release): prepare v0.30.0",
    "fix(a): later fix (#402)",
    "feat(b): earlier feature (#397)",
    "chore(release): prepare v0.29.0",
    "fix(c): already released (#390)",
  ];
  assert.deepEqual(pullNumbersSince(subjects, "0.30.0"), [402, 397]);
});

test("pullNumbersSince: a subject citing several numbers yields only the trailing PR number", () => {
  assert.deepEqual(pullNumbersSince(["fix: stop bouncing (#384, #383) (#396)"], "0.30.0"), [396]);
});

test("pullNumbersSince: a repo with no earlier release walks the whole log", () => {
  assert.deepEqual(pullNumbersSince(["fix: a (#2)", "feat: b (#1)"], "0.1.0"), [2, 1]);
});

// The CLI against a throwaway git repo and a stub `gh` placed first on PATH.
function runCli({ log, bodies }) {
  const dir = makeTempDir("release-closing-refs-");
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
  sh("git", ["init", "-q"]);
  sh("git", ["config", "user.email", "t@example.com"]);
  sh("git", ["config", "user.name", "t"]);
  for (const subject of [...log].reverse()) sh("git", ["commit", "-q", "--allow-empty", "-m", subject]);
  const stub = join(dir, "gh");
  const cases = Object.entries(bodies)
    .map(([n, body]) => `  *pulls/${n}) printf '%s' ${JSON.stringify(body)};;`)
    .join("\n");
  writeFileSync(
    stub,
    `#!/bin/sh\ncase "$2" in\n${cases}\n  *) echo "gh: Not Found (HTTP 404)" >&2; exit 1;;\nesac\n`,
  );
  chmodSync(stub, 0o755);
  return spawnSync("node", [SCRIPT, "--version", "0.30.0", "--repo", "o/r"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
  });
}

test("CLI: prints Closes lines from the unreleased PRs only, skipping an issue number cited as (#n)", () => {
  const result = runCli({
    log: [
      "chore(release): prepare v0.30.0",
      "fix: newer (#402)",
      "feat: older (#397)",
      "feat: the last release itself (#395)",
      "chore(release): prepare v0.29.0",
      "fix: already shipped (#390)",
    ],
    bodies: { 402: "Closes #395\nRefs #400", 397: "Fixes #380", 390: "Closes #1" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Closes #380\nCloses #395\n");
});

test("CLI: a PR that closes nothing prints nothing", () => {
  const result = runCli({ log: ["fix: x (#5)", "chore(release): prepare v0.29.0"], bodies: { 5: "Refs #1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("CLI: a missing --version is refused", () => {
  const result = spawnSync("node", [SCRIPT, "--repo", "o/r"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--version/);
});
