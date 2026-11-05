// scripts/brief-facts-check.mjs: what a plan's briefs cite resolves before anything is dispatched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/brief-facts-check.mjs", import.meta.url).pathname;
const TEN = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
const task = (n, body) => `### Task ${n}: Thing ${n}\n\n${body}\n\n`;

function run(planText, { repo = realpathSync(makeTempDir("bfc-")), files = {} } = {}) {
  for (const [path, text] of Object.entries(files)) writeInto(repo, path, text);
  const plan = join(repo, "plan.md");
  writeFileSync(plan, planText);
  const r = spawnSync(process.execPath, [SCRIPT, plan, repo], { encoding: "utf8", cwd: repo });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a missing Modify path fails, naming the task; a task that creates it clears it", () => {
  const modify = task(1, "**Files:**\n- Modify: `src/gone.mjs`");
  const r = run(modify);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^brief-facts-check: Task 1: cites src\/gone\.mjs — not in the working tree and no task creates it$/m);
  assert.equal(run(modify + task(2, "**Files:**\n- Create: `src/gone.mjs`")).code, 0);
});

test("a new test file under Test: counts as created, for its own task and for a later citation", () => {
  assert.equal(run(task(1, "**Files:**\n- Modify: `src/a.mjs`\n- Test: `tests/unit/new.test.mjs`"), { files: { "src/a.mjs": "" } }).code, 0);
  assert.equal(run(task(1, "**Files:**\n- Test: `tests/unit/new.test.mjs`") + task(2, "see `tests/unit/new.test.mjs:3`")).code, 0);
});

test("a Files path never falls back to the plugin root, even one the plugin ships", () => {
  for (const path of ["scripts/plan-check.mjs", "references/evidence.md"]) {
    const r = run(task(1, `**Files:**\n- Modify: \`${path}\``));
    assert.equal(r.code, 1, `${path}\n${r.out}`);
  }
});

test("a missing path outside every task block is the plan's own finding", () => {
  const r = run(`# P\n\nsee \`docs/gone.md\`\n\n${task(1, "x")}`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^brief-facts-check: Plan: cites docs\/gone\.md — not in the working tree/m);
});

test("a line past the end fails in a code span and in plain prose; a line within it passes", () => {
  const files = { "scripts/x.mjs": TEN };
  for (const prose of ["see `scripts/x.mjs:9999`", "see scripts/x.mjs:9999 (verified: wc -l)", "see `scripts/x.mjs:3-11`"]) {
    const r = run(task(1, prose), { files });
    assert.equal(r.code, 1, `${prose}\n${r.out}`);
    assert.match(r.out, /Task 1: cites scripts\/x\.mjs:(9999|11) — the file has 10 lines/, prose);
  }
  assert.equal(run(task(1, "see `scripts/x.mjs:10` and scripts/x.mjs:1-10"), { files }).code, 0);
});

test("a trailing newline adds no line, and a last line without one still counts", () => {
  const files = { "a/two.txt": "a\nb", "a/one.txt": "a\n" };
  assert.equal(run(task(1, "`a/two.txt:2` and `a/one.txt:1`"), { files }).code, 0);
  assert.match(run(task(1, "`a/one.txt:2`"), { files }).out, /cites a\/one\.txt:2 — the file has 1 lines/);
});

test("a placeholder, glob, URL, import specifier, home or absolute path and a gitignored runtime path are never cited", () => {
  const repo = makeRepo();
  writeInto(repo, ".gitignore", ".devcycle/\n");
  const prose = "`src/<name>.mjs`, `tests/unit/*.test.mjs`, `https://x.dev/a/b.md`, `../../scripts/x.mjs`, " +
    "`./task-files.mjs`, `~/notes/a.md`, `/etc/a.conf`, `$HOME/a.md`, `.devcycle/reports/3.md`";
  const r = run(task(1, prose), { repo });
  assert.equal(r.code, 0, r.out);
});

test("a prefixed plugin path resolves under the plugin root; a bare one only inside a grammar directory", () => {
  for (const prose of ["`${CLAUDE_PLUGIN_ROOT}/references/evidence.md`", '`"$(devcycle-root)/scripts/plan-check.mjs"`', "`references/evidence.md`"])
    assert.equal(run(task(1, prose)).code, 0, prose);
  assert.equal(run(task(1, "`scripts/plan-check.mjs`")).code, 1);
  assert.equal(run(task(1, "`${CLAUDE_PLUGIN_ROOT}/references/no-such.md`")).code, 1);
});

test("a reasoned Citation override clears a missing path; a reasonless one is a finding", () => {
  const body = task(1, "**Files:**\n- Modify: `src/gone.mjs`") + "## Plan-check overrides\n\n";
  const cleared = run(`${body}- Citation override: src/gone.mjs — the host generates it at build time\n`);
  assert.equal(cleared.code, 0, cleared.out);
  const bare = run(`${body}- Citation override: src/gone.mjs\n`);
  assert.equal(bare.code, 1, bare.out);
  assert.match(bare.out, /malformed Citation override/);
});

test("an unresolved call-shaped span is a note, never a finding; a tracked or plan-defined one is not, and no repo means no note", () => {
  const repo = makeRepo();
  writeInto(repo, "src/real.mjs", "export function realThing() {}\n");
  const r = run(task(1, "call `fooBar()`, `realThing(x)` and `made()`\n\n(unrun: shape only)\n```js\nfunction made() {}\n```"), { repo });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^brief-facts-check: note: Task 1: names fooBar\(\) — /m);
  assert.doesNotMatch(r.out, /realThing|names made/);
  assert.doesNotMatch(run(task(1, "call `fooBar()`")).out, /note:/);
});
