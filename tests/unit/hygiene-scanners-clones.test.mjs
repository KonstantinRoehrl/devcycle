import { test } from "node:test";
import assert from "node:assert/strict";
import { sameBodyHelpers, semanticIndex } from "../../scripts/hygiene-scanners-clones.mjs";
import { loadRegistry } from "../../scripts/hygiene-registry.mjs";

const ctx = (tree) => ({ files: Object.keys(tree), read: (f) => tree[f] ?? null });
const brief = (c) => `${c.kind}|${c.file}|${c.line}|${c.symbol}|${c.clusterKey}|${c.anchor === c.clusterKey}`;

test("differently named helpers with one normalized body form one duplicate-logic group", () => {
  const found = sameBodyHelpers.scan(ctx({
    "src/a.ts": "export function toSlug(text) {\n  return text.trim().toLowerCase().replace(/\\s+/g, \"-\");\n}\n",
    "src/b.ts": "// slug helper\nexport const makeSlug = (value) => {\n  // collapse spaces\n  return value.trim().toLowerCase().replace(/\\s+/g,  \"-\");\n};\n",
    "src/c.js": "const slugify = (v) => v.trim().toLowerCase().replace(/\\s+/g, \"-\");\n",
    "src/d.ts": "export function shout(text) {\n  return text.trim().toUpperCase().replace(/\\s+/g, \"-\");\n}\n",
  }));
  assert.deepEqual(found.map(brief), [
    "duplicate-logic|src/a.ts|1|toSlug|body makeSlug,slugify,toSlug|true",
    "duplicate-logic|src/b.ts|2|makeSlug|body makeSlug,slugify,toSlug|true",
    "duplicate-logic|src/c.js|1|slugify|body makeSlug,slugify,toSlug|true",
  ]);
  assert.equal(found[0].detail, "same body as makeSlug, slugify");
});

test("Python and Go helpers group the same way", () => {
  const found = sameBodyHelpers.scan(ctx({
    "a.py": "def to_slug(text):\n    return text.strip().lower().replace(\" \", \"-\").replace(\"_\", \"-\")\n",
    "b.py": "def make_slug(value):\n    # same thing\n    return value.strip().lower().replace(\" \", \"-\").replace(\"_\", \"-\")\n\nX = 1\n",
    "a.go": "func ToSlug(s string) string {\n\treturn strings.ReplaceAll(strings.ToLower(strings.TrimSpace(s)), \" \", \"-\")\n}\n",
    "b.go": "func (h Helper) MakeSlug(v string) string {\n\treturn strings.ReplaceAll(strings.ToLower(strings.TrimSpace(v)), \" \", \"-\")\n}\n",
  }));
  assert.deepEqual(found.map((c) => `${c.file}|${c.symbol}|${c.clusterKey}`), [
    "a.go|ToSlug|body MakeSlug,ToSlug", "a.py|to_slug|body make_slug,to_slug",
    "b.go|MakeSlug|body MakeSlug,ToSlug", "b.py|make_slug|body make_slug,to_slug",
  ]);
});

test("short bodies and one name repeated are never candidates", () => {
  assert.deepEqual(sameBodyHelpers.scan(ctx({
    "a.ts": "export function add(a, b) {\n  return a + b;\n}\n",
    "b.ts": "export function sum(x, y) {\n  return x + y;\n}\n",
    "c.ts": "export function toSlug(text) {\n  return text.trim().toLowerCase().replace(/\\s+/g, \"-\");\n}\n",
    "d.ts": "export function toSlug(text) {\n  return text.trim().toLowerCase().replace(/\\s+/g, \"-\");\n}\n",
  })), []);
});

test("the semantic index hands the judgment each file's function names and signatures", () => {
  const tree = {
    "src/b.py": "def format_date(value):\n    return value.isoformat()\n",
    "src/a.ts": "export function formatDate(d,\n    locale) {\n  return d.toLocaleDateString(locale);\n}\nconst pad = (n) => String(n).padStart(2, \"0\");\n",
    "README.md": "# notes\n",
    "src/none.ts": "export const X = 1;\n",
  };
  assert.deepEqual(semanticIndex.scan(ctx(tree)), []);
  assert.deepEqual(semanticIndex.material(ctx(tree)), [
    { key: "src/a.ts", kinds: ["semantic-duplicate"], file: "src/a.ts", truncated: false,
      functions: [{ name: "formatDate", params: "d, locale", line: 1 }, { name: "pad", params: "n", line: 5 }] },
    { key: "src/b.py", kinds: ["semantic-duplicate"], file: "src/b.py", truncated: false,
      functions: [{ name: "format_date", params: "value", line: 1 }] },
  ]);
});

test("the index caps functions per file and characters read per file", () => {
  const tree = {
    "many.js": Array.from({ length: 205 }, (_, i) => `function f${i}(a) {\n  return a;\n}\n`).join(""),
    "big.js": `function early(a) {\n  return a;\n}\n${"//\n".repeat(30_000)}function late(b) {\n  return b;\n}\n`,
  };
  const byFile = Object.fromEntries(semanticIndex.material(ctx(tree)).map((i) => [i.file, i]));
  assert.equal(byFile["many.js"].functions.length, 200);
  assert.equal(byFile["many.js"].truncated, true);
  assert.deepEqual(byFile["big.js"].functions.map((f) => f.name), ["early"]);
  assert.equal(byFile["big.js"].truncated, true);
});

test("both scanners are registered under the duplication sweep, the index on hotspot files only", () => {
  const { scanners } = loadRegistry();
  assert.deepEqual(scanners["same-body-helpers"], { sweep: "duplication", kinds: ["duplicate-logic"], stacks: null });
  assert.deepEqual(scanners["semantic-index"], { sweep: "duplication", kinds: ["semantic-duplicate"], stacks: null, scope: "hotspots" });
});
