import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { CUT_RE, GH_TIMEOUT_MS, contentLanded, mergedPrAt, parseCut } from "../../scripts/branch-landed.mjs";
import { commitAll, makeFakeBin, makeRepo, sh, writeInto } from "./helpers.mjs";

const rev = (repo, what) => sh("git", ["rev-parse", what], { cwd: repo }).trim();
// gh answers the exact query mergedPrAt must send; any other argument list gets an empty array.
const ghAnswering = (json) => {
  const bin = makeFakeBin("gh", `const a = process.argv.slice(2).join(" ");
process.stdout.write(a === "pr list --state merged --head feat/t --json number,headRefOid --limit 1" ? ${JSON.stringify(json)} : "[]");`);
  return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
};
const ghFailing = () => {
  const bin = makeFakeBin("gh", "process.exit(1);");
  return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
};

test("GH_TIMEOUT_MS is the short resume timeout", () => {
  assert.equal(GH_TIMEOUT_MS, 5000);
});

test("parseCut reads a state branch line and a ledger Branch header", () => {
  assert.deepEqual(parseCut("feat/x (cut from dev at 1b5b8d3)"), { base: "dev", sha: "1b5b8d3" });
  assert.deepEqual(parseCut("Branch: `feat/x` (cut from `main` at `0000000`)"), { base: "main", sha: "0000000" });
  assert.equal(parseCut("feat/x"), null);
  assert.ok(CUT_RE.test("(cut from main at abc1234)"));
});

test("mergedPrAt returns merged and the PR's head oid", () => {
  const { bin, env } = ghAnswering('[{"number":7,"headRefOid":"abc123"}]');
  try {
    assert.deepEqual(mergedPrAt(process.cwd(), "feat/t", { env }), { merged: true, headOid: "abc123" });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("mergedPrAt: no merged PR, a PR without headRefOid, a failing gh and bad JSON", () => {
  const none = ghAnswering("[]");
  const noOid = ghAnswering('[{"number":7}]');
  const down = ghFailing();
  const garbage = ghAnswering("not json");
  try {
    assert.deepEqual(mergedPrAt(process.cwd(), "feat/t", { env: none.env }), { merged: false, headOid: null });
    assert.deepEqual(mergedPrAt(process.cwd(), "feat/t", { env: noOid.env }), { merged: true, headOid: null });
    assert.equal(mergedPrAt(process.cwd(), "feat/t", { env: down.env }), null);
    assert.equal(mergedPrAt(process.cwd(), "feat/t", { env: garbage.env }), null);
  } finally {
    for (const s of [none, noOid, down, garbage]) rmSync(s.bin, { recursive: true, force: true });
  }
});

// main with one commit, then feat/t adding a.txt and docs/x.md.
function branched() {
  const repo = makeRepo();
  const mergeBase = rev(repo, "HEAD");
  sh("git", ["checkout", "-qb", "feat/t"], { cwd: repo });
  writeInto(repo, "a.txt", "a\n");
  writeInto(repo, "docs/x.md", "x\n");
  commitAll(repo, "feat");
  sh("git", ["checkout", "-q", "main"], { cwd: repo });
  return { repo, mergeBase };
}

test("contentLanded: a squash of the whole branch on base is landed", () => {
  const { repo, mergeBase } = branched();
  try {
    sh("git", ["merge", "--squash", "-q", "feat/t"], { cwd: repo });
    commitAll(repo, "squash");
    assert.equal(contentLanded({ root: repo, mergeBase, base: "main", ref: "feat/t" }), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("contentLanded: an unmerged branch is not landed, and the pathspec narrows the comparison", () => {
  const { repo, mergeBase } = branched();
  try {
    assert.equal(contentLanded({ root: repo, mergeBase, base: "main", ref: "feat/t" }), false);
    writeInto(repo, "docs/x.md", "x\n");
    commitAll(repo, "only the doc reached main");
    assert.equal(contentLanded({ root: repo, mergeBase, base: "main", ref: "feat/t", pathspec: "docs/" }), true);
    assert.equal(contentLanded({ root: repo, mergeBase, base: "main", ref: "feat/t" }), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("contentLanded: an empty change set is null, never landed", () => {
  const repo = makeRepo();
  try {
    const tip = rev(repo, "HEAD");
    sh("git", ["branch", "feat/t"], { cwd: repo });
    assert.equal(contentLanded({ root: repo, mergeBase: tip, base: "main", ref: "feat/t" }), null);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
