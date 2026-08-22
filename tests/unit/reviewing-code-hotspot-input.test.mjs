import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const reviewing = readFileSync(join(root, "playbooks/reviewing-code.md"), "utf8");

test("reviewing-code.md documents an optional orientation/hotspot input that scopes --match", () => {
  assert.match(reviewing, /hotspot/i);
  assert.match(reviewing, /orientation/i);
  assert.match(reviewing, /--files/);
});

test("the optional input is additive — absent it, behavior is unchanged", () => {
  assert.match(reviewing, /When absent|ignored otherwise|omit/i);
});
