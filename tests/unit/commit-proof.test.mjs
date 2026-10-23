// scripts/commit-proof.mjs — one commit proven in a scratch worktree detached at it. Every case builds
// a throwaway repo; nothing reads this repo's own checkout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIMIT_PREFIX, proofLine, proveCommit, provesGreen } from "../../scripts/commit-proof.mjs";
import { writeCapture } from "../../scripts/evidence-capture.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
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
    const { run, unrunnable } = proveCommit(dir, rev(dir, "HEAD"), "exit 3");
    assert.equal(run.status, 3);
    assert.equal(unrunnable, false, "a red gate ran");
    assert.equal(worktrees(dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a proof whose worktree cannot be made is a failed run carrying git's reason, never a throw", () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".git/worktrees"), "a file where git keeps worktree registrations\n");
    const { run, unrunnable } = proveCommit(dir, rev(dir, "HEAD"), "true");
    assert.notEqual(run.status, 0);
    assert.match(run.output, /^devcycle: the proof worktree could not be made: /);
    assert.equal(unrunnable, true);
    assert.equal(proveCommit(dir, rev(dir, "HEAD"), "exit 3").unrunnable, true);
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

test("provesGreen reads the run's own exit line, the one right before the proof line, never a line of its output", () => {
  const sha = "a".repeat(40);
  const line = proofLine({ sha, tree: "b".repeat(40), parent: "c".repeat(40) });
  assert.equal(provesGreen(`# devcycle-cmd: x\n# exit 0\n# exit 1\n${line}\n`, sha), false, "an output line reading `# exit 0` is not the run's exit");
  assert.equal(provesGreen(`# devcycle-cmd: x\n# exit 0\n${line}\n${LIMIT_PREFIX} a known limit\n`, sha), true, "limit lines follow the proof line");
});

test("a gate whose output has no trailing newline still ends on its own exit line, so its capture reads green", () => {
  const dir = makeTempDir("commit-proof-capture-");
  try {
    const sha = "a".repeat(40);
    const line = proofLine({ sha, tree: "b".repeat(40), parent: "c".repeat(40) });
    writeCapture(dir, "gate.txt", [{ cmd: "printf 'ok 12 tests'", status: 0, output: "ok 12 tests" }], [line]);
    const text = readFileSync(join(dir, "gate.txt"), "utf8");
    assert.equal(text, `# devcycle-cmd: printf 'ok 12 tests'\nok 12 tests\n# exit 0\n${line}\n`);
    assert.equal(provesGreen(text, sha), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignored dependency directories, nested ones too, are linked into the proof worktree; other ignored ones are not", () => {
  const dir = repo();
  try {
    writeInto(dir, ".gitignore", "node_modules/\nbuild/\n");
    writeInto(dir, "packages/p/index.txt", "p\n");
    commitAll(dir, "chore: a package");
    writeInto(dir, "node_modules/k/index.txt", "dep\n");
    writeInto(dir, "packages/p/node_modules/q/index.txt", "nested dep\n");
    writeInto(dir, "build/out.txt", "build output\n");
    const { run } = proveCommit(dir, rev(dir, "HEAD"), "cat node_modules/k/index.txt packages/p/node_modules/q/index.txt && test ! -e build");
    assert.deepEqual([run.status, run.output], [0, "dep\nnested dep\n"]);
    assert.equal(sh("cat", ["node_modules/k/index.txt"], { cwd: dir }), "dep\n", "removing the worktree leaves the linked directory alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace link in node_modules, top-level or scoped, is pointed at the worktree's own copy of the package", () => {
  const dir = repo();
  try {
    writeInto(dir, ".gitignore", "node_modules/\n");
    writeInto(dir, "packages/p/index.txt", "committed p\n");
    commitAll(dir, "chore: a workspace package");
    writeInto(dir, "node_modules/k/index.txt", "dep\n");
    mkdirSync(join(dir, "node_modules/@s"));
    symlinkSync("../packages/p", join(dir, "node_modules/p"));
    symlinkSync("../../packages/p", join(dir, "node_modules/@s/p"));
    writeInto(dir, "packages/p/index.txt", "uncommitted p\n");
    const { run } = proveCommit(dir, rev(dir, "HEAD"), "cat node_modules/p/index.txt node_modules/@s/p/index.txt node_modules/k/index.txt");
    assert.deepEqual([run.status, run.output], [0, "committed p\ncommitted p\ndep\n"]);
    assert.equal(readlinkSync(join(dir, "node_modules/p")), "../packages/p", "the shared checkout's own link is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a node_modules/.bin link into a workspace package resolves to the worktree's own copy", () => {
  const dir = repo();
  try {
    writeInto(dir, ".gitignore", "node_modules/\n");
    writeInto(dir, "packages/p/i.txt", "committed p\n");
    commitAll(dir, "chore: a workspace package with a bin");
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    symlinkSync("../packages/p", join(dir, "node_modules/p"));
    symlinkSync("../p/i.txt", join(dir, "node_modules/.bin/pbin"));
    writeInto(dir, "packages/p/i.txt", "uncommitted p\n");
    const { run } = proveCommit(dir, rev(dir, "HEAD"), "cat node_modules/.bin/pbin");
    assert.deepEqual([run.status, run.output], [0, "committed p\n"]);
    assert.equal(readlinkSync(join(dir, "node_modules/.bin/pbin")), "../p/i.txt", "the shared checkout's own bin link is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an editable install pointing into the shared checkout is reported as a known limit, not rewritten", () => {
  const dir = repo();
  try {
    writeInto(dir, ".gitignore", ".venv/\n");
    commitAll(dir, "chore: ignore the venv");
    const site = ".venv/lib/python3.12/site-packages";
    writeInto(dir, `${site}/__editable__.p.pth`, `${join(dir, "packages/p")}\n`);
    writeInto(dir, `${site}/other.pth`, "/usr/lib/elsewhere\n");
    const { run, limits } = proveCommit(dir, rev(dir, "HEAD"), "test -L .venv");
    assert.equal(run.status, 0);
    assert.deepEqual(limits, [`editable install ${site}/__editable__.p.pth points into the shared checkout`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repo with submodules carries a known-limit note: the proof worktree does not populate them", () => {
  const dir = repo();
  try {
    writeInto(dir, ".gitmodules", '[submodule "lib"]\n\tpath = lib\n\turl = https://example.invalid/lib.git\n');
    commitAll(dir, "chore: declare a submodule");
    const { run, limits } = proveCommit(dir, rev(dir, "HEAD"), "true");
    assert.equal(run.status, 0);
    assert.deepEqual(limits, ["submodules (.gitmodules) are not populated in the proof worktree"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a linked vendor directory carries a known-limit note: a Composer path repository in it can read the shared checkout", () => {
  const dir = repo();
  try {
    writeInto(dir, ".gitignore", "vendor/\n");
    commitAll(dir, "chore: ignore vendor");
    writeInto(dir, "vendor/autoload.php", "<?php\n");
    const { run, limits } = proveCommit(dir, rev(dir, "HEAD"), "test -L vendor");
    assert.equal(run.status, 0);
    assert.deepEqual(limits, ["vendor is linked whole: a Composer path repository in it can read the shared checkout"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
