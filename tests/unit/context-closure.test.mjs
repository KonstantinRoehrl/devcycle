// scripts/context-closure.mjs: the citation walk behind validate.mjs check 15 and context-report.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { closure, countWords } from "../../scripts/context-closure.mjs";

const P = "${CLAUDE_PLUGIN_ROOT}";

const tree = () => {
  const dir = makeTempDir("context-closure-");
  writeInto(dir, "playbooks/a.md", `Read \`${P}/references/x.md\` and \`${P}/playbooks/b.md\`.\n`);
  writeInto(dir, "playbooks/b.md", `Then \`${P}/references/y.md\`.\n`);
  writeInto(dir, "references/x.md", `See \`${P}/references/y.md\` and \`${P}/playbooks/a.md\`.\n`);
  writeInto(dir, "references/y.md", `Back to \`${P}/references/x.md\`; the owner is references/z.md.\n`);
  writeInto(dir, "references/z.md", "never reached\n");
  return dir;
};

test("refs-only follows reference citations to a fixed point and counts a cycle once", () => {
  const dir = tree();
  try {
    const r = closure("playbooks/a.md", { follow: "refs", root: dir });
    assert.deepEqual(r.files, ["playbooks/a.md", "references/x.md", "references/y.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all-hops also follows playbook and command citations, and never follows a bare path", () => {
  const dir = tree();
  try {
    const r = closure("playbooks/a.md", { follow: "all", root: dir });
    assert.deepEqual(r.files, ["playbooks/a.md", "references/x.md", "playbooks/b.md", "references/y.md"]);
    assert.ok(!r.files.includes("references/z.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bytes and words are the sums over the closure's files", () => {
  const dir = tree();
  try {
    const r = closure("playbooks/a.md", { follow: "refs", root: dir });
    const texts = r.files.map((f) => readFileSync(join(dir, f), "utf8"));
    assert.equal(r.bytes, texts.reduce((n, t) => n + Buffer.byteLength(t), 0));
    assert.equal(r.words, texts.reduce((n, t) => n + countWords(t), 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cited file that does not exist is skipped, and a custom reader replaces the disk", () => {
  const files = { "playbooks/a.md": `Read \`${P}/references/gone.md\`.\n` };
  const r = closure("playbooks/a.md", { read: (rel) => files[rel] ?? null });
  assert.deepEqual(r.files, ["playbooks/a.md"]);
});

test("an unknown follow mode throws rather than walking nothing", () => {
  assert.throws(() => closure("playbooks/a.md", { follow: "some", read: () => "" }), /unknown follow mode "some"/);
});

test("countWords splits on any whitespace run", () => {
  assert.equal(countWords("  one two\n\tthree  "), 3);
});

// A section read (references/README.md § Citation grammar) loads one `##` section of a reference.
// `r.md` is assembled from literal sections so each expected byte count is independent of the parser.
const sectionRead = (rel, slug) => `\`node "${P}/scripts/read-section.mjs" ${rel} ${slug}\``;
const R_PREAMBLE = "# R\n\nPreamble.\n\n";
const R_A = `## A\n\nSee \`${P}/references/a-only.md\`.\n\n`;
const R_B = `## B\n\nSee \`${P}/references/b-only.md\`.\n`;
const R = R_PREAMBLE + R_A + R_B;
const memory = (files) => (rel) => files[rel] ?? null;
const bytesOf = (...texts) => texts.reduce((n, t) => n + Buffer.byteLength(t), 0);

test("a section read counts exactly that section's bytes and records its slug", () => {
  const book = `Run ${sectionRead("references/r.md", "b")}.\n`;
  const r = closure("playbooks/p.md", {
    read: memory({ "playbooks/p.md": book, "references/r.md": R_PREAMBLE + R_A + "## B\n\nPlain.\n" }),
  });
  assert.deepEqual(r.files, ["playbooks/p.md", "references/r.md"]);
  assert.deepEqual(r.sections, { "references/r.md": ["b"] });
  assert.equal(r.bytes, bytesOf(book, "## B\n\nPlain.\n"));
  assert.equal(r.words, countWords(book) + countWords("## B\n\nPlain.\n"));
});

test("a section read follows only the citations inside that section, in both follow modes", () => {
  const files = {
    "playbooks/p.md": `Run ${sectionRead("references/r.md", "b")}.\n`,
    "references/r.md": R,
    "references/a-only.md": "a\n",
    "references/b-only.md": "b\n",
  };
  for (const follow of ["refs", "all"]) {
    const r = closure("playbooks/p.md", { follow, read: memory(files) });
    assert.deepEqual(r.files, ["playbooks/p.md", "references/r.md", "references/b-only.md"], follow);
  }
});

test("two section reads count each section once, and a repeated read adds nothing", () => {
  const book = `Run ${sectionRead("references/r.md", "a")} and ${sectionRead("references/r.md", "b")}.\n`;
  const files = { "playbooks/p.md": book, "references/r.md": R, "references/a-only.md": "", "references/b-only.md": "" };
  const once = closure("playbooks/p.md", { read: memory(files) });
  assert.deepEqual(once.files, ["playbooks/p.md", "references/r.md", "references/a-only.md", "references/b-only.md"]);
  assert.deepEqual(once.sections, { "references/r.md": ["a", "b"] });
  assert.equal(once.bytes, bytesOf(book, R_A, R_B));
  const again = `${book}Again ${sectionRead("references/r.md", "a")}.\n`;
  const twice = closure("playbooks/p.md", { read: memory({ ...files, "playbooks/p.md": again }) });
  assert.deepEqual(twice.sections, once.sections);
  assert.equal(twice.bytes, once.bytes + bytesOf(again) - bytesOf(book));
});

test("a file read whole anywhere counts once, whole, whichever read comes first", () => {
  const leaves = { "references/a-only.md": "", "references/b-only.md": "" };
  // The section read is reached first; the whole read arrives one hop later through s.md.
  const sectionFirst = {
    ...leaves,
    "playbooks/p.md": `Run ${sectionRead("references/r.md", "b")}, then \`${P}/references/s.md\`.\n`,
    "references/s.md": `Read \`${P}/references/r.md\`.\n`,
    "references/r.md": R,
  };
  // The whole read is reached first; the section read arrives one hop later through s.md.
  const wholeFirst = {
    ...leaves,
    "playbooks/p.md": `Read \`${P}/references/r.md\` and \`${P}/references/s.md\`.\n`,
    "references/s.md": `Run ${sectionRead("references/r.md", "a")}.\n`,
    "references/r.md": R,
  };
  for (const [name, files] of Object.entries({ sectionFirst, wholeFirst })) {
    const r = closure("playbooks/p.md", { read: memory(files) });
    assert.equal(r.files.filter((f) => f === "references/r.md").length, 1, name);
    assert.deepEqual(r.sections, {}, name);
    assert.equal(r.bytes, bytesOf(files["playbooks/p.md"], files["references/s.md"], R), name);
  }
});

test("a section read whose slug names no section contributes nothing", () => {
  const book = `Run ${sectionRead("references/r.md", "missing")}.\n`;
  const r = closure("playbooks/p.md", { read: memory({ "playbooks/p.md": book, "references/r.md": R }) });
  assert.deepEqual(r.files, ["playbooks/p.md"]);
  assert.deepEqual(r.sections, {});
  assert.equal(r.bytes, bytesOf(book));
});
