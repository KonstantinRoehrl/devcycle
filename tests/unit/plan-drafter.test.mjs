import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveRole } from "../../scripts/model-policy.mjs";

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
  assert.match(agent, /tasks\/task-<n>\.md/);
  assert.ok(/\bstages?\b/i.test(agent) && /\bcommits?\b/i.test(agent) && /\bpush(es)?\b/i.test(agent));
});

test("it returns the result-file envelope, stops on a pin it cannot honour and returns an interface-delta for a locked one", () => {
  assert.match(agent, /result-file/);
  assert.match(agent, /read-section\.mjs" references\/delegation\.md return-envelopes/);
  assert.match(agent, /cannot hold, stop and say\s+so in a one-line summary beginning `stopped: <what pin cannot hold>`/);
  assert.match(agent, /write no draft for that\s+task/);
  assert.match(agent, /`interface-delta: Task <n> <what>`/);
  assert.match(agent, /interfaces\.lock\.md/);
  assert.match(agent, /interface-lock\.mjs" check/);
});

test("it reports per output.md like its sibling agents", () => {
  assert.match(agent, /^Report per `\$\{CLAUDE_PLUGIN_ROOT\}\/references\/output\.md`\.$/m);
});

test("delegated planning consumes the stop, the delta and the lock, and batches the edge checker", () => {
  const doc = readFileSync(join(root, "references/delegated-planning.md"), "utf8");
  assert.match(doc, /summary begins `stopped: <what pin cannot hold>` wrote no draft/);
  assert.match(doc, /assembles only once every dispatched task has its file/);
  assert.match(doc, /writes `plan-header\.md`[^]*?before it dispatches any drafter/);
  assert.match(doc, /`pack\.md` and `plan-header\.md`/);
  assert.match(doc, /## Grouped drafting/);
  assert.match(doc, /interface-lock\.mjs" write/);
  assert.match(doc, /`interface-delta: Task <n> <what>`/);
  assert.match(doc, /plan-assemble\.mjs" edges [^\n]*--batch 8/);
  assert.match(doc, /`plan-checker: round <n> — batch <b>`/);
  assert.doesNotMatch(doc, /one fast-tier checker dispatch described\s+`plan-checker: round <n> — Task/);
});

test("model routing sends every edge checker batch to the fast tier", () => {
  assert.equal(resolveRole("checker", { ceiling: "claude-opus-5-5" }).tier, "fast");
  const routing = readFileSync(join(root, "references/model-routing.md"), "utf8");
  assert.doesNotMatch(routing, /unless the pair's Files together exceed 5/);
});
