import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = join(ROOT, "hooks", "devcycle-mod.mjs");
const SPECIFIER = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g;
const specifiers = (text) => [...text.matchAll(SPECIFIER)].map((m) => m[1] ?? m[2]);

// Every file the module's static imports reach: the module runs without Node, so each must too.
function closureOf(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8")))
      if (spec.startsWith("./") || spec.startsWith("../")) walk(resolve(dirname(file), spec));
  };
  walk(entry);
  return [...seen];
}

test("the hooks module's import closure is the node-free leaves and nothing else", () => {
  assert.deepEqual(closureOf(ENTRY).map((f) => relative(ROOT, f)).sort(), [
    "hooks/devcycle-mod.mjs", "hooks/lib/run-scope.mjs", "scripts/depth-bands.mjs", "scripts/md-field-core.mjs", "scripts/pricing.mjs",
  ]);
});

test("no file in that closure imports a node: or bare specifier, calls require, imports dynamically, or reads process", () => {
  for (const file of closureOf(ENTRY)) {
    const at = relative(ROOT, file);
    const text = readFileSync(file, "utf8");
    for (const spec of specifiers(text))
      assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${at} imports "${spec}" — only a relative ES import resolves without Node`);
    assert.doesNotMatch(text, /\brequire\s*\(/, `${at} calls require`);
    assert.doesNotMatch(text, /\bimport\s*\(/, `${at} imports dynamically`);
    assert.doesNotMatch(text, /(?<![\w.$])process\./, `${at} reads the Node process global`);
  }
});
