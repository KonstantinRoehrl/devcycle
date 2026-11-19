import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const agent = readFileSync(join(root, "agents/plan-drafter.md"), "utf8");
const fm = agent.split(/^---\s*$/m)[1] ?? "";

test("plan-drafter has the drafting tool allowlist and no model pin", () => {
  assert.match(fm, /name:\s*plan-drafter/);
  assert.match(fm, /tools:\s*Read,\s*Grep,\s*Glob,\s*Bash,\s*Write\s*$/m);
  assert.doesNotMatch(fm, /^\s*model:/m);
});

test("it reads the pack and the task format by path, never the full planning playbook", () => {
  assert.match(agent, /pack/i);
  assert.match(agent, /\$\{CLAUDE_PLUGIN_ROOT\}\/references\/plan-task-format\.md/);
  assert.doesNotMatch(agent, /\$\{CLAUDE_PLUGIN_ROOT\}\/playbooks\/planning-waves\.md/);
  assert.match(agent, /never read\s+`playbooks\/planning-waves\.md`/i);
});

test("it never prints a source file through cat, sed -n, head or tail", () => {
  assert.match(agent, /never print\s+a source file\s+through `cat`, `sed -n`, `head` or `tail`/i);
});

test("it writes only its own drafts and never stages, commits or pushes", () => {
  assert.match(agent, /drafts\/task-<n>\.md/);
  assert.ok(/\bstages?\b/i.test(agent) && /\bcommits?\b/i.test(agent) && /\bpush(es)?\b/i.test(agent));
});

test("it returns the result-file envelope and stops on a pinned interface it cannot honour", () => {
  assert.match(agent, /result-file/);
  assert.match(agent, /read-section\.mjs" references\/delegation\.md return-envelopes/);
  assert.match(agent, /cannot hold, stop and say\s+so in your one-line summary/);
  assert.doesNotMatch(agent, /interface-delta/);
});
