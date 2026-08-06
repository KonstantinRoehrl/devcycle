// Golden path — structural, deterministic, node-only. This fixture asserts that the
// pipeline's artifacts and wiring hold together across every stage transition. It does NOT
// exercise model behaviour; nothing here proves a stage produces good output.
//
// Why a new file rather than an existing one: every other suite under tests/unit/ is scoped
// to one script (validate, doctor, redaction-check, ...), whereas these assertions cut
// across the whole surface — commands, playbooks, references, agents and workflows — and
// belong to no single script. Adding new scenario assertions here is the intended path:
// they go in this file rather than a parallel golden-path suite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");

const stages = (read("commands/cycle.md").match(/stage:\s*<([a-z|-]+)>/)?.[1] ?? "").split("|").filter(Boolean);

test("the stage enum is non-empty and every stage is lowercase-kebab", () => {
  assert.ok(stages.length > 0, "no stage enum found in commands/cycle.md");
  for (const s of stages) assert.match(s, /^[a-z][a-z-]*$/);
});

test("continue's stage table covers every stage in the enum", () => {
  const table = read("commands/continue.md");
  for (const s of stages) assert.match(table, new RegExp(`\\b${s}\\b`), `continue.md does not handle stage "${s}"`);
});

test("every playbook path referenced anywhere in the surface resolves", () => {
  for (const dir of ["commands", "playbooks", "references", "agents"])
    for (const f of readdirSync(join(root, dir))) {
      if (!f.endsWith(".md")) continue;
      const text = read(`${dir}/${f}`);
      for (const [, target] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(playbooks\/[A-Za-z0-9._-]+\.md)/g))
        assert.ok(existsSync(join(root, target)), `${dir}/${f} references missing ${target}`);
    }
});

test("the state fixture round-trips through every stage", () => {
  const template = readFileSync(join(root, "tests/fixtures/golden-path/state.md"), "utf8");
  for (const s of stages) {
    const next = template.replace(/^- stage: .*$/m, `- stage: ${s}`);
    assert.match(next, /^- stage: /m);
    assert.match(next, /^- root: /m);
    assert.match(next, /^- branch: /m);
    assert.equal(next.match(/^- stage: /gm).length, 1, `stage line duplicated at ${s}`);
  }
});

test("the loop-status line format parses for all three statuses", () => {
  const shape = /^status: (resolved|exhausted-with-residue|exhausted-unresolved) rounds: \d+\/\d+ residue: (\d+|none) carried-to: \S+$/;
  assert.match("status: resolved rounds: 1/3 residue: none carried-to: none", shape);
  assert.match("status: exhausted-with-residue rounds: 3/3 residue: 4 carried-to: docs/audits/2026-08-06-disposition-register.md", shape);
  assert.match("status: exhausted-unresolved rounds: 2/2 residue: 1 carried-to: none", shape);
  assert.ok(read("references/loops.md").includes("exhausted-with-residue"), "references/loops.md must own the status vocabulary");
});

test("the ledger fixture's every line parses as a ledger event", () => {
  const shape = /^- \[\d{4}-\d{2}-\d{2}T[\d:]+Z\] task=\S+ event=\S+ outcome=.* ref=\S+$/;
  for (const line of readFileSync(join(root, "tests/fixtures/golden-path/ledger.md"), "utf8").split("\n"))
    if (line.startsWith("- [")) assert.match(line, shape);
});

test("scoping states the batched-questions contract", () => {
  assert.match(read("playbooks/scoping-the-request.md"), /batches of 1[–-]4/);
});

test("every bounded loop names a cap", () => {
  for (const f of ["executing-waves", "taking-the-fast-path", "sweeping-mechanical-changes", "learning-from-sessions"])
    assert.match(read(`playbooks/${f}.md`), /Cap: \d+/, `playbooks/${f}.md declares no cap`);
});

// The green-gate invariant: a `committed` ledger event must carry the gate's outcome, so a
// commit can never be recorded without the gate having been read.
test("a committed ledger event carries the green-gate outcome", () => {
  const ledger = readFileSync(join(root, "tests/fixtures/golden-path/ledger.md"), "utf8");
  for (const line of ledger.split("\n"))
    if (line.includes("event=committed")) assert.match(line, /outcome=green gate passed/);
  assert.match(read("playbooks/executing-waves.md"), /green gate/i);
});

// The no-direct-push invariant: no workflow may push to the release branch.
test("no workflow pushes to the release branch", () => {
  for (const f of readdirSync(join(root, ".github/workflows"))) {
    const text = read(`.github/workflows/${f}`);
    assert.doesNotMatch(text, /git push\s+\S*origin\s+main\b/, `${f} pushes main directly`);
    assert.doesNotMatch(text, /branch:\s*main\b/, `${f} targets main directly`);
  }
});
