import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");
const pb = () => read("playbooks/triaging-issues.md");
const HEADINGS = ["## Boundaries", "## Fetch", "## Read and decompose", "## Verify", "## Rank", "## Cluster", "## Roadmap cross-check", "## Report", "## Delta", "## Cost"];
const section = (h) => (pb().split(`\n${h}\n`)[1] ?? "").split("\n## ")[0];

test("the skill is a thin pointer at the triaging-issues playbook", () => {
  const skill = read("skills/triage-issues/SKILL.md");
  assert.match(skill, /^---\nname: triage-issues\ndescription: "[^"]+"\n---\n/);
  assert.ok(skill.includes("Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/triaging-issues.md`."));
});

test("the playbook walks its sections in order and follows the shared issue-folding owner", () => {
  const at = HEADINGS.map((h) => pb().indexOf(`\n${h}\n`));
  assert.ok(at.every((i) => i > 0), `missing a section: ${HEADINGS.filter((_, k) => at[k] <= 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(section("## Fetch").includes("${CLAUDE_PLUGIN_ROOT}/references/issue-folding.md"));
  assert.doesNotMatch(pb(), /#44/, "the issue-folding worked example belongs to the reference, not here");
});

test("the fetch keeps tracked issues and stops on any unavailable reason", () => {
  const f = section("## Fetch");
  assert.match(f, /issue-intake\.mjs" --repo <owner\/name> --scratch \.devcycle\/issue-intake\/triage-<date> --include-tracked/);
  assert.match(f, /count-mismatch/);
  assert.match(f, /stops the run/);
});

test("it is read-only toward GitHub and denies the state file", () => {
  assert.doesNotMatch(pb(), /gh\s+issue\s+(create|close|comment|edit|label|delete|reopen)\b/);
  assert.match(section("## Boundaries"), /starts no cycle/);
  assert.match(section("## Boundaries"), /no `\.devcycle\/state\.md`/);
});

test("the roadmap answer is recorded and a missing roadmap is an explicit line", () => {
  const r = section("## Roadmap cross-check");
  assert.match(r, /issue-triage\.mjs" previous/);
  assert.match(r, /ROADMAP\.md/);
  assert.match(r, /Roadmap: none found\./);
});

test("the report ends in the data block and each cluster carries a self-contained task text", () => {
  const r = section("## Report");
  assert.match(r, /YYYY-MM-DD-issue-triage\.md/);
  assert.match(r, /issue-triage\.mjs" remember --report-dir <dir> --roadmap <path\|none>/);
  assert.match(r, /self-contained task text/);
  assert.match(r, /\/devcycle:cycle /);
  assert.match(r, /issue-triage-data/);
});

test("the delta is script-computed from the previous report's block", () => {
  const d = section("## Delta");
  assert.match(d, /issue-triage\.mjs" delta --previous <previous> --current <new report>/);
  assert.match(d, /First run: no previous report\./);
});

test("the routing table and the docs hub carry triage-issues", () => {
  assert.match(read("docs/routing.md"), /\| `triage-issues` \| read-only \| yes \|/);
  const hub = read("docs/README.md");
  assert.ok(hub.includes("(../skills/triage-issues/SKILL.md)"));
  assert.ok(hub.includes("(playbooks/triaging-issues/README.md)"));
});
