import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { hashTree, digest40, compareManifests } from "../../scripts/tree-hash.mjs";

const seed = () => {
  const d = makeTempDir("devcycle-tree-hash-");
  mkdirSync(join(d, "sub"), { recursive: true });
  writeFileSync(join(d, "a.txt"), "alpha");
  writeFileSync(join(d, "sub", "b.txt"), "beta");
  return d;
};

test("the same tree hashes identically twice", () => {
  const d = seed();
  assert.equal(hashTree(d).digest, hashTree(d).digest);
});

test("one changed byte changes the file entry and the rolling digest", () => {
  const d = seed();
  const before = hashTree(d);
  writeFileSync(join(d, "a.txt"), "alphb");
  const after = hashTree(d);
  assert.notEqual(before.files["a.txt"], after.files["a.txt"]);
  assert.notEqual(before.digest, after.digest);
  assert.equal(before.files["sub/b.txt"], after.files["sub/b.txt"]);
});

test("digest40 matches the run-record schema pattern", () => {
  assert.match(digest40(hashTree(seed()).digest), /^[0-9a-f]{40}$/);
});

test("compareManifests separates added, removed and changed", () => {
  const r = compareManifests({ keep: "1", drop: "2", edit: "3" }, { keep: "1", edit: "4", new: "5" });
  assert.deepEqual(r, { changed: ["edit"], added: ["new"], removed: ["drop"] });
});

test("a symlink is skipped, not followed", () => {
  const d = seed();
  symlinkSync(join(d, "sub"), join(d, "loop"));
  const files = Object.keys(hashTree(d).files);
  assert.deepEqual(files.sort(), ["a.txt", "sub/b.txt"]);
});
