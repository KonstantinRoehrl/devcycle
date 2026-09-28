import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const playbook = read("../../playbooks/maintaining-the-repo.md");
const config = read("../../references/config.md");

test("config.md tracks the maintenance-findings store like promotions", () => {
  assert.match(config, /docs\/devcycle\/maintenance-findings\//);
});

test("the playbook writes the store only through the maintenance-findings CLI", () => {
  assert.match(playbook, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/maintenance-findings\.mjs"/);
  for (const verb of ["apply-pass", "dismiss", "stranded"]) assert.match(playbook, new RegExp(verb));
  assert.match(playbook, /docTrackingPolicy/);
  assert.doesNotMatch(playbook, /recordMaintenanceFinding|removeMaintenanceFinding|verifyMaintenance/);
});

test("the playbook renders the three longitudinal sections and the lens-cost rollup", () => {
  assert.match(playbook, /Previously known \(persisting\)/);
  assert.match(playbook, /Resolved since last pass/);
  assert.match(playbook, /Trending/);
  assert.match(playbook, /lens-cost/);
});

test("the playbook keeps dismissal load-bearing and revocable", () => {
  assert.match(playbook, /load-bearing/);
  assert.match(playbook, /never auto-re-evaluated/);
  assert.match(playbook, /--revoke/);
});

test("resolution deletes records, and only on the user's confirmation of a whole pass", () => {
  assert.match(playbook, /deleted, not written/);
  assert.match(playbook, /never accumulates settled history/);
  assert.match(playbook, /not assessed: partial pass/);
  assert.match(playbook, /--resolve/);
});

test("the store holds no issue records and has no regressed state", () => {
  assert.doesNotMatch(playbook, /github-issue:<n>|`github-issue` record|regressed/);
});

test("a pass checks for stranded store writes before it spends anything", () => {
  assert.match(playbook, /\*\*Pass start/);
  assert.match(playbook, /stranded --base/);
});

test("store writes land from a worktree branch through a confirmed PR", () => {
  assert.match(playbook, /chore\/maintenance-findings-<date>/);
  assert.match(playbook, /git worktree add -b/);
  assert.match(playbook, /not landed/);
  assert.match(playbook, /references\/branch\.md` § Committing/);
});
