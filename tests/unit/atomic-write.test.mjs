import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "../../scripts/atomic-write.mjs";

test("atomicWrite writes the contents and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "c9-atomic-"));
  const target = join(dir, "state.md");
  atomicWrite(target, "hello\n");
  assert.equal(readFileSync(target, "utf8"), "hello\n");
  assert.deepEqual(readdirSync(dir), ["state.md"]); // no .tmp sibling left
});

test("atomicWrite replaces existing content in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "c9-atomic-"));
  const target = join(dir, "x.json");
  writeFileSync(target, "old");
  atomicWrite(target, "new");
  assert.equal(readFileSync(target, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

// F2: the previous tests assert only final contents and no leftover .tmp -- both of which a
// plain writeFileSync(path, contents) also satisfies. The property atomicWrite actually adds is
// that the target is never truncated in place: the rename swaps in a new inode. A pre-existing
// hard link to the target proves this -- under plain writeFileSync the link would observe "NEW"
// (same inode, truncated + rewritten); under atomicWrite's rename it keeps reading "OLD".
test("atomicWrite swaps in a new inode and never truncates the original in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "c9-atomic-"));
  const target = join(dir, "y.txt");
  const link = join(dir, "y-link.txt");
  writeFileSync(target, "OLD");
  linkSync(target, link);
  atomicWrite(target, "NEW");
  assert.equal(readFileSync(target, "utf8"), "NEW");
  assert.equal(readFileSync(link, "utf8"), "OLD");
});
