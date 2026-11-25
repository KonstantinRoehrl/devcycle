import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

test("refuses when the target already holds a file the move would write, dry run or not, and names it", () => {
  const c = twoCheckouts();
  try {
    const leftover = writeInto(c.wt, ".devcycle/ledger.md", "an earlier cycle's ledger\n");
    const leftoverBrief = writeInto(c.wt, ".devcycle/briefs/1.md", "an earlier cycle's brief\n");
    for (const args of [[], ["--confirm"]]) {
      const r = move("--state", c.statePath, "--to", c.wt, ...args);
      assert.equal(r.status, 1, JSON.stringify(r.out));
      assert.equal(r.out.ok, false);
      assert.ok(r.out.refused.includes(leftover) && r.out.refused.includes(leftoverBrief), r.out.refused);
    }
    assert.equal(readFileSync(leftover, "utf8"), "an earlier cycle's ledger\n");
    assert.equal(readFileSync(leftoverBrief, "utf8"), "an earlier cycle's brief\n");
    assert.equal(existsSync(join(c.wt, ".devcycle/state.md")), false);
    assert.equal(existsSync(c.statePath), true);
  } finally {
    cleanup(c.repo, c.parent);
  }
});

// Each of these puts something other than a directory on a path the move has to write through.
const BLOCKERS = [
  ["the target's .devcycle is a regular file", (wt) => writeInto(wt, ".devcycle", "not a directory\n"), ".devcycle"],
  ["a nested target path is a regular file", (wt) => writeInto(wt, ".devcycle/briefs", "not a directory\n"), ".devcycle/briefs"],
  ["the target's .devcycle is a dangling symlink", (wt) => {
    symlinkSync(join(wt, "nowhere"), join(wt, ".devcycle"));
    return join(wt, ".devcycle");
  }, ".devcycle"],
];
for (const [what, block, rel] of BLOCKERS) {
  test(`refuses when ${what}, dry run or not, and names it`, () => {
    const c = twoCheckouts();
    try {
      const blocker = block(c.wt);
      for (const args of [[], ["--confirm"]]) {
        const r = move("--state", c.statePath, "--to", c.wt, ...args);
        assert.equal(r.status, 1, JSON.stringify(r.out));
        assert.equal(r.out.ok, false);
        assert.ok(r.out.refused.includes(join(c.wt, rel)) && !r.out.refused.includes("copy failed"), r.out.refused);
      }
      assert.equal(lstatSync(blocker).isDirectory(), false, "what was there before is untouched");
      assert.equal(existsSync(join(c.wt, ".devcycle/state.md")), false);
      assert.equal(existsSync(join(c.wt, ".devcycle/ledger.md")), false);
      assert.equal(existsSync(c.statePath), true, "the source state file is intact");
    } finally {
      cleanup(c.repo, c.parent);
    }
  });
}

test("a symlink to a directory is a valid target ancestor", () => {
  const c = twoCheckouts();
  try {
    const real = makeTempDir("move-cycle-real-");
    symlinkSync(real, join(c.wt, ".devcycle"));
    const r = move("--state", c.statePath, "--to", c.wt);
    assert.equal(r.status, 0, JSON.stringify(r.out));
    cleanup(real);
  } finally {
    cleanup(c.repo, c.parent);
  }
});

// A read-only directory passes the preview and then makes the briefs write throw after the others succeeded.
const writable = process.platform !== "win32" && process.getuid?.() !== 0;
test("a copy that fails midway leaves no state file and none of its files, and a retry succeeds", { skip: !writable }, () => {
  const c = twoCheckouts();
  try {
    const briefs = join(c.wt, ".devcycle/briefs");
    mkdirSync(briefs, { recursive: true });
    chmodSync(briefs, 0o500);
    const failed = move("--state", c.statePath, "--to", c.wt, "--confirm");
    assert.equal(failed.status, 1);
    assert.equal(failed.out.ok, false);
    assert.match(failed.out.refused, /copy failed/);
    assert.equal(existsSync(join(c.wt, ".devcycle/state.md")), false, "state.md is written last");
    assert.equal(existsSync(join(c.wt, ".devcycle/ledger.md")), false);
    assert.equal(existsSync(join(c.wt, ".devcycle/stage-log")), false);
    assert.equal(existsSync(join(c.wt, "docs/superpowers")), false, "directories this call made are removed too");
    assert.equal(existsSync(briefs), true, "what was there before is untouched");
    assert.equal(existsSync(c.statePath), true, "the source state file is intact");

    chmodSync(briefs, 0o700);
    const retried = move("--state", c.statePath, "--to", c.wt, "--confirm");
    assert.equal(retried.status, 0, retried.stderr + JSON.stringify(retried.out));
    assert.equal(existsSync(join(c.wt, ".devcycle/state.md")), true);
    assert.equal(existsSync(c.statePath), false);
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
