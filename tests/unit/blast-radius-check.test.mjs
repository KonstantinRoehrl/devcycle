import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const SCRIPT = join(process.cwd(), "scripts/blast-radius-check.mjs");

function makeRepo(files) {
  const dir = realpathSync(makeTempDir("brc-"));
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

test("hard-fails when only a non-test file references the changed file", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "src/consumer.mjs": "import { widget } from './widget.mjs';",
  });
  const r = run(PLAN, repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /consumer\.mjs \(non-test\) references.*widget/s);
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
function planChanging(changedFile, { override, trailingOverride } = {}) {
  const overrideLine = override ? `\n${override}` : "";
  const trailingSection = trailingOverride ? `\n## Blast-radius overrides\n${trailingOverride}\n` : "";
  return `# Plan
### Task 1: Change ${changedFile}
**Files:**
- Modify: \`${changedFile}\`${overrideLine}
## Dispatch Map
- Wave 1: Task 1
${trailingSection}`;
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

test("an override in a plan-level section after the last task clears the hard-fail", () => {
  const plan = planChanging("references/config.md", {
    trailingOverride: "- Blast-radius override: references/config.md — referenced only in a fixture string",
  });
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": '"../references/config.md"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 0, out);
  assert.match(out, /override/i);
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

// F1: the override's changed-file token must go through the same normalization
// (normalizeFileToken) as the declaration side, or a backtick-wrapped path -- exactly how
// planners write paths in a **Files:** block -- never matches and the override is silently
// ignored.
test("an override whose changed-file token is backtick-wrapped still clears the hard-fail (F1)", () => {
  const plan = planChanging("references/config.md", {
    override: "- Blast-radius override: `references/config.md` — referenced only in a fixture string",
  });
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": '"../references/config.md"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 0, out);
  assert.match(out, /override/i); // acknowledged, reason echoed
});

// F3: OVERRIDE_RE's reason group required >=2 characters, so a valid one-character reason was
// wrongly rejected as a malformed override (spec F55: only an empty reason is an error). A
// one-char reason separated from the em-dash by a space ("— x") happens to still match today --
// `\s*—\s*`'s trailing `\s*` backtracks to 0 and donates that space as the reason group's first
// character -- so the discriminating case is the em-dash directly adjacent to the single
// character, with no whitespace left to borrow.
test("a one-character override reason with no space after the em-dash is accepted, not rejected as malformed (F3)", () => {
  const plan = planChanging("references/config.md", {
    override: "- Blast-radius override: references/config.md —x",
  });
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": '"../references/config.md"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 0, out);
  assert.match(out, /override/i);
});

// F1 guard: the `→ <test>` capture is normalized just like the changed-file capture, so a
// pair-form override whose test token is a bare word (no path shape, normalizes to null) is a
// loud malformed error -- not a silent widening of the override to clear every test-referencer
// of the changed file. Without the guard this exits 0 (override acknowledged, widened to file
// scope); with it, exit 1 malformed.
test("a pair-form override whose test token is not a path is malformed, not a silent file-wide clear (F1 guard)", () => {
  const plan = planChanging("references/config.md", {
    override: "- Blast-radius override: references/config.md → config — bogus non-path test token",
  });
  const repo = makeRepo({
    "references/config.md": "# config\n",
    "tests/unit/thing.test.mjs": '"../references/config.md"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 1);
  assert.match(out, /malformed override/i);
});

// An override capture is a token the author named on purpose, so an extensionless file or a
// directory is as valid there as in a Files block -- it was accepted before the Files-block
// grammar learned to tell prose from paths, and must stay so.
test("an override naming an unticked extensionless file is accepted, not malformed", () => {
  const plan = planChanging("bin/devcycle-root", {
    override: "- Blast-radius override: bin/devcycle-root — no referencers matter",
  });
  const repo = makeRepo({
    "bin/devcycle-root": "#!/bin/sh\n",
    "tests/unit/thing.test.mjs": '"../bin/devcycle-root"',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /malformed override/);
  assert.match(out, /override/i);
});

test("a non-test referencer not in any Files block now hard-fails", () => {
  const repo = makeRepo({
    "scripts/foo.mjs": "export const x = 1;\n",
    "scripts/bar.mjs": 'import "./foo.mjs";\n', // non-test referencer, in no Files block
  });
  const { code, out } = run(planChanging("scripts/foo.mjs"), repo);
  assert.equal(code, 1, out);
  assert.match(out, /scripts\/bar\.mjs \(non-test\) references scripts\/foo\.mjs/);
});

test("a non-test referencer is cleared by an override targeting it", () => {
  const plan = planChanging("scripts/foo.mjs", {
    override: "- Blast-radius override: scripts/foo.mjs → scripts/bar.mjs — bar names foo only in a comment",
  });
  const repo = makeRepo({
    "scripts/foo.mjs": "export const x = 1;\n",
    "scripts/bar.mjs": 'import "./foo.mjs";\n',
  });
  const { code, out } = run(plan, repo);
  assert.equal(code, 0, out);
});

test(".worktrees is not walked", () => {
  const repo = makeRepo({
    "scripts/x.mjs": "export const x = 1;\n",
    ".worktrees/c99/tests/unit/x.test.mjs": 'import "../../../scripts/x.mjs";',
  });
  const { code } = run(planChanging("scripts/x.mjs"), repo);
  assert.equal(code, 0);
});

// --- F6: a finding names the task whose Files block declares the changed file ---

test("a finding opens with the task that declares the changed file", () => {
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "src/consumer.mjs": "import { widget } from './widget.mjs';",
  });
  const r = run(PLAN, repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /blast-radius-check: Task 1: src\/consumer\.mjs \(non-test\) references src\/widget\.mjs but is in no task's Files block/);
});

test("a changed file two tasks declare names both tasks", () => {
  // Joined from an array so that no line of this test opens with a heading: a plan quoting this
  // test in a fenced block would otherwise split into extra tasks.
  const plan = [
    "# Plan",
    "### Task 2: Change widget",
    "**Files:**",
    "- Modify: `src/widget.mjs`",
    "### Task 3: Change widget again",
    "**Files:**",
    "- Modify: `src/widget.mjs`",
    "## Dispatch Map",
    "- Wave 1: Task 2",
    "- Wave 2: Task 3",
  ].join("\n") + "\n";
  const repo = makeRepo({
    "src/widget.mjs": "export function widget() {}",
    "src/consumer.mjs": "import { widget } from './widget.mjs';",
  });
  const r = run(plan, repo);
  assert.equal(r.code, 1);
  assert.match(r.out, /blast-radius-check: Tasks 2\+3: src\/consumer\.mjs \(non-test\) references src\/widget\.mjs/);
});

test("the ok line states the gate's real coverage", () => {
  const repo = makeRepo({ "src/widget.mjs": "export function widget() {}" });
  const r = run(PLAN, repo);
  assert.equal(r.code, 0);
  assert.match(r.out, /ok -- every JS\/TS\/Python referencer of a changed file is in a Files block or overridden/);
});

// --- --scan: the planner's advisory pass while deriving a Files block ---

function scan(repo, ...args) {
  const r = spawnSync("node", [SCRIPT, "--scan", ...args, "--root", repo], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const CS_REPO = {
  "src/Shapes/Shape.cs": "namespace Shapes;\npublic abstract class Shape\n{\n    public abstract double Area();\n}\n",
  "src/Shapes/Circle.cs": "namespace Shapes;\npublic class Circle : Shape\n{\n    public override double Area() => 3.14;\n}\n",
  "src/Report.cs": "using Shapes;\nclass Report { void Print(Shape s) {} }\n",
  "tests/ShapeTests.cs": "using Shapes;\nclass ShapeTests { Shape s; }\n",
  "src/Unrelated.cs": "class Unrelated { int Shapely; }\n",
};

test("--scan finds a C# subclass, consumer and test by the declared class name", () => {
  const r = scan(makeRepo(CS_REPO), "src/Shapes/Shape.cs");
  assert.equal(r.code, 0);
  assert.match(r.out, /^src\/Shapes\/Shape\.cs\n {2}symbols: Shape, Area\n {2}Shape\n {4}src\/Report\.cs \(consumer\)\n {4}src\/Shapes\/Circle\.cs \(subclass\)\n {4}tests\/ShapeTests\.cs \(test\)$/m);
  assert.doesNotMatch(r.out, /Unrelated\.cs/);
});

test("--scan matches an import written without the extension", () => {
  const repo = makeRepo({
    "src/foo.ts": "export function makeFoo() {}\n",
    "src/app.ts": "import { thing } from './foo';\n",
  });
  const r = scan(repo, "src/foo.ts");
  assert.equal(r.code, 0);
  assert.match(r.out, /\n {2}foo\n {4}src\/app\.ts \(consumer\)/);
});

test("--scan searches an explicit --symbol the extractor misses, even a short one", () => {
  const repo = makeRepo({
    "src/lib.c": "int add(int a, int b) { return a + b; }\n",
    "src/main.c": "int r = add(1, 2);\n",
  });
  const r = scan(repo, "src/lib.c", "--symbol", "add");
  assert.equal(r.code, 0);
  assert.match(r.out, /symbols: add\n {2}add\n {4}src\/main\.c \(consumer\)/);
});

test("--scan lists stoplisted and short auto-extracted names as skipped and never searches them", () => {
  const repo = makeRepo({
    "src/Program.java": "public class Program {\n  public static void main(String[] a) {}\n  public void run() {}\n}\n",
    "src/Other.java": "class Other { void main() { run(); } }\n",
  });
  const r = scan(repo, "src/Program.java");
  assert.equal(r.code, 0);
  assert.match(r.out, /symbols: Program \(skipped: main, run\)/);
  assert.match(r.out, /no referencers found/);
});

test("--scan classifies a Python subclass and walks languages the gate skips", () => {
  const repo = makeRepo({
    "pkg/base.py": "class BaseHandler:\n    def handle_request(self):\n        pass\n",
    "pkg/impl.py": "from pkg.base import BaseHandler\nclass Impl(BaseHandler):\n    pass\n",
    "cmd/run.go": "package main\n// a bridge\nfunc go_handle_request() {}\n",
  });
  const r = scan(repo, "pkg/base.py");
  assert.equal(r.code, 0);
  assert.match(r.out, /symbols: BaseHandler, handle_request/);
  assert.match(r.out, / {2}BaseHandler\n {4}pkg\/impl\.py \(subclass\)/);
  assert.doesNotMatch(r.out, /cmd\/run\.go/, "a longer identifier containing the name is not a match");
});

test("--scan reports a changed file no referencer names, and one that does not exist yet", () => {
  const repo = makeRepo({ "src/alone.mjs": "export function lonelyThing() {}\n" });
  const r = scan(repo, "src/alone.mjs", "src/created-later.mjs");
  assert.equal(r.code, 0);
  assert.match(r.out, /src\/alone\.mjs\n {2}symbols: lonelyThing\n {2}no referencers found/);
  assert.match(r.out, /src\/created-later\.mjs\n {2}symbols: \(none\)\n {2}no referencers found/);
});

test("--scan with no changed file is a usage error", () => {
  const r = scan(makeRepo({ "a.mjs": "" }));
  assert.equal(r.code, 1);
  assert.match(r.out, /--scan needs at least one changed file\nusage: .*--scan <changed-file>/);
});

test("--scan rejects an unknown flag instead of ignoring it", () => {
  const r = scan(makeRepo({ "a.mjs": "" }), "a.mjs", "--symbols", "x");
  assert.equal(r.code, 1);
  assert.match(r.out, /unrecognised flag --symbols/);
});

test("--scan takes only an ES module's exports, declared inline or in an export list", () => {
  const repo = makeRepo({
    "src/mod.mjs": "function helperWalk() {}\nfunction listedThing() {}\nexport function inlineThing() {}\nexport { listedThing };\n",
    "src/other.mjs": "function helperWalk() {}\n",
  });
  const r = scan(repo, "src/mod.mjs");
  assert.equal(r.code, 0);
  assert.match(r.out, /symbols: listedThing, inlineThing\n/);
  assert.doesNotMatch(r.out, /helperWalk|other\.mjs/);
});
