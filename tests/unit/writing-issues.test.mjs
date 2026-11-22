import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");
const pb = () => read("playbooks/writing-issues.md");
const HEADINGS = ["## Boundaries", "## Target repo", "## Kind", "## Gather", "## Verify before drafting", "## Draft", "## Screen", "## Duplicate check", "## Confirm, then file", "## The context section"];
const section = (h) => (pb().split(`\n${h}\n`)[1] ?? "").split("\n## ")[0];

test("the skill is a thin pointer at the writing-issues playbook", () => {
  const skill = read("skills/write-issue/SKILL.md");
  assert.match(skill, /^---\nname: write-issue\ndescription: "[^"]+"\n---\n/);
  assert.ok(skill.includes("Follow `${CLAUDE_PLUGIN_ROOT}/playbooks/writing-issues.md`."));
  assert.ok(skill.includes("Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`."));
});

test("the playbook walks the ten sections in order", () => {
  const at = HEADINGS.map((h) => pb().indexOf(`\n${h}\n`));
  assert.ok(at.every((i) => i > 0), `missing a section: ${HEADINGS.filter((_, k) => at[k] <= 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test("it starts no cycle and only denies the state file", () => {
  assert.match(section("## Boundaries"), /starts no cycle/);
  assert.match(section("## Boundaries"), /no `\.devcycle\/state\.md`/);
});

test("the target comes from the plugin manifest for a devcycle issue, and the user confirms it", () => {
  assert.ok(section("## Target repo").includes("${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"));
  assert.match(section("## Target repo"), /repository/);
});

test("claims are verified upstream, read-only, with the installed version stated", () => {
  const v = section("## Verify before drafting");
  assert.match(v, /`verified`/);
  assert.match(v, /`assumption`/);
  assert.match(v, /gh api repos\/<target> --jq \.default_branch/);
  assert.match(v, /may already be fixed upstream/);
  assert.match(v, /`version`/);
});

test("every kind carries the full field list, and anchors avoid bare line numbers", () => {
  const d = section("## Draft");
  for (const field of ["Why", "What", "How (proposed)", "Outlook", "Quality criteria", "Evidence", "Acceptance", "Reproduction", "Ideation"])
    assert.ok(d.includes(field), `draft field missing: ${field}`);
  assert.match(d, /ISSUE_TEMPLATE/);
  assert.match(d, /never bare line numbers/);
});

test("the screen runs before the user sees the draft, with source-repo terms when cross-repo", () => {
  const s = section("## Screen");
  assert.match(s, /redaction-check\.mjs" --file <draft> --repo <target>/);
  assert.match(s, /--source-repo <source checkout>/);
  assert.match(s, /This goes public: <target> is a public repository\./);
});

test("duplicates are searched across open and closed issues, and a match offers a comment or edit", () => {
  const s = section("## Duplicate check");
  assert.match(s, /gh issue list --repo <target> --state all --search/);
  assert.match(s, /comment/);
});

test("issue-mutating gh calls appear only under Confirm, then file, behind two confirmations", () => {
  const mutating = /gh issue (create|edit|comment|close|delete|reopen)\b/;
  for (const h of HEADINGS.filter((h) => h !== "## Confirm, then file"))
    assert.doesNotMatch(section(h), mutating, `${h} carries an issue-mutating gh call`);
  const c = section("## Confirm, then file");
  assert.match(c, /gh issue create --repo <target> --title "<title>" --body-file <body-file>/);
  assert.match(c, /separately/);
  assert.match(c, /\.permissions\.push/);
});

test("the context section is self-contained and appends the marked Agent context heading", () => {
  const c = section("## The context section");
  assert.match(c, /## Agent context/);
  for (const bullet of ["Why", "What the user was doing", "Acceptance", "Verified claims"])
    assert.ok(c.includes(`**${bullet}**`), `context bullet missing: ${bullet}`);
});

test("the routing table, the docs hub and the docs page carry write-issue", () => {
  const routing = read("docs/routing.md");
  assert.match(routing, /\| `write-issue` \| confirm-first \| yes \|/);
  assert.match(routing, /\*\*`write-issue`'s justification\.\*\*/);
  const hub = read("docs/README.md");
  assert.match(hub, /\n## Skills\n/);
  assert.ok(hub.includes("(../skills/write-issue/SKILL.md)"));
  assert.ok(hub.includes("(playbooks/writing-issues/README.md)"));
  assert.match(read("docs/playbooks/writing-issues/README.md"), /\n## How it fits\n/);
});
