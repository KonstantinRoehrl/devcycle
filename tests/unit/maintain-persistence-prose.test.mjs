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

test("the playbook has a persistence step naming the store, verifyMaintenance, and docTrackingPolicy", () => {
  assert.match(playbook, /maintenance-findings/);
  assert.match(playbook, /verifyMaintenance/);
  assert.match(playbook, /docTrackingPolicy/);
});

test("the playbook renders the three longitudinal sections and the lens-cost rollup", () => {
  assert.match(playbook, /Previously known \(persisting\)/);
  assert.match(playbook, /Resolved since last pass/);
  assert.match(playbook, /Trending/);
  assert.match(playbook, /lens-cost/);
});

test("the playbook keeps dismissal load-bearing and the read-only store boundary", () => {
  assert.match(playbook, /load-bearing/);
  assert.match(playbook, /never auto-re-evaluated|not automatically re-evaluated|stays dismissed/);
});

test("the playbook deletes resolved findings rather than persisting them", () => {
  assert.match(playbook, /removeMaintenanceFinding/);
  assert.match(playbook, /deleted, not written/);
  assert.match(playbook, /never accumulates settled history/);
});
