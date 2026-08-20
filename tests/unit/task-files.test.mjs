import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFileToken,
  extractFiles,
  parseFileList,
  taskBlocks,
  taskFileMap,
  parseDispatchMap,
  filesFieldValue,
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
