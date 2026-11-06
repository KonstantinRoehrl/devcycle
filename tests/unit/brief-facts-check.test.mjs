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

test("a Files annotation, glob, home path or bare directory is never cited, while a real missing Files path still is", () => {
  const annotation = "- Modify: `a.json` (drop `dispatch.toolCalls` from `required`;\n  keep `stage.path` and state.md alone)";
  for (const entry of [annotation, "- Modify: tests/unit/*.mjs", "- Modify: `tests/*.test.mjs`", "- Modify: `~/.claude/projects/x/y.md`", "- Modify: skills/"]) {
    const r = run(task(1, `**Files:**\n${entry}`), { files: { "a.json": "{}" } });
    assert.equal(r.code, 0, `${entry}\n${r.out}`);
  }
  for (const missing of ["scripts/missing.mjs", "README-missing.md"]) {
    const r = run(task(1, `**Files:**\n- Modify: \`${missing}\` (see \`dispatch.toolCalls\`)`));
    assert.equal(r.code, 1, `${missing}\n${r.out}`);
    assert.match(r.out, new RegExp(`Task 1: cites ${missing.replace(".", "\\.")} — not in the working tree`));
    assert.doesNotMatch(r.out, /dispatch\.toolCalls/);
  }
});

test("a missing Delete or Rename path and a path outside the prose-span charset are still cited", () => {
  for (const entry of ["- Delete: `src/gone/old.mjs`", "- Delete: src/gone/old.mjs", "- Rename: src/old.mjs to src/new.mjs", "- Modify: `app/(shop)/page.tsx`", "- Modify: `packages/@scope/pkg/index.ts`", "- Modify: `docs/café.md`"]) {
    const r = run(task(1, `**Files:**\n${entry}`));
    assert.equal(r.code, 1, `${entry}\n${r.out}`);
  }
});

test("a missing root-level Delete or Rename file is cited, but a slash-bearing word in an annotation is not", () => {
  for (const entry of ["- Delete: old.md", "- Delete: `CHANGELOG.old.md`", "- Rename: old.md to new.md"]) {
    const r = run(task(1, `**Files:**\n${entry}`));
    assert.equal(r.code, 1, `${entry}\n${r.out}`);
  }
  for (const note of ["(set `Content-Type` to `application/json`)", "(e.g. `i/o`)", "(bump v1.2/v1.3)"]) {
    const r = run(task(1, `**Files:**\n- Modify: \`a.json\` ${note}`), { files: { "a.json": "{}" } });
    assert.equal(r.code, 0, `${note}\n${r.out}`);
  }
});

test("a Files entry that is a placeholder, URL or absolute path is never cited", () => {
  for (const entry of ["src/<name>.mjs", "a/b?.mjs", "https://x.dev/a/b.md", "/etc/a.conf"]) {
    const r = run(task(1, `**Files:**\n- Delete: ${entry}`));
    assert.equal(r.code, 0, `${entry}\n${r.out}`);
  }
});

test("a Delete path in a grammar directory is a host file: the plugin root never answers for it", () => {
  const r = run(task(1, "**Files:**\n- Delete: `references/evidence.md`"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: cites references\/evidence\.md — not in the working tree/);
});

test("a Test-labelled new file stays created beside an annotated Files line", () => {
  const files = "**Files:**\n- Modify: `a.json` (drop `dispatch.toolCalls`)\n- Test: `tests/unit/new.test.mjs`";
  assert.equal(run(task(1, files), { files: { "a.json": "{}" } }).code, 0);
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

// --- #314: a fenced block pinned in a task's brief says whether it was run ---

const pinned = (above, info = "js") => task(1, `${above}\n\n\`\`\`${info}\nconst x = 1;\n\`\`\``);

test("an unmarked js block in a task fails, naming its language and plan line", () => {
  const r = run(pinned("- [ ] **Step 1: write it**"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^brief-facts-check: Task 1: pinned js block at plan line 5 has no \(verified: <cmd>\) or \(unrun: <reason>\) marker on the nearest line above it$/m);
});

test("(verified: …) or a reasoned (unrun: …) on the nearest non-blank line above clears the block", () => {
  for (const above of ["- [ ] **Step 1** (verified: node --test x → 3 pass)", "- [ ] **Step 1** (unrun: needs Task 2's export)"])
    assert.equal(run(pinned(above)).code, 0, above);
});

test("an empty (unrun: ), an (assumption), a marker below the block and one two lines up all fail", () => {
  assert.match(run(pinned("- [ ] step (unrun: )")).out, /pinned js block at plan line 5 has an \(unrun:\) marker with no reason/);
  assert.equal(run(pinned("- [ ] step (assumption)")).code, 1);
  assert.equal(run(task(1, "- [ ] step\n\n```js\nx;\n```\n(verified: node x.mjs)")).code, 1);
  assert.equal(run(task(1, "(verified: node x.mjs)\n- [ ] step\n\n```js\nx;\n```")).code, 1);
});

test("text and markdown blocks are exempt, an untagged block is not, and a block outside every task is never checked", () => {
  for (const info of ["text", "txt", "markdown", "md"]) assert.equal(run(pinned("- [ ] step", info)).code, 0, info);
  assert.match(run(pinned("- [ ] step", "")).out, /pinned untagged block at plan line 5/);
  assert.equal(run(`# P\n\n\`\`\`js\nx;\n\`\`\`\n\n${task(1, "x")}`).code, 0);
});
