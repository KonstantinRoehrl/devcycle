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

// The two pre-flight gates read the same taskFileMap, so a plan whose blocks say "none" must send
// the plan author to one repair, not two: blast-radius-check used to report the blocks missing for
// a plan that had written them, while wave-disjointness-check reported them present but empty.
const WAVE_SCRIPT = join(process.cwd(), "scripts/wave-disjointness-check.mjs");
const NO_FILES_DECLARED_PLAN =
  "# Plan\n### Task 1: Declares nothing\n**Files:** none\n\n### Task 2: Also nothing\n**Files:** none\n\n## Dispatch Map\n- Wave 1: Task 1, Task 2\n";

test('a plan whose **Files:** blocks are present but declare no file says so, not "blocks found"', () => {
  const repo = makeRepo({ "src/widget.mjs": "export const a = 1;\n" });
  const { code, out } = run(NO_FILES_DECLARED_PLAN, repo);
  assert.equal(code, 1);
  assert.match(out, /"\*\*Files:\*\*" blocks are present but empty/);
  assert.doesNotMatch(out, /no "\*\*Files:\*\*" blocks found/);
});

test("both gates give the same diagnosis for a plan that declares no file", () => {
  const repo = makeRepo({ "src/widget.mjs": "export const a = 1;\n" });
  const plan = join(repo, "plan.md");
  writeFileSync(plan, NO_FILES_DECLARED_PLAN);
  const blast = spawnSync("node", [SCRIPT, plan, repo], { encoding: "utf8" });
  const wave = spawnSync("node", [WAVE_SCRIPT, plan], { encoding: "utf8" });
  assert.equal(blast.status, 1);
  assert.equal(wave.status, 1);
  const diagnosis = (r) => r.stderr.trim().split("\n").pop().replace(/^\S+-check: /, "");
  assert.equal(diagnosis(blast), diagnosis(wave));
});

// F55: the matcher used to key on the extension-stripped basename ("config", not "config.md"),
// so any file merely containing the word matched -- a false-positive flood. It also walked
// .worktrees, and offered no way for a planner to acknowledge a referencing-but-unaffected test.
function planChanging(changedFile, { override } = {}) {
  const overrideLine = override ? `\n${override}` : "";
  return `# Plan
### Task 1: Change ${changedFile}
**Files:**
- Modify: \`${changedFile}\`${overrideLine}
## Dispatch Map
- Wave 1: Task 1
`;
}

test("matcher does not fire on a bare word -- a suite mentioning 'config' does not reference config.md", () => {
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": "See `config` for details.\n",
  });
  const { code, out } = run(planChanging("references/config.md"), repo);
  assert.equal(code, 0, out);
});

test("matcher fires on a path-shaped reference to the changed file", () => {
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": 'import x from "../references/config.md";\n',
  });
  const { code, out } = run(planChanging("references/config.md"), repo);
  assert.equal(code, 1);
  assert.match(out, /config\.md/);
});

test("a per-task override with a reason clears the hard-fail", () => {
  const plan = planChanging("references/config.md", {
    override: "- Blast-radius override: references/config.md — referenced only in a fixture string",
  });
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": '"../references/config.md"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 0, out);
  assert.match(out, /override/i); // acknowledged, reason echoed
});

test("an override with no reason is itself an error", () => {
  const plan = planChanging("references/config.md", {
    override: "- Blast-radius override: references/config.md",
  });
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": '"../references/config.md"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 1);
  assert.match(out, /malformed override|needs a reason/i);
});

test(".worktrees is not walked", () => {
  const repo = makeRepo({
    "scripts/x.mjs": "export const x = 1;\n",
    ".worktrees/c99/tests/unit/x.test.mjs": 'import "../../../scripts/x.mjs";',
  });
  const { code } = run(planChanging("scripts/x.mjs"), repo);
  assert.equal(code, 0);
});
