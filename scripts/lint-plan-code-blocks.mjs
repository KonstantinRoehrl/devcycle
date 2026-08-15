#!/usr/bin/env node
// Lints the JS/mjs code blocks pasted into local planning scratch — docs/superpowers/plans/
// and docs/superpowers/specs/ — before they reach a task brief. Both directories are
// gitignored, local-only, and normally absent (including in this repo's own CI); their
// absence is the expected case, not an error. Each ```js/```javascript/```mjs fenced block
// is written to a temp .mjs file and syntax-checked with `node --check`, which treats the
// .mjs extension as ESM — matching what plan snippets in this all-ESM repo actually are.
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dirFlagIdx = args.indexOf("--dir");
const root = dirFlagIdx === -1 ? process.cwd() : args[dirFlagIdx + 1];

const SCAN_DIRS = ["docs/superpowers/plans", "docs/superpowers/specs"];
const LINTED_LANGS = new Set(["js", "javascript", "mjs"]);
// Non-greedy match between paired ```lang\n fences and a line-starting closing ```: plan
// files in this repo's format never nest a triple-backtick fence inside another fence.
const FENCE_RE = /```([a-zA-Z0-9]*)\n([\s\S]*?)\n```/g;

function mdFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name));
}

const files = SCAN_DIRS.flatMap((d) => mdFiles(join(root, d)));

if (files.length === 0) {
  console.log("lint-plan-code-blocks: no plan/spec files found");
  process.exit(0);
}

const failures = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  let blockNum = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const lang = match[1].toLowerCase();
    const code = match[2];
    if (!LINTED_LANGS.has(lang)) continue;
    blockNum += 1;
    const tmpDir = mkdtempSync(join(tmpdir(), "lint-plan-code-block-"));
    const tmpFile = join(tmpDir, "block.mjs");
    try {
      writeFileSync(tmpFile, code, "utf8");
      const result = spawnSync(process.execPath, ["--check", tmpFile], { encoding: "utf8" });
      if (result.status !== 0) {
        const firstLine = (result.stderr ?? "").split("\n").find((l) => l.trim() !== "") ?? "(no output)";
        failures.push(`${file}: block ${blockNum} -- ${firstLine}`);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}

console.log("lint-plan-code-blocks: ok");
process.exit(0);
