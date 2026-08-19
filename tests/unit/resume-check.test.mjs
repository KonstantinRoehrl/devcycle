import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/resume-check.mjs");
const run = (statePath) => spawnSync("node", [SCRIPT, "--state", statePath], { encoding: "utf8" });

function makeState(dir, lines) {
  const p = join(dir, "state.md");
  writeFileSync(p, "# devcycle state\n" + lines.join("\n") + "\n", "utf8");
  return p;
}

test("passes when stage is valid and every named artifact exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "spec.md"), "x");
  const state = makeState(dir, [
    "- stage: planning",
    `- root: ${dir}`,
    "- spec: docs/spec.md",
    "- plan: <tbd>",
    "- checklist: none",
  ]);
  const r = run(state);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  rmSync(dir, { recursive: true, force: true });
});

test("fails when a named artifact path is missing on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  const state = makeState(dir, [
    "- stage: execution",
    `- root: ${dir}`,
    "- spec: docs/gone.md",
    "- plan: docs/also-gone.md",
    "- checklist: none",
  ]);
  const r = run(state);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /docs\/gone\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("fails on an invalid stage enum value", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  const state = makeState(dir, [
    "- stage: bogus",
    `- root: ${dir}`,
    "- spec: none",
    "- plan: none",
    "- checklist: none",
  ]);
  const r = run(state);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /stage/i);
  rmSync(dir, { recursive: true, force: true });
});
