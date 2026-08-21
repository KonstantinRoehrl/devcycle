import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
