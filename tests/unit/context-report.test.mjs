// scripts/context-report.mjs: per-entry-point closures, and the over-demotion worklist since a ref.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeRepo, commitAll, writeInto } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/context-report.mjs", import.meta.url));
const P = "${CLAUDE_PLUGIN_ROOT}";
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

const seed = (dir) => {
  writeInto(dir, "commands/go.md", `Follow \`${P}/playbooks/a.md\`.\n`);
  writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`; \`${P}/references/y.md\` owns the rest.\n`);
  writeInto(dir, "references/x.md", "x words here\n");
  writeInto(dir, "references/y.md", "y words\n");
};

test("--json reports both closures for every command and playbook", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    const r = run(dir, "--json");
    assert.equal(r.status, 0, r.stderr);
    const { entries } = JSON.parse(r.stdout);
    const go = entries.find((e) => e.file === "commands/go.md");
    assert.deepEqual([go.refsOnly.files, go.allHops.files], [1, 4]);
    const a = entries.find((e) => e.file === "playbooks/a.md");
    assert.equal(a.refsOnly.files, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--diff lists each citation that lost its prefix, with its bare lines, and each file that left a closure", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`.\n\n\`references/y.md\` owns the rest.\n`);
    const r = run(dir, "--json", "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    const { diff } = JSON.parse(r.stdout);
    assert.deepEqual(diff.lostPrefixes, [{ file: "playbooks/a.md", target: "references/y.md", before: 1, after: 0, bareLines: [3] }]);
    const a = diff.dropped.find((d) => d.file === "playbooks/a.md");
    assert.deepEqual(a.refsOnly, ["references/y.md"]);
    assert.deepEqual(a.allHops, ["references/y.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("text output names the totals and the diff sections", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    commitAll(dir, "seed");
    writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\`.\n`);
    const r = run(dir, "--diff", "HEAD");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /playbooks\/a\.md {2}refs-only: 2 files \/ \d+ words \/ \d+ bytes {3}all-hops: 2 files \/ \d+ words/);
    assert.match(r.stdout, /lost prefixes since HEAD:/);
    assert.match(r.stdout, /dropped from closures since HEAD:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown ref, or --diff with no value, is a usage error", () => {
  const dir = makeRepo();
  try {
    seed(dir);
    const bad = run(dir, "--diff", "no-such-ref");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /context-report: .*no-such-ref/);
    const empty = run(dir, "--diff");
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /--diff requires a git ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
