import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = readFileSync(join(root, "agents/history-inspector.md"), "utf8");
const fm = agent.split(/^---\s*$/m)[1] ?? "";

test("history-inspector has the read-only tool allowlist and no model pin", () => {
  assert.match(fm, /name:\s*history-inspector/);
  assert.match(fm, /tools:\s*Read,\s*Grep,\s*Glob,\s*Bash/);
  assert.doesNotMatch(fm, /^\s*model:/m);
});

test("granting Bash and claiming read-only, it disclaims commit and push", () => {
  assert.match(agent, /read[- ]only/i);
  assert.ok(/commit/i.test(agent) && /push/i.test(agent));
});

test("it carries an explicit, bounded traversal window", () => {
  assert.match(agent, /500 commits|last 500/i);
  assert.match(agent, /6 months/i);
});
