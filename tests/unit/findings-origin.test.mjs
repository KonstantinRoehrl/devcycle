import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const findings = readFileSync(join(root, "references/findings.md"), "utf8");

test("findings.md documents the Origin field with its default and issue form", () => {
  assert.match(findings, /\bOrigin\b/);
  assert.match(findings, /lens/);
  assert.match(findings, /github-issue #<n>/);
});

test("findings.md states Origin is provenance only and never affects rank", () => {
  assert.match(findings, /Origin[^\n]*(never|not)[^\n]*(rank|order)/i);
});
