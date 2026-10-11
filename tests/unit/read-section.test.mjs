// scripts/read-section.mjs: prints one `##` section of a plugin reference, resolved against the
// plugin root rather than the cwd.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { readSection } from "../../scripts/read-section.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/read-section.mjs", import.meta.url));
const root = makeTempDir("read-section-");
writeInto(root, "references/a.md", "# A\n\nPreamble.\n\n## Wanted part\n\nBody.\n\n## Other\n\nElse.\n");
after(() => rmSync(root, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("readSection: returns the named section of a reference under the given root", () => {
  assert.equal(readSection("references/a.md", "wanted-part", root), "## Wanted part\n\nBody.\n\n");
});

test("readSection: an unknown slug throws", () => {
  assert.throws(() => readSection("references/a.md", "nope", root), /no section "nope" in references\/a\.md/);
});

test("readSection: a missing reference throws", () => {
  assert.throws(() => readSection("references/missing.md", "wanted-part", root), /no such file references\/missing\.md/);
});

test("readSection: a path outside references/ throws before any read", () => {
  for (const file of ["playbooks/a.md", "../x.md"])
    assert.throws(() => readSection(file, "wanted-part", root), /is not a plugin reference path \(references\/<name>\.md\)/);
});

test("CLI: prints a real reference's section and exits 0", () => {
  const r = run("references/delegation.md", "the-stage-budget");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("## The stage budget"), r.stdout.slice(0, 80));
});

test("CLI: an unknown slug exits 1 with the error on stderr", () => {
  const r = run("references/delegation.md", "nope");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^read-section: no section/);
  assert.equal(r.stdout, "");
});

test("CLI: a wrong argument count prints the usage and exits 1", () => {
  const r = run("references/delegation.md");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^read-section: usage: read-section\.mjs references\/<file>\.md <section-slug>/);
});
