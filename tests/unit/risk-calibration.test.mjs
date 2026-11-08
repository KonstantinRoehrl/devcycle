import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BUILTIN_SIGNALS } from "../../scripts/risk-signals.mjs";
import { commitAll, makeRepo, sh, writeInto } from "./helpers.mjs";

const root = process.cwd();
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/risk-calibration.json"), "utf8"));
const SCRIPT = join(root, "scripts/risk-calibration.mjs");

test("the calibration fixture was generated from the current signal patterns", () => {
  const sha = createHash("sha256").update(readFileSync(join(root, "scripts/risk-signals.mjs"))).digest("hex");
  assert.equal(fixture.signalsSha256, sha, "scripts/risk-signals.mjs changed: rerun node scripts/risk-calibration.mjs --write over the corpus");
});

test("every repo in the corpus asks on at most the ceiling's share of its branches", () => {
  assert.deepEqual([fixture.bar, fixture.ceiling], [0.25, 0.3]);
  assert.ok(fixture.repos.length >= 3, "the corpus is devcycle plus the two private repos");
  for (const r of fixture.repos) {
    assert.equal(r.total, r.branches.length, r.label);
    assert.equal(r.asked, r.branches.filter((b) => b.signals.length).length, r.label);
    assert.equal(r.askRate, Math.round((r.asked / r.total) * 1000) / 1000, r.label);
    assert.ok(r.askRate <= fixture.ceiling, `${r.label} asks on ${r.askRate} of its branches, over ${fixture.ceiling}`);
  }
});

test("private repos are anonymous in the fixture, and every signal id is a built-in", () => {
  const ids = new Set(BUILTIN_SIGNALS.map((s) => s.id));
  for (const r of fixture.repos) {
    for (const b of r.branches) {
      assert.match(b.sha, /^[0-9a-f]{7}$/);
      for (const id of b.signals) assert.ok(ids.has(id), id);
      if (/^private-\d+$/.test(r.label)) assert.deepEqual(Object.keys(b).sort(), ["sha", "signals"], `${r.label} leaks more than a sha`);
    }
  }
});

test("CLI: scans first-parent commits with built-ins only and prints the ask-rate", () => {
  const dir = makeRepo();
  writeInto(dir, "README.md", "x\n");
  commitAll(dir, "base");
  writeInto(dir, "hooks/guard.mjs", "export {};\n");
  commitAll(dir, "add a hook");
  writeInto(dir, "src/a.js", "1\n");
  commitAll(dir, "plain change");
  writeInto(dir, ".claude/devcycle-risk.json", JSON.stringify({ quiet: [{ signal: "hooks-guards", reason: "ignored by calibration" }] }));
  commitAll(dir, "a repo file calibration must ignore");
  const r = spawnSync("node", [SCRIPT, "--repo", `private-9,main,${dir}`, "--limit", "3"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^private-9\s+main\s+asked 1 of 3 \(0\.333\)$/m);
  assert.doesNotMatch(r.stdout, /add a hook/, "a private label prints no subject");
});
