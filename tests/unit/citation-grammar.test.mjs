// scripts/citation-grammar.mjs: a prefixed path means read, a bare path means owner.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import {
  sentences,
  backEdgeErrors,
  ownerSentenceErrors,
  bareReadErrors,
  bareExistsErrors,
  referenceReadErrors,
} from "../../scripts/citation-grammar.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/citation-grammar.mjs", import.meta.url));
const P = "${CLAUDE_PLUGIN_ROOT}";
const rules = (hits) => hits.map((h) => `${h.rule}@${h.line}`);

test("sentences: a dot inside an inline code span never splits", () => {
  const s = sentences("See `resume.md` for the shape. Then go on\n");
  assert.deepEqual(s.map((x) => x.text), ["See `resume.md` for the shape.", "Then go on"]);
});

test("sentences: ; and : split, a blank line splits, a list item starts a new sentence", () => {
  const s = sentences("one; two: three\n\nfour\n- five\n- six\n");
  assert.deepEqual(s.map((x) => x.text), ["one;", "two:", "three", "four", "- five", "- six"]);
});

test("sentences: fenced blocks are skipped and a table row is one sentence", () => {
  const s = sentences("```\nRead references/x.md. Owns.\n```\n| a | b. c |\n");
  assert.deepEqual(s.map((x) => x.text), ["| a | b. c |"]);
  assert.equal(s[0].line, 4);
});

test("sentences: an inline code span that wraps a line break still hides its boundaries", () => {
  const s = sentences(`Run \`node\n${P}/scripts/x.mjs --flag\` now. The owner is \`references/y.md\`.\n`);
  assert.deepEqual(s.map((x) => x.text), [`Run \`node ${P}/scripts/x.mjs --flag\` now.`, "The owner is `references/y.md`."]);
});

test("sentences: a sentence keeps the line it starts on and joins wrapped lines", () => {
  const s = sentences("first line\ncontinues here.\n");
  assert.deepEqual(s, [{ text: "first line continues here.", line: 1 }]);
});

test("back-edge: a reference citing a playbook or command prefixed fails, a bare one passes", () => {
  const text = `Uses \`${P}/playbooks/a.md\`.\nNames playbooks/b.md.\nCites \`${P}/commands/c.md\`.\n`;
  assert.deepEqual(rules(backEdgeErrors("references/r.md", text)), ["back-edge@1", "back-edge@3"]);
  assert.deepEqual(backEdgeErrors("playbooks/p.md", text), [], "a playbook may cite a playbook");
});

test("owner-sentence: a prefixed citation in an owner sentence with no read verb fails", () => {
  const text = `An Other answer appends it, whose rule \`${P}/references/ledger.md\` owns.\n`;
  assert.deepEqual(rules(ownerSentenceErrors("playbooks/p.md", text)), ["owner-sentence@1"]);
});

test("owner-sentence: a read verb opening the sentence or one of its clauses exempts it", () => {
  const text =
    `Follow \`${P}/playbooks/v.md\`, which owns the walk.\n\n` +
    `Run the repo-research procedure \`${P}/references/delegation.md\` owns.\n`;
  assert.deepEqual(ownerSentenceErrors("commands/c.md", text), []);
});

test("owner-sentence: a read verb that does not open a clause is no exemption", () => {
  const text =
    `\`${P}/references/config.md\` § Knob channel owns what follows:\n\n` +
    `A run of \`${P}/references/ledger.md\` is owned there.\n\n` +
    `The rule \`${P}/references/x.md\` owns is followed by every stage.\n`;
  assert.deepEqual(rules(ownerSentenceErrors("commands/c.md", text)), ["owner-sentence@1", "owner-sentence@3", "owner-sentence@5"]);
  const clause = `It owns the walk, so read \`${P}/references/x.md\` first.\n`;
  assert.deepEqual(ownerSentenceErrors("commands/c.md", clause), []);
});

test("owner-sentence: a bare owner path never trips it, and a verb inside a code span does not count", () => {
  assert.deepEqual(ownerSentenceErrors("playbooks/p.md", "`references/ledger.md` owns the rule.\n"), []);
  const text = `The \`read\` field of \`${P}/references/x.md\` is owned there.\n`;
  assert.deepEqual(rules(ownerSentenceErrors("playbooks/p.md", text)), ["owner-sentence@1"]);
});

test("bare-read: an imperative read of a bare path fails, after a list marker or a bold label too", () => {
  const text = "Read `references/x.md` first.\n\n2. **Settle.** Follow `references/y.md` here.\n";
  assert.deepEqual(rules(bareReadErrors("playbooks/p.md", text)), ["bare-read@1", "bare-read@3"]);
});

test("bare-read: a non-imperative read verb, or a prefixed path in the sentence, passes", () => {
  const text =
    "A run written by `references/ledger.md`'s row is read-only.\n\n" +
    `Read \`${P}/references/x.md\`; \`references/y.md\` owns the rest.\n`;
  assert.deepEqual(bareReadErrors("playbooks/p.md", text), []);
});

test("bare-read: a bold step label that is itself the read fires", () => {
  const text = "1. **Read `references/x.md` first.**\n2. **Read** `references/y.md` first.\n";
  assert.deepEqual(rules(bareReadErrors("playbooks/p.md", text)), ["bare-read@1", "bare-read@2"]);
});

test("bare-read: a hyphenated word that starts with a read verb is not a read", () => {
  const text = "Read-only by design: nothing here writes `references/x.md`.\n\nRun-time figures live in `references/y.md`.\n";
  assert.deepEqual(bareReadErrors("playbooks/p.md", text), []);
});

test("bare-read: an imperative read whose sentence also carries a prefixed path passes", () => {
  const text = `Read \`${P}/references/x.md\` and leave \`references/y.md\` alone.\n`;
  assert.deepEqual(bareReadErrors("playbooks/p.md", text), []);
  assert.deepEqual(rules(bareReadErrors("playbooks/p.md", "Read `references/x.md` and leave `references/y.md` alone.\n")), ["bare-read@1"]);
});

test("bare-exists: a name with capitals, dots or underscores is a path like any other", () => {
  const exists = (rel) => rel === "references/README.md";
  const text = "See references/README.md and references/Old_Notes.v2.md.\n";
  assert.deepEqual(
    bareExistsErrors("playbooks/p.md", text, exists).map((h) => h.message),
    ["references/Old_Notes.v2.md names no file in the plugin"]
  );
});

test("bare-exists: a bare path that names no file fails; longer paths and placeholders do not count", () => {
  const exists = (rel) => rel === "references/real.md";
  const text =
    "Owners: references/real.md and references/gone.md.\n" +
    "Docs at docs/playbooks/x.md and tests/fixtures/references/y.md; template references/<name>.md.\n" +
    "```\nreferences/also-gone.md\n```\n";
  assert.deepEqual(rules(bareExistsErrors("playbooks/p.md", text, exists)), ["bare-exists@1"]);
});

test("reference-read: a reference only ever named bare has no consumer; a prefixed citation or a script consumes it", () => {
  const hits = referenceReadErrors({
    references: ["README.md", "named.md", "cited.md", "scripted.md"],
    surface: [
      { rel: "playbooks/p.md", text: "Owner: references/named.md.\n" },
      { rel: "playbooks/q.md", text: `Read \`${P}/references/cited.md\`.\n` },
    ],
    scripts: [{ rel: "scripts/s.mjs", text: 'const p = "references/scripted.md";\n' }],
  });
  assert.deepEqual(hits.map((h) => h.rel), ["references/named.md"]);
  assert.match(hits[0].message, /no consumer/);
});

test("reference-read: a script consumes a reference only in code — a comment naming it does not count", () => {
  const hits = referenceReadErrors({
    references: ["commented.md", "blocked.md", "joined.md", "literal.md", "url.md", "after-url.md"],
    surface: [],
    scripts: [
      {
        rel: "scripts/s.mjs",
        text:
          "// references/commented.md owns the formula\n" +
          "/* references/blocked.md\n   owns this too */\n" +
          'const at = "https://example.com", next = "references/after-url.md"; // references/commented.md again\n' +
          'const p = join(root, "..", "references", "joined.md");\n' +
          "const q = `${root}/references/literal.md`;\n" +
          'const u = new URL("../references/url.md", import.meta.url);\n',
      },
    ],
  });
  assert.deepEqual(hits.map((h) => h.rel), ["references/commented.md", "references/blocked.md"]);
});

test("reference-read: the validator naming a reference is not a consumer", () => {
  const hits = referenceReadErrors({
    references: ["checked.md"],
    surface: [],
    scripts: [{ rel: "scripts/validate.mjs", text: 'fail("references/checked.md: bad");\n' }],
  });
  assert.deepEqual(hits.map((h) => h.rel), ["references/checked.md"]);
});

test("CLI --references: lists a reference nothing reads prefixed, across the whole tree", () => {
  const dir = makeTempDir("citation-grammar-");
  try {
    writeInto(dir, "references/read.md", "# Read\n");
    writeInto(dir, "references/named.md", "# Named\n");
    writeInto(dir, "agents/a.md", `Read \`${P}/references/read.md\`.\n`);
    writeInto(dir, "playbooks/p.md", "The owner is `references/named.md`.\n");
    const r = spawnSync(process.execPath, [SCRIPT, "--references"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /references\/named\.md:0 {2}reference-read/);
    assert.doesNotMatch(r.stdout, /references\/read\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reference-read: a reference citing itself is not its own consumer", () => {
  const hits = referenceReadErrors({
    references: ["self.md"],
    surface: [{ rel: "references/self.md", text: `See \`${P}/references/self.md\`.\n` }],
    scripts: [],
  });
  assert.deepEqual(hits.map((h) => h.rel), ["references/self.md"]);
});

test("CLI: lists hits with file:line and exits 1, then exits 0 once the files are clean", () => {
  const dir = makeTempDir("citation-grammar-");
  try {
    writeInto(dir, "references/ledger.md", "# Ledger\n");
    writeInto(dir, "playbooks/p.md", `Its rule \`${P}/references/ledger.md\` owns.\n`);
    const red = spawnSync(process.execPath, [SCRIPT, "playbooks/p.md"], { cwd: dir, encoding: "utf8" });
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stdout, /playbooks\/p\.md:1 {2}owner-sentence/);
    assert.match(red.stdout, /citation-grammar: 1 hit\(s\) in 1 file\(s\)/);
    writeInto(dir, "playbooks/p.md", "Its rule `references/ledger.md` owns.\n");
    const green = spawnSync(process.execPath, [SCRIPT, "--json"], { cwd: dir, encoding: "utf8" });
    assert.equal(green.status, 0, green.stderr);
    assert.deepEqual(JSON.parse(green.stdout), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a ./-prefixed or absolute path is the same file as its relative form; a path outside the root is refused", () => {
  const dir = makeTempDir("citation-grammar-");
  try {
    writeInto(dir, "playbooks/p.md", "# P\n");
    writeInto(dir, "references/r.md", `Uses \`${P}/playbooks/p.md\`.\n`);
    for (const arg of ["./references/r.md", join(dir, "references", "r.md")]) {
      const r = spawnSync(process.execPath, [SCRIPT, arg], { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 1, `${arg}: ${r.stderr}`);
      assert.match(r.stdout, /^references\/r\.md:1 {2}back-edge/m, arg);
    }
    const outside = spawnSync(process.execPath, [SCRIPT, "../elsewhere.md"], { cwd: dir, encoding: "utf8" });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /citation-grammar: outside the plugin root: \.\.\/elsewhere\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a named file that does not exist is a usage error, not a clean pass", () => {
  const dir = makeTempDir("citation-grammar-");
  try {
    const r = spawnSync(process.execPath, [SCRIPT, join("playbooks", "nope.md")], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no such file: playbooks\/nope\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
