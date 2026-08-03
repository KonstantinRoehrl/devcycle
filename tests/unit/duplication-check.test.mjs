import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/duplication-check.mjs");

function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "dup-check-"));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}

test("flags a near-duplicate paragraph across two different files", () => {
  const paragraph =
    "The coordinator commits from wave one onward using an explicit pathspec that " +
    "covers only the task's own source files, never a bare git commit and never git " +
    "add -A, because concurrent implementers have in-flight edits elsewhere in the tree.";
  const dir = makeFixture({
    "a.md": `# A\n\n${paragraph}\n`,
    "b.md": `# B\n\n${paragraph}\n`,
  });
  try {
    assert.throws(() => execFileSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes a corpus with no near-duplicate paragraphs across files", () => {
  const dir = makeFixture({
    "a.md": "# A\n\nThis paragraph is entirely about topic A and shares no real overlap.\n",
    "b.md": "# B\n\nThis paragraph covers topic B, a completely different subject.\n",
  });
  try {
    const out = execFileSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" });
    assert.match(out, /duplication-check: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not flag a paragraph repeated within the same file", () => {
  const paragraph = "This exact paragraph appears twice in one file on purpose.";
  const dir = makeFixture({
    "a.md": `# A\n\n${paragraph}\n\n## Again\n\n${paragraph}\n`,
  });
  try {
    const out = execFileSync("node", [SCRIPT, "--dir", dir], { encoding: "utf8" });
    assert.match(out, /duplication-check: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
