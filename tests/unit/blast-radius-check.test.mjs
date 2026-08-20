import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/blast-radius-check.mjs");

function makeRepo(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "brc-")));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function run(planText, repo) {
  const plan = join(repo, "plan.md");
  writeFileSync(plan, planText);
  const r = spawnSync("node", [SCRIPT, plan, repo], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const PLAN = `# Plan
### Task 1: Change widget
**Files:**
- Modify: \`src/widget.mjs\`
## Dispatch Map
- Wave 1: Task 1
`;

test("hard-fails when an unlisted TEST file references the changed file", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "tests/unit/widget.test.mjs": "import { widget } from '../../src/widget.mjs';",
  });
  const r = run(PLAN, repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /widget\.test\.mjs.*references/s);
});

test("warns (exit 0) when only a non-test file references the changed file", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "src/consumer.mjs": "import { widget } from './widget.mjs';",
  });
  const r = run(PLAN, repo);
  assert.equal(r.code, 0);
  assert.match(r.out, /consumer\.mjs.*references.*widget/s);
});

test("does not hard-fail when a test file only mentions the basename in prose (no import)", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "tests/unit/unrelated.test.mjs": "// mentions widget in prose\nexport const x = 1;",
  });
  const r = run(PLAN, repo);
  assert.equal(r.code, 0);
});

test("passes when the referencing test file is already in a Files block", () => {
  const plan = PLAN.replace("- Modify: `src/widget.mjs`", "- Modify: `src/widget.mjs`\n- Test: `tests/unit/widget.test.mjs`");
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "tests/unit/widget.test.mjs": "import { widget } from '../../src/widget.mjs';",
  });
  const r = run(plan, repo);
  assert.equal(r.code, 0);
  assert.match(r.out, /ok/);
});

test("a plan with no task headings is an error, not an ok", () => {
  const repo = makeRepo({ "src/widget.mjs": "export const a = 1;\n" });
  const { code, out } = run("# Prose only, no tasks\n", repo);
  assert.equal(code, 1);
  assert.match(out, /no "### Task N" blocks found/);
});

test("a plan whose tasks carry no **Files:** block is an error, not an ok", () => {
  const repo = makeRepo({ "src/widget.mjs": "export const a = 1;\n" });
  const { code, out } = run(
    "# Plan\n### Task 1: No files block\n**Interfaces:** none\n## Dispatch Map\n- Wave 1: Task 1\n",
    repo,
  );
  assert.equal(code, 1);
  assert.match(out, /no "\*\*Files:\*\*" blocks found/);
});

const INLINE_PLAN = `# Plan
### Task 1: Change widget
**Files:** Modify \`src/widget.mjs\`, Test: \`tests/unit/widget.test.mjs\`
## Dispatch Map
- Wave 1: Task 1
`;

test("a Files field written inline on its own label line is read, not reported as missing", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "tests/unit/widget.test.mjs": "import { widget } from '../../src/widget.mjs';",
  });
  const r = run(INLINE_PLAN, repo);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok/);
});

test("an unlisted test consumer is still a hard failure when the Files field is inline", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "tests/unit/widget.test.mjs": "import { widget } from '../../src/widget.mjs';",
  });
  const r = run("# Plan\n### Task 1: Change widget\n**Files:** Modify `src/widget.mjs`\n## Dispatch Map\n- Wave 1: Task 1\n", repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /widget\.test\.mjs.*references/s);
});
