// scripts/commit-proof.mjs — one commit proven in a scratch worktree detached at it. Every case builds
// a throwaway repo; nothing reads this repo's own checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proofLine, proveCommit, provesGreen } from "../../scripts/commit-proof.mjs";
import { makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";

function repo() {
  const dir = makeRepo();
  writeInto(dir, "src/a.txt", "committed\n");
  commitAll(dir, "chore: seed");
  return dir;
}

const rev = (dir, ref) => sh("git", ["rev-parse", ref], { cwd: dir }).trim();
const worktrees = (dir) =>
  sh("git", ["worktree", "list", "--porcelain"], { cwd: dir }).split("\n").filter((l) => l.startsWith("worktree ")).length;

test("proveCommit runs the command at the commit, never in the shared checkout's dirty work tree", () => {
  const dir = repo();
  try {
    writeInto(dir, "src/a.txt", "uncommitted\n");
    const sha = rev(dir, "HEAD");
    const { run, proof, limits } = proveCommit(dir, sha, "cat src/a.txt");
    assert.deepEqual(run, { cmd: "cat src/a.txt", status: 0, output: "committed\n" });
    assert.deepEqual(proof, { sha, tree: rev(dir, "HEAD^{tree}"), parent: rev(dir, "HEAD~1") });
    assert.deepEqual(limits, []);
    assert.equal(worktrees(dir), 1, "the proof worktree is removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a red command is a red run, and its worktree is removed all the same", () => {
  const dir = repo();
  try {
    const { run } = proveCommit(dir, rev(dir, "HEAD"), "exit 3");
    assert.equal(run.status, 3);
    assert.equal(worktrees(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof whose worktree cannot be made is a failed run carrying git's reason, never a throw", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".git/worktrees"), "a file where git keeps worktree registrations\n");
    const { run } = proveCommit(dir, rev(dir, "HEAD"), "true");
    assert.notEqual(run.status, 0);
    assert.match(run.output, /^devcycle: the proof worktree could not be made: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof that cannot even make its temp directory is a failed run, never a throw", () => {
  const dir = repo();
  const saved = process.env.TMPDIR;
  try {
    process.env.TMPDIR = join(dir, "no-such-dir");
    const { run } = proveCommit(dir, rev(dir, "HEAD"), "true");
    assert.equal(run.status, 1);
    assert.match(run.output, /^devcycle: the proof could not run: /);
  } finally {
    process.env.TMPDIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provesGreen: a capture proves a sha green only when its proof line names that sha and its run passed", () => {
  const sha = "a".repeat(40);
  const line = proofLine({ sha, tree: "b".repeat(40), parent: "c".repeat(40) });
  assert.equal(line, `# devcycle-proof: sha=${sha} tree=${"b".repeat(40)} parent=${"c".repeat(40)}`);
  assert.equal(provesGreen(`# devcycle-cmd: true\n# exit 0\n${line}\n`, sha), true);
  assert.equal(provesGreen(`# devcycle-cmd: false\n# exit 1\n${line}\n`, sha), false);
  assert.equal(provesGreen(`# devcycle-cmd: true\n# exit 0\n${line}\n`, "d".repeat(40)), false);
  assert.equal(provesGreen("# devcycle-cmd: true\n# exit 0\n", sha), false, "a capture from before the proof names no sha");
});
