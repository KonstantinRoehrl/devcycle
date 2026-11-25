import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { commitAll, makeRepo, sh, writeInto } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/move-cycle.mjs", import.meta.url));
const RUN = "00000000000000c3";
const move = (...args) => {
  const r = spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

// A main checkout holding the cycle, and a sibling worktree on its branch.
function twoCheckouts() {
  const repo = realpathSync(makeRepo());
  writeInto(repo, ".gitignore", ".devcycle/\ndocs/superpowers/\n");
  writeInto(repo, "docs/plan.md", "# tracked plan\n");
  commitAll(repo, "base");
  const parent = makeTempDir("move-cycle-wt-");
  const wt = join(parent, "wt");
  sh("git", ["worktree", "add", "-q", "-b", "feat/b", wt], { cwd: repo });
  writeInto(repo, "docs/superpowers/specs/s.md", "# ignored spec\n");
  const statePath = writeInto(repo, ".devcycle/state.md", [
    "# devcycle state", "- stage: execution", `- root: ${repo}`, "- branch: feat/b (cut from main at 0000000)",
    "- spec: docs/superpowers/specs/s.md", "- plan: docs/plan.md", "- ledger: .devcycle/ledger.md", `- run: ${RUN}`, "",
  ].join("\n"));
  writeInto(repo, ".devcycle/ledger.md", "Plan: `docs/plan.md`\n");
  writeInto(repo, `.devcycle/stage-log/${RUN}.jsonl`, "{}\n");
  writeInto(repo, ".devcycle/briefs/1.md", "brief\n");
  return { repo, parent, wt: realpathSync(wt), statePath };
}
const cleanup = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

test("without --confirm it lists the move and writes nothing", () => {
  const c = twoCheckouts();
  try {
    const r = move("--state", c.statePath, "--to", c.wt);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.dryRun, true);
    assert.deepEqual(r.out.moved.sort(), ["briefs/1.md", "ledger.md", `stage-log/${RUN}.jsonl`, "state.md"]);
    assert.deepEqual(r.out.copiedArtifacts, ["docs/superpowers/specs/s.md"]);
    assert.equal(existsSync(join(c.wt, ".devcycle")), false);
    assert.equal(existsSync(c.statePath), true);
  } finally {
    cleanup(c.repo, c.parent);
  }
});

test("--confirm copies the run-scoped files and ignored artifacts, rewrites root: and removes the source state file", () => {
  const c = twoCheckouts();
  try {
    const r = move("--state", c.statePath, "--to", c.wt, "--confirm");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([r.out.ok, r.out.dryRun, r.out.from, r.out.to], [true, false, c.repo, c.wt]);
    const moved = readFileSync(join(c.wt, ".devcycle/state.md"), "utf8");
    assert.match(moved, new RegExp(`^- root: ${c.wt}$`, "m"));
    assert.match(moved, /^- branch: feat\/b \(cut from main at 0000000\)$/m);
    for (const rel of [".devcycle/ledger.md", `.devcycle/stage-log/${RUN}.jsonl`, ".devcycle/briefs/1.md", "docs/superpowers/specs/s.md"])
      assert.equal(readFileSync(join(c.wt, rel), "utf8"), readFileSync(join(c.repo, rel), "utf8"), rel);
    assert.equal(existsSync(c.statePath), false, "the source state file stays behind");
    assert.equal(existsSync(join(c.repo, ".devcycle/ledger.md")), true, "only the state file leaves the source");
  } finally {
    cleanup(c.repo, c.parent);
  }
});

test("refuses when the target already holds a state file, and names it", () => {
  const c = twoCheckouts();
  try {
    const theirs = writeInto(c.wt, ".devcycle/state.md", "# devcycle state\n- stage: planning\n");
    const r = move("--state", c.statePath, "--to", c.wt, "--confirm");
    assert.equal(r.status, 1);
    assert.equal(r.out.ok, false);
    assert.ok(r.out.refused.includes(theirs), r.out.refused);
    assert.equal(readFileSync(theirs, "utf8"), "# devcycle state\n- stage: planning\n");
    assert.equal(existsSync(c.statePath), true);
  } finally {
    cleanup(c.repo, c.parent);
  }
});

test("refuses a checkout of another repository", () => {
  const c = twoCheckouts();
  const other = realpathSync(makeRepo());
  try {
    const r = move("--state", c.statePath, "--to", other, "--confirm");
    assert.equal(r.status, 1);
    assert.match(r.out.refused, /not a worktree of this cycle's repository/);
    assert.equal(existsSync(join(other, ".devcycle")), false);
  } finally {
    cleanup(c.repo, c.parent, other);
  }
});

test("a missing --to is a usage error", () => {
  const r = spawnSync("node", [SCRIPT, "--state", "x"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^move-cycle: /m);
});
