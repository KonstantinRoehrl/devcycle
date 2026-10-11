// scripts/md-sections.mjs: one owner for splitting a markdown file into `##` sections and for the
// heading slug that names one.
import test from "node:test";
import assert from "node:assert/strict";
import { slug, sections, sectionText } from "../../scripts/md-sections.mjs";

const DOC = [
  "# Title",
  "",
  "Preamble line.",
  "",
  "## First",
  "",
  "First body.",
  "",
  "### Nested",
  "",
  "Nested body.",
  "",
  "```md",
  "## Not a heading",
  "```",
  "",
  "## Second",
  "",
  "Second body.",
  "",
  "# Top again",
  "",
  "Between.",
  "",
  "## Last",
  "",
  "Last body.",
  "",
].join("\n");

const preamble = (text) => text.slice(0, text.indexOf(sections(text)[0].text));

test("sections: a ### subsection stays inside its ## section", () => {
  const first = sectionText(DOC, "first");
  assert.match(first, /^## First\n/);
  assert.match(first, /### Nested\n\nNested body\./);
});

test("sections: a fenced ## line is content, not a heading", () => {
  assert.deepEqual(sections(DOC).map((s) => s.heading), ["First", "Second", "Last"]);
  assert.match(sectionText(DOC, "first"), /```md\n## Not a heading\n```\n/);
});

test("sections: only a fence of the opener's character, at least as long and bare, closes it", () => {
  const nested = "## A\n````md\n```\n## Inner\n```\n````\nafter\n## B\nb\n";
  assert.deepEqual(sections(nested).map((s) => s.slug), ["a", "b"]);
  const mixed = "## A\n~~~\n```\n## Inner\n~~~ md\n## Still inner\n~~~~\n## B\n";
  assert.deepEqual(sections(mixed).map((s) => s.slug), ["a", "b"]);
});

test("sections: a # heading ends a section", () => {
  assert.equal(sectionText(DOC, "second"), "## Second\n\nSecond body.\n\n");
});

test("sections: the last section runs to the end of the file", () => {
  assert.equal(sectionText(DOC, "last"), "## Last\n\nLast body.\n");
});

test("sections: preamble text belongs to no section", () => {
  assert.equal(preamble(DOC), "# Title\n\nPreamble line.\n\n");
  assert.ok(sections(DOC).every((s) => !s.text.includes("Preamble line.")));
});

test("sections: the preamble plus every section's text joined is the whole file", () => {
  // Only where `#` opens the file: text under a later `#` heading belongs to no `##` section.
  const doc = "# T\n\npre\n\n## A\n\na\n\n## B\n\nb";
  assert.equal(preamble(doc) + sections(doc).map((s) => s.text).join(""), doc);
});

test("slug: the GitHub-style heading slug", () => {
  assert.equal(slug("The state file's `configured:` line"), "the-state-files-configured-line");
  assert.equal(slug("Doc tracking — what each policy commits"), "doc-tracking-what-each-policy-commits");
  assert.deepEqual(sections(DOC).map((s) => s.slug), ["first", "second", "last"]);
});

test("sectionText: an unknown slug is null", () => {
  assert.equal(sectionText(DOC, "nope"), null);
});
