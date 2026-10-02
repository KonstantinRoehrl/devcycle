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
