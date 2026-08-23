import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cmd = readFileSync(join(root, "commands/maintain.md"), "utf8");
const deleg = readFileSync(join(root, "references/delegation.md"), "utf8");

test("maintain command states issue-folding is read-only and fixes code, not the issue", () => {
  assert.match(cmd, /issue/i);
  assert.match(cmd, /read-only|never (touch|edit|close)/i);
});

test("delegation notes issue decompose/classify is fast-tier and verification reuses the reviewer", () => {
  assert.match(deleg, /issue/i);
  assert.match(deleg, /fast tier/i);
});
