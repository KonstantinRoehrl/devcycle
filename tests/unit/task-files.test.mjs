import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFileToken,
  expandBraces,
  extractFiles,
  parseFileList,
  taskBlocks,
  taskFileMap,
  parseDispatchMap,
  filesFieldValue,
  gateCommand,
  conventionCommand,
  verificationGate,
  verificationGateField,
} from "../../scripts/task-files.mjs";

test("normalizeFileToken strips ranges, backticks, and rejects non-paths", () => {
  assert.equal(normalizeFileToken("`scripts/a.mjs:12-20`"), "scripts/a.mjs");
  assert.equal(normalizeFileToken("Modify"), null);
  assert.equal(normalizeFileToken("-"), null);
  assert.equal(normalizeFileToken("prose"), null);
  assert.equal(normalizeFileToken("a.mjs"), "a.mjs");
});

test("normalizeFileToken strips a sentence-final period, so a period-terminated declaration is one file", () => {
  // A prose declaration ends its clause: "Modify `scripts/a.mjs`. Test: ...". Keeping that
  // trailing period made the same file read as two different tokens, and wave-disjointness --
  // which keys its owners Map on the exact string -- printed ok on a genuine same-wave collision.
  assert.equal(normalizeFileToken("`scripts/a.mjs`."), "scripts/a.mjs");
  assert.equal(normalizeFileToken("`README.md`."), "README.md");
  assert.equal(normalizeFileToken("a/b.mjs."), "a/b.mjs");
  // The surrounding token rules are unchanged by that one character.
  assert.equal(normalizeFileToken("scripts/a.mjs"), "scripts/a.mjs");
  assert.equal(normalizeFileToken("docs/x.md,"), "docs/x.md");
  assert.equal(normalizeFileToken("scripts/a.mjs:12-40"), "scripts/a.mjs");
  assert.equal(normalizeFileToken("..."), null);
  assert.equal(normalizeFileToken("Dockerfile"), null);
});

test("extractFiles pulls path tokens out of a Files block", () => {
  const block = "- Create: `scripts/x.mjs`\n- Modify: `refs/y.md:3-9` (a note)\n";
  assert.deepEqual([...extractFiles(block)].sort(), ["refs/y.md", "scripts/x.mjs"]);
});

test("parseFileList normalizes a CSV --files argument", () => {
  assert.deepEqual(parseFileList("scripts/a.mjs:1-9, `b/c.md` , Modify"), ["scripts/a.mjs", "b/c.md"]);
});

test("parseFileList keeps a top-level extensionless file the caller explicitly named", () => {
  // The --files CSV is caller-asserted: these ARE files, so the path-shape gate must not drop
  // Dockerfile/Makefile/LICENSE, or their lessons are silently withheld.
  assert.deepEqual(parseFileList("Dockerfile"), ["Dockerfile"]);
  assert.deepEqual(parseFileList("Dockerfile, Makefile, scripts/a.mjs"),
    ["Dockerfile", "Makefile", "scripts/a.mjs"]);
  // Labels and bare dashes are still dropped even on the trusted path.
  assert.deepEqual(parseFileList("Modify, -, LICENSE"), ["LICENSE"]);
});

test("extractFiles still rejects a bare extensionless token as prose (the asymmetry the fix preserves)", () => {
  // The **Files:**-block parse path stays strict: an extensionless word with no slash reads as
  // surrounding prose, so wave-disjointness parity is unchanged.
  assert.deepEqual([...extractFiles("Dockerfile is the build entrypoint")], []);
});

const PLAN = [
  "### Task 1: First",
  "",
  "**Files:**",
  "- Modify: `scripts/a.mjs`",
  "",
  "**Evidence:** red-green",
  "",
  "### Task 2: Second",
  "",
  "**Files:**",
  "- Modify: `scripts/b.mjs`",
  "",
  "## Dispatch Map",
  "- Wave 1: Task 1, Task 2 (file-disjoint)",
  "- Wave 2: Task 3 (needs Task 1 and Task 2)",
  "",
].join("\n");

test("taskBlocks numbers each block and slices to the next heading", () => {
  const blocks = taskBlocks(PLAN);
  assert.deepEqual(blocks.map((b) => b.num), [1, 2]);
  assert.ok(blocks[0].text.includes("scripts/a.mjs"));
  assert.ok(!blocks[0].text.includes("scripts/b.mjs"), "block 1 must stop at the next heading");
});

test("taskFileMap maps each task number to its declared files", () => {
  const map = taskFileMap(PLAN);
  assert.deepEqual([...map.get(1)], ["scripts/a.mjs"]);
  assert.deepEqual([...map.get(2)], ["scripts/b.mjs"]);
});

test("parseDispatchMap reads only the text before the first paren", () => {
  const waves = parseDispatchMap(PLAN);
  assert.deepEqual(waves.get(1), [1, 2]);
  assert.deepEqual(waves.get(3), undefined);
  assert.deepEqual(waves.get(2), [3], "a dependency parenthetical is not a wave assignment");
});

test("parseDispatchMap returns null when no Dispatch Map heading exists", () => {
  assert.equal(parseDispatchMap("### Task 1: Only\n"), null);
});

test("taskBlocks returns an empty array for a document with no task headings", () => {
  assert.deepEqual(taskBlocks("# Not a plan\n\nProse only.\n"), []);
});

// A plan writes the same declaration two ways: the value on the line after the label (block form)
// and the value on the label's own line (inline form). One grammar owns both, so neither may
// parse to a different file set than the other.
const INLINE_PLAN = [
  "### Task 1: First",
  "",
  "**Files:** Modify `scripts/a.mjs`, Test: `tests/unit/a.test.mjs`",
  "",
  "**Evidence:** red-green",
  "",
  "## Dispatch Map",
  "- Wave 1: Task 1",
  "",
].join("\n");

test("taskFileMap reads a Files field whose value starts on the label's own line", () => {
  const files = taskFileMap(INLINE_PLAN).get(1) ?? new Set();
  assert.deepEqual([...files].sort(), ["scripts/a.mjs", "tests/unit/a.test.mjs"]);
});

test("the inline and block forms of one declaration parse to the same file set", () => {
  const decl = "Modify `scripts/a.mjs`. Test: `tests/unit/a.test.mjs`";
  const inline = `### Task 1: T\n**Files:** ${decl}\n\n**Evidence:** red-green\n`;
  const block = `### Task 1: T\n**Files:**\n${decl}\n\n**Evidence:** red-green\n`;
  // The exact set, not just "equal and non-empty": both forms mangling the period-terminated
  // token identically satisfied that weaker pair of assertions while the parse was wrong.
  const expected = ["scripts/a.mjs", "tests/unit/a.test.mjs"];
  assert.deepEqual([...(taskFileMap(inline).get(1) ?? new Set())].sort(), expected);
  assert.deepEqual([...(taskFileMap(block).get(1) ?? new Set())].sort(), expected);
});

test("filesFieldValue tells an absent Files field apart from an empty one", () => {
  assert.equal(filesFieldValue("### Task 1: T\n**Interfaces:** none\n"), null);
  assert.equal(filesFieldValue("### Task 1: T\n**Files:**\n**Interfaces:** none\n"), "");
  assert.equal(filesFieldValue("### Task 1: T\n**Files:** `a.mjs`\n"), "`a.mjs`");
});

test("the Files field ends at the next bolded field, the next task heading, or end of input", () => {
  assert.equal(filesFieldValue("**Files:** `a.mjs`\n**Interfaces:** none\n"), "`a.mjs`");
  assert.equal(filesFieldValue("**Files:** `a.mjs`\n### Task 2: Next\n**Files:** `b.mjs`\n"), "`a.mjs`");
  assert.equal(filesFieldValue("**Files:** `a.mjs`\n"), "`a.mjs`");
});

test("filesFieldValue reads the declaration at line start, not a mid-line mention of the label", () => {
  // A task whose prose quotes the label before its real field used to parse the prose: an empty
  // file set and two silent plan gates, while brief-completeness reported the field present.
  const block = [
    "### Task 1: T",
    "The dispatch brief's **Files:** list is authoritative for `docs/wrong.md`.",
    "",
    "**Files:** Modify `scripts/right.mjs`",
    "",
  ].join("\n");
  assert.equal(filesFieldValue(block), "Modify `scripts/right.mjs`");
  assert.equal(filesFieldValue("### Task 1: T\nSee the **Files:** field convention.\n"), null);
  // Both accepted forms of a real declaration still parse.
  assert.equal(filesFieldValue("**Files:** `a.mjs`\n"), "`a.mjs`");
  assert.equal(filesFieldValue("### Task 1: T\n**Files:**\n- Modify: `a.mjs`\n"), "- Modify: `a.mjs`");
});

test("a task with no Files field at all is absent from the map, so the gates can still hard-fail", () => {
  const noFiles = "### Task 1: T\n**Interfaces:** none\n\n## Dispatch Map\n- Wave 1: Task 1\n";
  assert.equal(taskFileMap(noFiles).size, 0);
});

test("a trailing period comes off a path-shaped token and stays on a prose abbreviation", () => {
  // The period strip exists so "Modify `scripts/a.mjs`." is the same token as its bare twin. Run
  // unconditionally it also rewrites prose: "e.g." became "e.g", which the extension gate then
  // accepted, so two tasks that merely both wrote "e.g." collided on a file that does not exist.
  const table = [
    ["`scripts/a.mjs`.", "scripts/a.mjs"],
    ["`README.md`.", "README.md"],
    ["a/b.mjs.", "a/b.mjs"],
    ["scripts/a.mjs:12-40.", "scripts/a.mjs"],
    ["scripts/a.mjs", "scripts/a.mjs"],
    ["docs/x.md,", "docs/x.md"],
    ["./x.mjs", "./x.mjs"],
    ["../rel/p.mjs", "../rel/p.mjs"],
    ["a.b.c.mjs", "a.b.c.mjs"],
    ["e.g.", null],
    ["i.e.", null],
    ["Node.js.", null],
    ["0.5.", null],
    ["etc.", null],
    ["...", null],
    ["..", null],
    // A bare extensionless basename stays prose on this path (F55, owned by C9).
    ["Dockerfile", null],
    ["Makefile", null],
  ];
  for (const [raw, expected] of table) {
    assert.equal(normalizeFileToken(raw), expected, `normalizeFileToken(${JSON.stringify(raw)})`);
  }
});

test("extractFiles reads the declaration in a Files block and none of the prose around it", () => {
  const block = "Modify `scripts/a.mjs` -- the loader, e.g. the cache band. Node.js. 0.5. etc.";
  assert.deepEqual([...extractFiles(block)], ["scripts/a.mjs"]);
});

test("the trusted path drops a trailing period the caller typed, so the lesson still matches", () => {
  // --files is caller-asserted: every token IS a file, so a sentence-final period is never part of
  // the name. Keeping it made matchLessons -- exact string or glob -- miss a lesson recorded
  // against CHANGELOG.md, and the brief reported "**Lessons:** none".
  assert.deepEqual(parseFileList("CHANGELOG.md."), ["CHANGELOG.md"]);
  assert.deepEqual(parseFileList("Dockerfile."), ["Dockerfile"]);
  assert.deepEqual(parseFileList("scripts/a.mjs., CHANGELOG.md."), ["scripts/a.mjs", "CHANGELOG.md"]);
  // Tokens that are nothing but punctuation still drop out rather than becoming "".
  assert.deepEqual(parseFileList("..., .."), []);
  // The untrusted path keeps its prose gate unchanged: that is what stops "e.g." becoming a
  // phantom file, and it is why a bare "CHANGELOG.md." there stays prose while the same token
  // announced as a path does not.
  assert.equal(normalizeFileToken("CHANGELOG.md."), null);
  assert.equal(normalizeFileToken("`CHANGELOG.md`."), "CHANGELOG.md");
  assert.equal(normalizeFileToken("docs/CHANGELOG.md."), "docs/CHANGELOG.md");
  assert.equal(normalizeFileToken("e.g."), null);
  assert.equal(normalizeFileToken("Node.js."), null);
});

const GATE = "node scripts/validate.mjs && node --test tests/unit/*.test.mjs";
const GATED_PLAN = [
  "# P Implementation Plan", "",
  `**Verification gate:** \`${GATE}\``,
  "## Global Constraints", "- none", "",
  "### Task 1: Code", "**Files:**", "- Modify: src/a.mjs", "**Evidence:** red-green", "**Quality constraints:** none", "",
  "### Task 2: Refactor", "**Files:**", "- Modify: src/b.mjs", "**Evidence:** green-green (behavior-preserving)", "**Quality constraints:** none", "",
  "### Task 3: Docs", "**Files:**", "- Modify: README.md", "**Evidence:** convention (`node scripts/validate.mjs`)", "**Quality constraints:** none", "",
  "### Task 4: Bare docs", "**Files:**", "- Modify: docs/a.md", "**Evidence:** convention (node scripts/validate.mjs)", "**Quality constraints:** none", "",
  "### Task 5: Procedure", "**Files:**", "- Modify: docs/b.md", "**Evidence:** convention (`node a.mjs` then `node b.mjs`)", "**Quality constraints:** none", "",
  "### Task 6: Capture recipe", "**Files:**", "- Modify: docs/c.md", "**Evidence:** convention (`{ node scripts/validate.mjs; } > .devcycle/evidence/6-after.txt 2>&1`)", "**Quality constraints:** none", "",
  "### Task 7: Prose", "**Files:**", "- Modify: docs/d.md", "**Evidence:** convention (whole-gate green-before/green-after)", "**Quality constraints:** none", "",
  "## Dispatch Map", "", "- Wave 1: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7", "",
].join("\n");
const ungated = (text) => text.replace(/^\*\*Verification gate:\*\*.*\n/m, "");

test("gateCommand: a test-class task's gate is the plan header's Verification gate, alongside the task's class", () => {
  assert.deepEqual(gateCommand(GATED_PLAN, 1), { cmd: GATE, source: "plan-gate", evidenceClass: "red-green" });
  assert.deepEqual(gateCommand(GATED_PLAN, 2), { cmd: GATE, source: "plan-gate", evidenceClass: "green-green" });
});

test("gateCommand: a convention task's gate is its one-code-span parenthetical, and it carries the plan's header gate", () => {
  assert.deepEqual(gateCommand(GATED_PLAN, 3), { cmd: "node scripts/validate.mjs", source: "convention", evidenceClass: "convention", planGate: GATE });
  assert.deepEqual(gateCommand(ungated(GATED_PLAN), 3), { cmd: "node scripts/validate.mjs", source: "convention", evidenceClass: "convention", planGate: null });
});

test("gateCommand: null for a parenthetical that is not one runnable code span, an unknown task, or a test-class task in an ungated plan", () => {
  for (const task of [4, 5, 6, 7]) assert.equal(gateCommand(GATED_PLAN, task), null, `Task ${task}`);
  assert.equal(gateCommand(GATED_PLAN, 9), null);
  assert.equal(gateCommand(ungated(GATED_PLAN), 1), null);
});

test("conventionCommand: only exactly one code span that is no capture recipe is a command", () => {
  assert.equal(conventionCommand("convention (`npm run lint`)"), "npm run lint");
  assert.equal(conventionCommand("convention (whole-gate green-before/green-after)"), null);
  assert.equal(conventionCommand("convention (node scripts/validate.mjs)"), null);
  assert.equal(conventionCommand("convention (`a` then `b`)"), null);
  assert.equal(conventionCommand("convention (`npm test > .devcycle/evidence/9-after.txt 2>&1`)"), null);
  assert.equal(conventionCommand("convention"), null);
});

test("the Verification gate is read from the header line only, never from a task block or a following section", () => {
  assert.equal(verificationGateField(GATED_PLAN), `\`${GATE}\``);
  assert.equal(verificationGate(GATED_PLAN), GATE);
  const inTask = ungated(GATED_PLAN).replace("**Quality constraints:** none\n", "**Quality constraints:** none\n**Verification gate:** `npm test`\n");
  assert.equal(verificationGateField(inTask), null);
  const twoSpans = GATED_PLAN.replace(`\`${GATE}\``, "`npm test` and `npm run lint`");
  assert.equal(verificationGateField(twoSpans), "`npm test` and `npm run lint`");
  assert.equal(verificationGate(twoSpans), null);
});

test("expandBraces expands a comma group the way bash does and leaves every other brace literal", () => {
  assert.deepEqual(expandBraces("src/lib/{a,b}.ts"), ["src/lib/a.ts", "src/lib/b.ts"]);
  assert.deepEqual(expandBraces("a/{b,c}/{d,e}.mjs"), ["a/b/d.mjs", "a/b/e.mjs", "a/c/d.mjs", "a/c/e.mjs"]);
  assert.deepEqual(expandBraces("a/{b,c/{d,e}}.mjs"), ["a/b.mjs", "a/c/d.mjs", "a/c/e.mjs"]);
  // Code-span backticks and punctuation around the group survive, for normalizeFileToken to strip.
  assert.deepEqual(expandBraces("`dir/{a,b}.mjs`."), ["`dir/a.mjs`.", "`dir/b.mjs`."]);
  // No top-level comma, or no closing brace: not a list, so the text is returned as written.
  for (const literal of ["{a}.mjs", "${CLAUDE_PLUGIN_ROOT}/x.md", "s/{1..3}.md", "s/{a,b.md"]) {
    assert.deepEqual(expandBraces(literal), [literal], literal);
  }
});

test("extractFiles expands a brace list into every path it declares", () => {
  // task-commit stages only the paths in the map, so the unexpanded pattern committed nothing.
  assert.deepEqual([...extractFiles("- Create: `src/lib/{a,b}.ts`")], ["src/lib/a.ts", "src/lib/b.ts"]);
  assert.deepEqual([...extractFiles("- Modify: `a/{b,c}/{d,e}.mjs`.")],
    ["a/b/d.mjs", "a/b/e.mjs", "a/c/d.mjs", "a/c/e.mjs"]);
  assert.deepEqual([...extractFiles("- Modify: a/{b,c/{d,e}}.mjs")], ["a/b.mjs", "a/c/d.mjs", "a/c/e.mjs"]);
  // A group with no comma stays literal, and a path still holding a brace is no repo path.
  assert.deepEqual([...extractFiles("- Modify: `${CLAUDE_PLUGIN_ROOT}/x.md`, `src/{a}.ts`")], []);
});

test("extractFiles rejects prose that merely contains a slash, keeping the real path beside it", () => {
  // blast-radius-check greps the repo for every declared file's basename, so `step/row` reported
  // every file mentioning "row" as a referencer.
  assert.deepEqual([...extractFiles("- Modify: `scripts/a.mjs` (adds the step/row column)")], ["scripts/a.mjs"]);
  for (const prose of ["Keep/Drop", "9a/9b", "#!/usr/bin/env", "/10", "//", "`repoShape`/`issueBody`"]) {
    assert.deepEqual([...extractFiles(`- Modify: \`scripts/a.mjs\` -- see ${prose} here`)], ["scripts/a.mjs"], prose);
  }
  // An identifier in a code span is no file either, or sibling tasks would collide on `main`.
  assert.deepEqual([...extractFiles("- Modify: `scripts/a.mjs` -- exports `main` and `parseArgs`.")], ["scripts/a.mjs"]);
});

test("an extensionless path survives right after its label or as a code span, and nowhere else", () => {
  assert.deepEqual([...extractFiles("- Modify: bin/devcycle-root")], ["bin/devcycle-root"]);
  assert.deepEqual([...extractFiles("- Create: commands/, skills/")], ["commands/", "skills/"]);
  assert.deepEqual([...extractFiles("- Create: {commands,skills}/")], ["commands/", "skills/"]);
  assert.deepEqual([...extractFiles("- Modify: `scripts/a.mjs` (and `bin/devcycle-root`, its caller)")],
    ["scripts/a.mjs", "bin/devcycle-root"]);
  assert.deepEqual([...extractFiles("- Modify: `scripts/a.mjs` (under `docs/superpowers/`; untracked)")],
    ["scripts/a.mjs", "docs/superpowers/"]);
  // Bare in trailing prose it reads exactly like step/row, so it is not a declaration.
  assert.deepEqual([...extractFiles("- Modify: `scripts/a.mjs` (and bin/devcycle-root)")], ["scripts/a.mjs"]);
});

test("target-repo path characters survive: brackets, dollar signs and plus signs", () => {
  assert.deepEqual([...extractFiles("- Create: `app/[slug]/page.tsx`, `routes/$id.tsx`, `src/[id]/+page.svelte`")],
    ["app/[slug]/page.tsx", "routes/$id.tsx", "src/[id]/+page.svelte"]);
});

test("a line anchor of any shape comes off the path, on both paths", () => {
  assert.deepEqual([...extractFiles("- Modify: `scripts/doctor.mjs:565`, `scripts/wave-disjointness-check.mjs:24,31-43`")],
    ["scripts/doctor.mjs", "scripts/wave-disjointness-check.mjs"]);
  assert.equal(normalizeFileToken("scripts/a.mjs:7", { trusted: true }), "scripts/a.mjs");
});

test("parseFileList splits only on commas outside a brace list, then expands it", () => {
  assert.deepEqual(parseFileList("src/{a,b}.ts, c.md"), ["src/a.ts", "src/b.ts", "c.md"]);
});

test("an omitted declared option judges a token by the declaration-position gate, the denylist still applying", () => {
  // blast-radius-check normalizes an override capture with no options: a token the author named on
  // purpose, so `bin/devcycle-root` is a path there even though extractFiles calls it prose in
  // trailing text.
  assert.equal(normalizeFileToken("bin/devcycle-root"), "bin/devcycle-root");
  assert.equal(normalizeFileToken("commands/"), "commands/");
  assert.equal(normalizeFileToken("bin/devcycle-root", { declared: false }), null);
  assert.equal(normalizeFileToken("prose"), null);
  for (const notAPath of ['"dir/x"', "a/{b}", "src\\a/b", "a`b/c", "${VAR}/x.md"]) {
    assert.equal(normalizeFileToken(notAPath), null, notAPath);
  }
});

test("a brace list with a space after the comma stays one token and expands to every file", () => {
  // The whitespace split ran before the expansion, so `src/{a,` and `b}.ts` never met and the
  // group vanished while the file beside it kept the block looking non-empty.
  assert.deepEqual([...extractFiles("- Modify: `src/{a, b}.ts`, `x.md`")], ["src/a.ts", "src/b.ts", "x.md"]);
  assert.deepEqual([...extractFiles("- Modify: src/{a, b}.ts")], ["src/a.ts", "src/b.ts"]);
  assert.deepEqual([...extractFiles("- Create: src/{a,  b ,c}.ts, x.md")], ["src/a.ts", "src/b.ts", "src/c.ts", "x.md"]);
  assert.deepEqual(expandBraces("src/{a, b}.ts"), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(parseFileList("src/{a, b}.ts, c.md"), ["src/a.ts", "src/b.ts", "c.md"]);
});

test("an unbalanced brace does not swallow the rest of the line or the next line", () => {
  assert.deepEqual([...extractFiles("- Modify: src/{a, then prose and `x.md`")], ["x.md"]);
  assert.deepEqual([...extractFiles("- Modify: `scripts/z.mjs`, src/{a, then prose y/z\n- Test: `tests/z.test.mjs` }")],
    ["scripts/z.mjs", "tests/z.test.mjs"]);
});

test("a label may carry bold markers or a parenthetical and still open declaration position", () => {
  const cases = [
    ["- Create (executable): bin/devcycle-root", ["bin/devcycle-root"]],
    ["- Create (tracked, already on disk): bin/devcycle-root", ["bin/devcycle-root"]],
    ["- **Create (executable):** bin/devcycle-root", ["bin/devcycle-root"]],
    ["- **Modify:** commands/", ["commands/"]],
    ["- **Modify**: commands/", ["commands/"]],
    ["- **Modify** commands/", ["commands/"]],
  ];
  for (const [block, expected] of cases) assert.deepEqual([...extractFiles(block)], expected, block);
  // A parenthetical that is not between a label and its colon opens nothing.
  assert.deepEqual([...extractFiles("- Modify: `scripts/a.mjs` (executable): bin/devcycle-root")], ["scripts/a.mjs"]);
});

test("and / + after a declared path continue declaration position, and never after a rejected token", () => {
  assert.deepEqual([...extractFiles("- Create: bin/a and bin/b")], ["bin/a", "bin/b"]);
  assert.deepEqual([...extractFiles("- Create: bin/a + bin/b")], ["bin/a", "bin/b"]);
  assert.deepEqual([...extractFiles("- Create: bin/a, and bin/b and bin/c")], ["bin/a", "bin/b", "bin/c"]);
  assert.deepEqual([...extractFiles('- Create: "q" and bin/b')], []);
  assert.deepEqual([...extractFiles("- Create: prose and bin/b")], []);
  // The conjunction is never a file itself.
  assert.deepEqual([...extractFiles("- Create: x.md and y.md")], ["x.md", "y.md"]);
});

test("a label alone on its line opens declaration position for the path-only lines after it", () => {
  assert.deepEqual([...extractFiles("- Modify:\n  commands/\n  skills/")], ["commands/", "skills/"]);
  assert.deepEqual([...extractFiles("- Modify:\n  commands/\n  skills/\n- Test: tests/x.test.mjs\n")],
    ["commands/", "skills/", "tests/x.test.mjs"]);
  // Prose ends it, so a later path-shaped word stays prose.
  assert.deepEqual([...extractFiles("- Modify:\n  the plan/gate flow\n  commands/")], []);
  // A blank line and a new bullet end it too.
  assert.deepEqual([...extractFiles("- Modify:\n  commands/\n\n  skills/")], ["commands/"]);
  assert.deepEqual([...extractFiles("- Modify:\n- Create: x.md\n  skills/")], ["x.md"]);
});

test("a stray open brace in a code span or parenthetical fuses nothing, so the files around it survive", () => {
  // Fusing ran on any `{` with a later `}` and a comma between, blind to backticks and parentheses:
  // everything between became one whitespace-bearing token and every file in it dropped.
  assert.deepEqual([...extractFiles("- Modify: `src/a.ts` (opens the `{` block), `src/b.ts` (closes it with `}`)")],
    ["src/a.ts", "src/b.ts"]);
  assert.deepEqual([...extractFiles("- Modify: `a.ts` (replace `const o = {` in `b.ts` and `c.ts`, then add `x, y }`)")],
    ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual([...extractFiles("- Modify: {see `a/b.mjs`, and `c.mjs`}")], ["a/b.mjs"]);
  // A real group later on the same line still expands.
  assert.deepEqual([...extractFiles("- Modify: `a.ts` (replace `const o = {` here), `src/{x, y}.ts`")],
    ["a.ts", "src/x.ts", "src/y.ts"]);
});

test("a brace group still fuses across spaces when it is an alternatives list inside one path", () => {
  assert.deepEqual([...extractFiles("- Modify: { a , b }.ts")], ["a.ts", "b.ts"]);
  assert.deepEqual([...extractFiles("- Modify: src/{a, b}.ts, lib/{c, d}.ts")],
    ["src/a.ts", "src/b.ts", "lib/c.ts", "lib/d.ts"]);
  assert.deepEqual([...extractFiles("- Modify: src/{a, b/{c, d}}.ts")], ["src/a.ts", "src/b/c.ts", "src/b/d.ts"]);
});

test("after and / + a bare extensionless slash token is a path only when it continues a list of bare paths", () => {
  // `step/row` after a ticked or dotted path is prose, and blast-radius-check would grep for `row`.
  assert.deepEqual([...extractFiles("- Modify: `a.py` and step/row")], ["a.py"]);
  assert.deepEqual([...extractFiles("- Modify: `a.py` + step/row")], ["a.py"]);
  assert.deepEqual([...extractFiles("- Modify: `a.py` and `b.py` and Keep/Drop")], ["a.py", "b.py"]);
  assert.deepEqual([...extractFiles("- Modify: a.py and Keep/Drop")], ["a.py"]);
  assert.deepEqual([...extractFiles("- Modify: a.py and step/row and foo/bar")], ["a.py"]);
  // A list of the same kind keeps every member.
  assert.deepEqual([...extractFiles("- Create: bin/a and bin/b")], ["bin/a", "bin/b"]);
  assert.deepEqual([...extractFiles("- Create: bin/a + bin/b and bin/c")], ["bin/a", "bin/b", "bin/c"]);
  assert.deepEqual([...extractFiles("- Create: commands/ and skills/")], ["commands/", "skills/"]);
  // A ticked path after the conjunction is path-shaped on its own.
  assert.deepEqual([...extractFiles("- Modify: a.py and `tests/x.mjs`")], ["a.py", "tests/x.mjs"]);
  assert.deepEqual([...extractFiles("- Modify: a.py and `bin/devcycle-root`")], ["a.py", "bin/devcycle-root"]);
});
