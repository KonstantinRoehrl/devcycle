import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/run-record.mjs", import.meta.url));
const env = (runsDir) => ({ ...process.env, DEVCYCLE_RUNS_DIR: runsDir });
const run = (args, runsDir) => execFileSync("node", [SCRIPT, ...args], { encoding: "utf8", env: env(runsDir) });
const tryRun = (args, runsDir) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: env(runsDir) });
const newRun = (repo, runsDir) => run(["new", "--plugin-version", "0.33.0", "--plugin-sha", "a".repeat(40),
  "--profile", "standard", "--repo", repo], runsDir).trim();
function lines(runsDir) {
  const repoDir = join(runsDir, readdirSync(runsDir)[0]);
  return readFileSync(join(repoDir, readdirSync(repoDir)[0]), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("append --kind sweep-count stores the three counts as integers", () => {
  const runsDir = makeTempDir("runs-"), repo = makeTempDir("repo-");
  const id = newRun(repo, runsDir);
  run(["append", "--run", id, "--kind", "sweep-count", "--sweep", "dead-code", "--category", "over-exported",
    "--verified", "3", "--suspected", "1", "--cleared", "2", "--repo", repo], runsDir);
  const row = lines(runsDir).find((o) => o.kind === "sweep-count");
  assert.deepEqual(row, { kind: "sweep-count", runId: id, sweep: "dead-code", category: "over-exported",
    verified: 3, suspected: 1, cleared: 2 });
});

test("sweep-count rejects a negative count and a missing category", () => {
  const runsDir = makeTempDir("runs-"), repo = makeTempDir("repo-");
  const id = newRun(repo, runsDir);
  const neg = tryRun(["append", "--run", id, "--kind", "sweep-count", "--sweep", "dead-code", "--category", "dead-code",
    "--verified", "-1", "--suspected", "0", "--cleared", "0", "--repo", repo], runsDir);
  assert.notEqual(neg.status, 0);
  const missing = tryRun(["append", "--run", id, "--kind", "sweep-count", "--sweep", "dead-code",
    "--verified", "0", "--suspected", "0", "--cleared", "0", "--repo", repo], runsDir);
  assert.notEqual(missing.status, 0);
  assert.equal(lines(runsDir).filter((o) => o.kind === "sweep-count").length, 0);
});

test("append --kind sweep-consent stores both answers as booleans", () => {
  const runsDir = makeTempDir("runs-"), repo = makeTempDir("repo-");
  const id = newRun(repo, runsDir);
  run(["append", "--run", id, "--kind", "sweep-consent", "--consentExecuting", "false", "--consentCoverage", "true",
    "--repo", repo], runsDir);
  const row = lines(runsDir).find((o) => o.kind === "sweep-consent");
  assert.deepEqual(row, { kind: "sweep-consent", runId: id, consentExecuting: false, consentCoverage: true });
});

test("sweep-consent rejects a non-boolean answer", () => {
  const runsDir = makeTempDir("runs-"), repo = makeTempDir("repo-");
  const id = newRun(repo, runsDir);
  const r = tryRun(["append", "--run", id, "--kind", "sweep-consent", "--consentExecuting", "yes",
    "--consentCoverage", "false", "--repo", repo], runsDir);
  assert.notEqual(r.status, 0);
});
