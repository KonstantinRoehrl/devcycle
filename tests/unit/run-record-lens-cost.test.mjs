import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/run-record.mjs", import.meta.url));
const run = (args, runsDir) =>
  execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: runsDir } });

function newRun(repo, runsDir) {
  return run(["new", "--plugin-version", "0.15.0", "--plugin-sha", "a".repeat(40),
    "--profile", "thorough", "--repo", repo], runsDir).trim();
}
function readLines(runsDir) {
  const repoDir = join(runsDir, readdirSync(runsDir)[0]);
  return readFileSync(join(repoDir, readdirSync(repoDir)[0]), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("append --kind lens-cost stores cost as a number and validates", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  const id = newRun(repo, runsDir);
  run(["append", "--run", id, "--kind", "lens-cost", "--stage", "maintain", "--lens", "abstraction", "--cost", "0.42", "--repo", repo], runsDir);
  const line = readLines(runsDir).find((o) => o.kind === "lens-cost");
  assert.equal(line.lens, "abstraction");
  assert.equal(line.cost, 0.42);
  assert.equal(typeof line.cost, "number");
});
