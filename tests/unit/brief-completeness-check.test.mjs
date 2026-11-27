import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { taskFileMap } from "../../scripts/task-files.mjs";
import { guardDenialNotes } from "../../scripts/brief-completeness-check.mjs";

const SCRIPT = join(process.cwd(), "scripts/brief-completeness-check.mjs");

// Runs from a scratch work tree, so the real repo's required-checks manifest and gate rules never
// apply; `manifest` and `rules` write one at that tree's root. Both streams are kept on success too:
// notes go to stderr.
function run(planText, { manifest, rules } = {}) {
  const dir = realpathSync(makeTempDir("bcc-"));
  const plan = join(dir, "plan.md");
  writeFileSync(plan, planText);
  if (manifest) {
    mkdirSync(join(dir, "tests/fixtures"), { recursive: true });
    writeFileSync(join(dir, "tests/fixtures/required-gate-checks.json"), manifest);
  }
  if (rules) {
    mkdirSync(join(dir, "tests/fixtures"), { recursive: true });
    writeFileSync(join(dir, "tests/fixtures/gate-rules.json"), rules);
  }
  const r = spawnSync("node", [SCRIPT, plan], { encoding: "utf8", cwd: dir });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const COMPLETE = `# Plan
**Verification gate:** \`npm test\`
### Task 1: Thing
**Files:**
- Create: \`a.mjs\`
**Interfaces:**
- Consumes: nothing.
**Dependencies:** none (completely independent)
**Evidence:** red-green
**Quality constraints:** none
**Lessons:**
- [ ] Write a minimal stub for \`a.mjs\`
- [ ] step
\`\`\`js
test("x", () => {});
\`\`\`
## Dispatch Map
- Wave 1: Task 1 (no deps)
`;

test("passes a complete brief", () => {
  const r = run(COMPLETE);
  assert.equal(r.code, 0);
  assert.match(r.out, /ok/);
});

test("fails when Dependencies is missing", () => {
  const r = run(COMPLETE.replace("**Dependencies:** none (completely independent)\n", ""));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: missing \*\*Dependencies:\*\* field/);
});

test("fails on an invalid Evidence class", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** maybe-tested"));
  assert.equal(r.code, 1);
  assert.match(r.out, /valid class/);
});

test("fails when a task is absent from the Dispatch Map", () => {
  const r = run(COMPLETE.replace("- Wave 1: Task 1 (no deps)", "- Wave 1: (none)"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: not listed in the ## Dispatch Map/);
});

test("fails on an Evidence value that merely starts with a valid class name", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** conventionally-wrong-class"));
  assert.equal(r.code, 1);
  assert.match(r.out, /valid class/);
});

test("passes a valid Evidence class with a parenthetical suffix", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** convention (`node test`)"));
  assert.equal(r.code, 0);
  assert.match(r.out, /ok/);
});

test("fails a convention parenthetical that is not exactly one code span holding the gate command", () => {
  for (const evidence of [
    "convention (whole-gate green-before/green-after)",
    "convention (node test)",
    "convention (`node a.mjs` then `node b.mjs`)",
    "convention (`{ node test; } > .devcycle/evidence/1-after.txt 2>&1`)",
    "convention",
  ]) {
    const r = run(COMPLETE.replace("**Evidence:** red-green", `**Evidence:** ${evidence}`));
    assert.equal(r.code, 1, evidence);
    assert.match(r.out, /Task 1: \*\*Evidence:\*\* convention must carry its gate command as exactly one code span, .*got: .*references\/evidence\.md § The three evidence classes/, evidence);
  }
});

const TWO_TASK = `# Plan
### Task 1: Thing
**Files:**
- Create: \`a.mjs\`
**Interfaces:**
- Consumes: nothing.
**Dependencies:** none (completely independent)
**Evidence:** red-green
**Quality constraints:** none
**Lessons:**
- [ ] step
### Task 2: Other
**Files:**
- Create: \`b.mjs\`
**Interfaces:**
- Consumes: nothing.
**Dependencies:** none (completely independent)
**Evidence:** red-green
**Quality constraints:** none
**Lessons:**
- [ ] step
## Dispatch Map
- Wave 1: Task 1
- Wave 2: Task 1 (needs Task 2)
`;

test("fails when a task appears only inside another wave's dependency parenthetical, never assigned to a wave itself", () => {
  const r = run(TWO_TASK);
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 2: not listed in the ## Dispatch Map/);
});

test("fails when a required field is present but blank", () => {
  const r = run(COMPLETE.replace("**Dependencies:** none (completely independent)", "**Dependencies:**"));
  assert.equal(r.code, 1);
  assert.match(r.out, /\*\*Dependencies:\*\* field is empty/);
});

const INLINE_FILES = COMPLETE.replace("**Files:**\n- Create: `a.mjs`", "**Files:** Create `a.mjs`");

test("the Files field this gate accepts is the same one the plan gates parse", () => {
  // One grammar owns **Files:**. If this gate accepts a declaration the shared owner cannot see,
  // a plan passes brief-completeness and then dies in wave-disjointness on a "no blocks found".
  const r = run(INLINE_FILES);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([...(taskFileMap(INLINE_FILES).get(1) ?? new Set())], ["a.mjs"]);
});

test("a missing Files field is still named as missing", () => {
  const r = run(COMPLETE.replace("**Files:**\n- Create: `a.mjs`\n", ""));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: missing \*\*Files:\*\* field/);
});

test("a Files field present but blank is still named as empty", () => {
  const r = run(COMPLETE.replace("**Files:**\n- Create: `a.mjs`", "**Files:**"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Files:\*\* field is empty/);
});

test("a mid-line mention of the Files label is not a Files field -- the shared-owner delegation, pinned", () => {
  // readField hands **Files:** to task-files.mjs, whose grammar anchors the label to line start;
  // this gate's own generic field regex does not. So a brief that only mentions the label in
  // prose reads as a present, non-empty field the moment that delegation is reverted.
  const prose = COMPLETE.replace(
    "**Files:**\n- Create: `a.mjs`\n",
    "Every task's **Files:** list is authoritative.\n",
  );
  const r = run(prose);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: missing \*\*Files:\*\* field/);
});

// The gate-rules join: a brief that mandates doc growth but never lists the baseline that
// growth trips sends the implementer into a validate.mjs failure the brief itself caused.
// The join is owned by gate-rules-check.mjs and read from the repo's rules file, here devcycle's
// own; this gate runs it so the first scripted check a planner runs already names the missing fixture.
const RULES = readFileSync(new URL("../fixtures/gate-rules.json", import.meta.url), "utf8");

const SURFACE_EDIT = COMPLETE.replace("- Create: \`a.mjs\`", "- Modify: \`playbooks/planning-waves.md\`");

test("fails when a task edits a budgeted surface file but omits the baseline fixtures that edit trips", () => {
  const r = run(SURFACE_EDIT, { rules: RULES });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: .*playbooks\/planning-waves\.md.*tests\/fixtures\/surface-budget\.json/);
  assert.match(r.out, /Task 1: .*playbooks\/planning-waves\.md.*tests\/fixtures\/context-budget\.json/);
});

test("fails when a task edits a command but omits the context baseline every entry point declares", () => {
  const r = run(
    COMPLETE.replace(
      "- Create: \`a.mjs\`",
      "- Modify: \`commands/continue.md\`\n- Modify: \`tests/fixtures/surface-budget.json\`\n- Modify: \`docs/decisions/README.md\`",
    ),
    { rules: RULES },
  );
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: .*commands\/continue\.md.*tests\/fixtures\/context-budget\.json/);
});

test("passes once the surface edit lists both baseline fixtures and the decisions log that records them", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Modify: \`tests/fixtures/surface-budget.json\`\n- Modify: \`tests/fixtures/context-budget.json\`\n- Modify: \`docs/decisions/README.md\`",
    ),
    { rules: RULES },
  );
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok/);
});

test("passes the same surface edit in a repo with no rules file", () => {
  const r = run(SURFACE_EDIT);
  assert.equal(r.code, 0, r.out);
});

test("honours the same Gate-rule override grammar the plan gate reads", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Gate-rule override: playbooks/planning-waves.md — copy-only, no growth",
    ),
    { rules: RULES },
  );
  assert.equal(r.code, 0, r.out);
});

test("reports a reasonless Gate-rule override as malformed rather than silently ignoring it", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Gate-rule override: playbooks/planning-waves.md",
    ),
    { rules: RULES },
  );
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /malformed override/i);
});

test("names the missing file's own reason and keys the suggested override on it, never on the edited surface file", () => {
  const r = run(
    SURFACE_EDIT.replace(
      "- Modify: \`playbooks/planning-waves.md\`",
      "- Modify: \`playbooks/planning-waves.md\`\n- Modify: \`tests/fixtures/surface-budget.json\`\n- Modify: \`tests/fixtures/context-budget.json\`",
    ),
    { rules: RULES },
  );
  assert.equal(r.code, 1, r.out);
  assert.match(
    r.out,
    /Task 1: \*\*Files:\*\* edits playbooks\/planning-waves\.md but its Files omit docs\/decisions\/README\.md — add it \(every fixture change needs a budget: line there\) or record a "- Gate-rule override: docs\/decisions\/README\.md — <reason>"/,
  );
  assert.doesNotMatch(r.out, /size baseline|override: playbooks\//);
});

test("fails a plan with no **Verification gate:** header line", () => {
  const r = run(COMPLETE.replace("**Verification gate:** `npm test`\n", ""));
  assert.equal(r.code, 1);
  assert.match(r.out, /missing \*\*Verification gate:\*\* line in the plan header/);
});

test("fails a **Verification gate:** value that is not exactly one code span", () => {
  const bare = run(COMPLETE.replace("`npm test`", "npm test"));
  assert.equal(bare.code, 1);
  assert.match(bare.out, /\*\*Verification gate:\*\* must be exactly one backtick-quoted command, got: npm test/);
  const two = run(COMPLETE.replace("`npm test`", "`npm test` && `npm run lint`"));
  assert.equal(two.code, 1);
  assert.match(two.out, /must be exactly one backtick-quoted command/);
});

test("a **Verification gate:** line inside a task block is not the header's", () => {
  const r = run(COMPLETE.replace("**Verification gate:** `npm test`\n", "").replace("**Lessons:**\n", "**Lessons:**\n**Verification gate:** `npm test`\n"));
  assert.equal(r.code, 1);
  assert.match(r.out, /missing \*\*Verification gate:\*\* line/);
});

// --- #322: the required-checks manifest, held at plan time ---

const MANIFEST = JSON.stringify(["validate.mjs", "redaction-check.mjs"]);
const FULL_GATE = "node scripts/validate.mjs && node scripts/redaction-check.mjs && npm test";
const GATED = COMPLETE.replace("`npm test`", `\`${FULL_GATE}\``);

test("fails a convention task whose command omits a required check, naming the task and the check", () => {
  const r = run(GATED.replace("**Evidence:** red-green", "**Evidence:** convention (`node scripts/validate.mjs`)"), { manifest: MANIFEST });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: convention command `node scripts\/validate\.mjs` omits required gate check "redaction-check\.mjs" \(tests\/fixtures\/required-gate-checks\.json\) — .*references\/evidence\.md § File-backed evidence/);
  assert.doesNotMatch(r.out, /"validate\.mjs"/);
});

test("passes a convention task that pins the full gate", () => {
  const r = run(GATED.replace("**Evidence:** red-green", `**Evidence:** convention (\`${FULL_GATE}\`)`), { manifest: MANIFEST });
  assert.equal(r.code, 0, r.out);
});

test("fails a **Verification gate:** that omits a required check, naming the gate and the check", () => {
  const r = run(COMPLETE, { manifest: MANIFEST });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the \*\*Verification gate:\*\* `npm test` omits required gate check "validate\.mjs"/);
  assert.match(r.out, /the \*\*Verification gate:\*\* `npm test` omits required gate check "redaction-check\.mjs"/);
});

test("without a manifest at the work-tree root a narrow gate is not checked", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** convention (`node scripts/validate.mjs`)"));
  assert.equal(r.code, 0, r.out);
});

test("a manifest that is not a JSON array of strings fails naming the file, not with a stack trace", () => {
  for (const manifest of ["[validate", JSON.stringify({ checks: [] })]) {
    const r = run(GATED, { manifest });
    assert.equal(r.code, 1, manifest);
    assert.match(r.out, /required-gate-checks\.json: (invalid JSON|must be a JSON array of command substrings)/, manifest);
    assert.doesNotMatch(r.out, /^\s+at /m);
  }
});

// --- #276: steps that prescribe a git command the dispatch guard denies, reported as notes ---

const withStep = (step) => COMPLETE.replace("- [ ] step", `- [ ] ${step}`);
const notesIn = (out) => out.split("\n").filter((line) => line.startsWith("brief-completeness-check: note: "));

test("a step prescribing a git deletion passes with a note naming the task, the command and the guard's reason", () => {
  const r = run(withStep("Run `git rm src/x.mjs`"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^brief-completeness-check: note: Task 1: prescribes `git rm src\/x\.mjs`, which the dispatch guard denies an implementer — .*\(rm\)\./m);
});

test("git inside a substitution or backticks, git archive and git worktree each get one note", () => {
  for (const [step, reason] of [
    ["Read `$(git rev-parse --show-toplevel)/x`", /command substitution/],
    ["Read ``echo `git rev-parse HEAD` ``", /command substitution/],
    ["Run `git archive HEAD`", /\(archive\)/],
    ["Run `git worktree add ../wt`", /\(worktree\)/],
  ]) {
    const r = run(withStep(step));
    assert.equal(r.code, 0, `${step}\n${r.out}`);
    assert.equal(notesIn(r.out).length, 1, `${step}\n${r.out}`);
    assert.match(notesIn(r.out)[0], reason, step);
  }
});

test("a line of a shell fence is a prescribed command; a line of a JS fence is not", () => {
  const shell = run(withStep("delete it:\n```bash\ngit rm a.mjs\n```"));
  assert.equal(shell.code, 0, shell.out);
  assert.equal(notesIn(shell.out).length, 1, shell.out);
  assert.match(notesIn(shell.out)[0], /`git rm a\.mjs`/);
  const js = run(withStep('write the test:\n```js\nexecFileSync("git", ["commit", "-m", "x"]);\n// git commit -m x\n```'));
  assert.equal(js.code, 0, js.out);
  assert.deepEqual(notesIn(js.out), [], js.out);
});

test("an allowed git command, a repeated one and the task's own convention command add no extra note", () => {
  const allowed = run(withStep("Run `git status --short`"));
  assert.deepEqual(notesIn(allowed.out), [], allowed.out);
  const twice = run(withStep("Run `git rm a.mjs`, then again `git rm a.mjs`"));
  assert.equal(notesIn(twice.out).length, 1, twice.out);
  const convention = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** convention (`cat $(git rev-parse --show-toplevel)/x`)"));
  assert.equal(convention.code, 0, convention.out);
  assert.deepEqual(notesIn(convention.out), [], convention.out);
});

test("a plan that prescribes no git command prints no note", () => {
  const r = run(COMPLETE);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(notesIn(r.out), []);
});

test("a guard hook that cannot answer yields a could-not-classify note, never a finding or a throw", () => {
  const dir = realpathSync(makeTempDir("bcc-hook-"));
  const blocks = [{ num: 3, text: "### Task 3: X\n- [ ] Run `git rm a.mjs`\n" }];
  const garbled = join(dir, "garbled-hook.mjs");
  writeFileSync(garbled, 'process.stdout.write("not json");\n');
  const [garbledNote, ...rest] = guardDenialNotes(blocks, { repoRoot: dir, hookPath: garbled });
  assert.deepEqual(rest, []);
  assert.match(garbledNote, /^Task 3: the guard leg could not classify `git rm a\.mjs` \(unparsable hook output: not json\)/);
  const failing = join(dir, "failing-hook.mjs");
  writeFileSync(failing, "process.exit(2);\n");
  assert.match(guardDenialNotes(blocks, { repoRoot: dir, hookPath: failing })[0], /could not classify `git rm a\.mjs` \(exit 2/);
});

// --- #321: a red-green task that creates its module under test writes a stub first ---

const NO_STUB = COMPLETE.replace("- [ ] Write a minimal stub for `a.mjs`\n", "");

test("fails a red-green task that creates a source file and never writes a stub, naming the task and the file", () => {
  const r = run(NO_STUB);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: \*\*Evidence:\*\* red-green creates a\.mjs but no step writes a stub for it — .*references\/evidence\.md § The three evidence classes/);
});

test("passes the same task once any step outside Files mentions the stub", () => {
  assert.equal(run(COMPLETE).code, 0);
  const r = run(NO_STUB.replace("- [ ] step", "- [ ] Stub `a.mjs` with a function that returns null"));
  assert.equal(r.code, 0, r.out);
});

test("a stub named only inside the Files field does not count", () => {
  const r = run(NO_STUB.replace("- Create: `a.mjs`", "- Create: `a.mjs` (stub first)"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: .*creates a\.mjs/);
});

test("creating only test files, a doc or a fixture never needs a stub", () => {
  for (const files of ["- Create: `a.test.mjs`", "- Create: `src/a.spec.ts`", "- Create: `tests/helper.mjs`", "- Create: `docs/a.md`", "- Create: `tests/fixtures/a.json`"]) {
    const r = run(NO_STUB.replace("- Create: `a.mjs`", files));
    assert.equal(r.code, 0, `${files}\n${r.out}`);
  }
});

test("green-green and convention tasks creating a source file never need a stub", () => {
  for (const evidence of ["green-green (behavior-preserving)", "convention (`npm test`)"]) {
    const r = run(NO_STUB.replace("**Evidence:** red-green", `**Evidence:** ${evidence}`));
    assert.equal(r.code, 0, `${evidence}\n${r.out}`);
  }
});

test("a path under Modify, or on a Delete line, is never read as created", () => {
  const r = run(NO_STUB.replace("- Create: `a.mjs`", "- Modify: `a.mjs`\n- Delete: `old.mjs`"));
  assert.equal(r.code, 0, r.out);
});

// --- branch-review round 1: the stub and guard legs read only the task's own brief ---

test("a stub named in a section after the last task does not silence the stub leg", () => {
  const r = run(NO_STUB + "\n## Self-review\n- stub coverage checked for every task\n");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Task 1: .*creates a\.mjs/);
});

test("a git command in a section after the last task is not blamed on that task", () => {
  const r = run(COMPLETE + "\n## Self-review\n- cleanup: `git rm old.mjs`\n");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(notesIn(r.out), [], r.out);
});

test("a path in the trailing prose of a Create line is not a created source file", () => {
  for (const files of ["- Create: `docs/a.md` (documents `scripts/x.mjs`)", "- Create: `docs/a.md`, wired into `scripts/x.mjs`"]) {
    const r = run(NO_STUB.replace("- Create: `a.mjs`", files));
    assert.equal(r.code, 0, `${files}\n${r.out}`);
  }
});

test("a SwiftPM Tests/ file, a conftest.py and a .d.ts declaration file never need a stub", () => {
  for (const file of ["Tests/AppTests/AppTests.swift", "conftest.py", "types/index.d.ts", "types/a.d.mts", "types/b.d.cts"]) {
    const r = run(NO_STUB.replace("`a.mjs`", `\`${file}\``));
    assert.equal(r.code, 0, `${file}\n${r.out}`);
  }
  assert.equal(run(NO_STUB.replace("`a.mjs`", "`src/index.ts`")).code, 1);
});

test("a convention command is skipped on the Evidence line only; a step that types it is still scanned", () => {
  const convention = "**Evidence:** convention (`cat $(git rev-parse --show-toplevel)/x`)";
  const plan = COMPLETE.replace("**Evidence:** red-green", convention);
  assert.deepEqual(notesIn(run(plan).out), []);
  const typed = run(plan.replace("- [ ] step", "- [ ] Run `cat $(git rev-parse --show-toplevel)/x` by hand"));
  assert.equal(notesIn(typed.out).length, 1, typed.out);
  assert.match(notesIn(typed.out)[0], /command substitution/);
});

// --- #331: an interface-pinned task says why and still pins its failing test code ---

const PINNED = COMPLETE.replace(
  "**Evidence:** red-green\n",
  "**Evidence:** red-green\n**Detail:** interface-pinned — new interception layer, design-heavy\n",
).replace("- [ ] step\n", "- [ ] Write the failing test:\n```js\ntest(\"x\", () => {});\n```\n");

test("passes an interface-pinned red-green task with a reason and a fenced test block", () => {
  const r = run(PINNED);
  assert.equal(r.code, 0, r.out);
});

test("fails an interface-pinned task with no reason after the dash", () => {
  const r = run(PINNED.replace("interface-pinned — new interception layer, design-heavy", "interface-pinned"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Detail:\*\* interface-pinned needs a reason after the dash/);
});

test("fails an interface-pinned task whose dash is followed by nothing", () => {
  const r = run(PINNED.replace("interface-pinned — new interception layer, design-heavy", "interface-pinned — "));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Detail:\*\* interface-pinned needs a reason after the dash/);
});

test("fails an interface-pinned task whose evidence class is not red-green", () => {
  const r = run(PINNED.replace("**Evidence:** red-green", "**Evidence:** green-green (behavior-preserving)"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Detail:\*\* interface-pinned is allowed only on a red-green task/);
});

test("fails any red-green task whose brief pins no fenced block", () => {
  const r = run(COMPLETE.replace('- [ ] step\n```js\ntest("x", () => {});\n```\n', "- [ ] step\n"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: a red-green task pins the failing test itself in a fenced block, not only the gate command/);
});

const GATE_ONLY = COMPLETE.replace(
  '- [ ] step\n```js\ntest("x", () => {});\n```\n',
  "- [ ] Write a test that covers the cases\n```bash\nnode --test tests/unit/a.test.mjs\n```\n",
);
const NO_TEST_CODE = /Task 1: a red-green task pins the failing test itself in a fenced block, not only the gate command/;

test("fails a red-green task whose only fenced block is its bash gate command", () => {
  const r = run(GATE_ONLY);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, NO_TEST_CODE);
});

test("fails a red-green task whose only fence is an unlabelled block of command lines", () => {
  const r = run(GATE_ONLY.replace("```bash", "```"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, NO_TEST_CODE);
});

test("passes a red-green task that pins a js test fence next to its bash gate fence", () => {
  const r = run(GATE_ONLY.replace("## Dispatch Map", '```js\ntest("x", () => {});\n```\n## Dispatch Map'));
  assert.equal(r.code, 0, r.out);
});

test("passes a red-green task whose test fence is unlabelled or in another language", () => {
  const body = GATE_ONLY.replace("## Dispatch Map", "```%s\ntest(\"x\", () => {});\n```\n## Dispatch Map");
  for (const info of ["", "ts", "mjs", "python"])
    assert.equal(run(body.replace("%s", info)).code, 0, `fence info "${info}"`);
});

// A fence that holds only the gate command, its output, or a wrapped command line is not test code,
// whatever it is labelled.
const onlyFence = (info, body) => GATE_ONLY.replace(/```bash\nnode --test tests\/unit\/a\.test\.mjs\n```\n/, `\`\`\`${info}\n${body}\n\`\`\`\n`);

test("fails a red-green task whose only fence is an unlabelled gate command followed by its output", () => {
  const r = run(onlyFence("", "$ node --test tests/unit/a.test.mjs\n✖ a fails\nℹ tests 1\nℹ fail 1"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, NO_TEST_CODE);
});

test("fails a red-green task whose only fence is unlabelled expected output", () => {
  const r = run(onlyFence("", "not ok 1 - a\nAssertionError [ERR_ASSERTION]: expected 1 got 2\nFAIL"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, NO_TEST_CODE);
});

test("fails a red-green task whose only fence is an unlabelled command wrapped with a trailing backslash", () => {
  const r = run(onlyFence("", "TMPDIR=/tmp/x \\\n  node --test \\\n  tests/unit/a.test.mjs"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, NO_TEST_CODE);
});

test("fails a red-green task whose only fence carries a non-code label", () => {
  for (const info of ["shell-session", "sh-session", "terminal", "output", "powershell", "fish", "log", "Output"])
    assert.equal(run(onlyFence(info, "node --test tests/unit/a.test.mjs")).code, 1, `fence info "${info}"`);
  // Denied outright: even a line that would read as test code does not count.
  assert.equal(run(onlyFence("output", 'test("x", () => {});')).code, 1);
});

// text, plaintext and txt are judged by their lines: output and commands fail, test-table rows pass.
test("a text-labelled fence is judged by its lines, like an unlabelled one", () => {
  const rows = '    [[entry(2, "review-verdict", "deferred")], "deferred", "commit"],';
  for (const info of ["text", "plaintext", "txt", "TEXT"]) {
    assert.equal(run(onlyFence(info, "node --test tests/unit/a.test.mjs")).code, 1, `command, info "${info}"`);
    assert.equal(run(onlyFence(info, "not ok 1 - a\nAssertionError [ERR_ASSERTION]: boom")).code, 1, `output, info "${info}"`);
    assert.equal(run(onlyFence(info, rows)).code, 0, `test rows, info "${info}"`);
  }
});

test("a wrapped command beside real test lines in one unlabelled fence is still test code", () => {
  const r = run(onlyFence("", "node --test \\\n  tests/unit/a.test.mjs\ntest(\"x\", () => {});"));
  assert.equal(r.code, 0, r.out);
});

test("an unlabelled fence of real test code still passes, with CRLF line endings too", () => {
  const body = 'assert.equal(f(), 2);';
  assert.equal(run(onlyFence("", body)).code, 0);
  assert.equal(run(onlyFence("", body).replaceAll("\n", "\r\n")).code, 0);
  assert.equal(run(onlyFence("", "node --test x").replaceAll("\n", "\r\n")).code, 1);
});

test("an unclosed fence runs to the end of the brief and its test code still counts", () => {
  const unclosed = GATE_ONLY.replace(/```bash\nnode --test tests\/unit\/a\.test\.mjs\n```\n/, "```\nassert.equal(f(), 2);\n");
  assert.equal(run(unclosed).code, 0);
});

test("a green-green task with only a bash gate fence still passes", () => {
  const r = run(GATE_ONLY.replace("**Evidence:** red-green", "**Evidence:** green-green (behavior-preserving)"));
  assert.equal(r.code, 0, r.out);
});

test("passes a code-pinned task with a reason, on any evidence class", () => {
  const pinned = COMPLETE.replace("**Evidence:** red-green\n", "**Evidence:** red-green\n**Detail:** code-pinned — the merge order is not fixed by the tests\n");
  assert.equal(run(pinned).code, 0, run(pinned).out);
  const green = pinned.replace("**Evidence:** red-green", "**Evidence:** green-green (behavior-preserving)");
  assert.equal(run(green).code, 0, run(green).out);
});

test("fails a code-pinned task with no reason after the dash", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green\n", "**Evidence:** red-green\n**Detail:** code-pinned\n"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Detail:\*\* code-pinned needs a reason after the dash/);
});

test("a green-green task needs no fenced block", () => {
  const r = run(COMPLETE.replace("**Evidence:** red-green", "**Evidence:** green-green (behavior-preserving)")
    .replace('- [ ] step\n```js\ntest("x", () => {});\n```\n', "- [ ] step\n"));
  assert.equal(r.code, 0, r.out);
});

test("fails an unknown Detail value", () => {
  const r = run(PINNED.replace("interface-pinned — new interception layer, design-heavy", "sketch — too big to write"));
  assert.equal(r.code, 1);
  assert.match(r.out, /Task 1: \*\*Detail:\*\* must be `code-pinned — <reason>`, got: sketch — too big to write/);
});

test("a brief that quotes the Detail form mid-line declares nothing", () => {
  const r = run(COMPLETE.replace("- [ ] step\n", "- [ ] Mention that a task may declare `**Detail:** interface-pinned` instead\n"));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Detail/);
});

test("a task without a Detail line is a full-code task and is not checked for one", () => {
  const r = run(COMPLETE);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /Detail/);
});

test("fails a red-green task whose only fence is a gate command and real runner output (O1)", () => {
  const outputs = {
    pytest: "$ pytest tests/test_a.py\n============ test session starts ============\ntests/test_a.py F\nE       assert 1 == 2\nFAILED tests/test_a.py::test_add - assert 1 == 2\n1 failed in 0.01s",
    go: "$ go test ./...\n=== RUN   TestAdd\n--- FAIL: TestAdd (0.00s)\nFAIL\nFAIL\texample.com/a\t0.002s",
    goOk: "$ go test ./...\nok  \texample.com/a\t0.002s\nPASS",
    cargo: "$ cargo test\nrunning 1 test\ntest tests::adds ... FAILED\ntest result: FAILED. 0 passed; 1 failed",
    npm: "$ npm test\n> a@1.0.0 test\n> node --test\n✖ adds\nnpm ERR! Test failed.",
    node: "$ node --test tests/unit/a.test.mjs\n▶ suite\n  ✖ adds (1.2ms)\n    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n    Expected: 3\n    Actual: 2",
    // An `npm error`/`npm ERR!` line starts with `npm`, so it already reads as a command, not as output.
    npmErrorLower: "$ npm test\nnpm error Test failed.",
    // One fence per alternative below: its line is the only thing that can make the fence read as output.
    pytestPassedWord: "$ pytest -v\nPASSED tests/test_a.py::test_ok",
    pytestErrorWord: "$ pytest\nERROR tests/test_a.py",
    receivedLine: "$ node --test tests/unit/a.test.mjs\nReceived: 2",
    pytestPassedCount: "$ pytest\n1 passed in 0.01s",
  };
  for (const [name, body] of Object.entries(outputs)) {
    const r = run(onlyFence("", body));
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, NO_TEST_CODE, name);
  }
});

test("test code beside runner output still counts, and ok(value) is test code, not output", () => {
  assert.equal(run(onlyFence("", 'test("x", () => {});\n✖ x\nExpected: 1')).code, 0);
  assert.equal(run(onlyFence("", "ok(value);")).code, 0);
});

test("fails a red-green task whose only fence carries a shell-session or output label (O2)", () => {
  for (const info of ["shellsession", "bash-session", "pwsh", "ps1", "bat", "cmd", "batch", "ksh", "dash", "stdout", "stderr", "tap"])
    assert.equal(run(onlyFence(info, 'test("x", () => {});')).code, 1, `fence info "${info}"`);
  // A diff fence may pin the failing test as a patch, so it is still read as code.
  assert.equal(run(onlyFence("diff", '+test("x", () => {});')).code, 0);
});

test("a # comment ending in a backslash does not swallow the next line (O3)", () => {
  assert.equal(run(onlyFence("", '# run it with \\\ntest("x", () => {});')).code, 0);
  assert.equal(run(onlyFence("", "# the gate \\\nnode --test tests/unit/a.test.mjs")).code, 1);
});
