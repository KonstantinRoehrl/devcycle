import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const del = readFileSync(join(root, "references/delegation.md"), "utf8");

test("delegation.md points step-1 graph availability at the extracted helper", () => {
  assert.match(del, /graph-availability\.mjs/);
  assert.match(del, /resolveGraphAvailability/);
});
