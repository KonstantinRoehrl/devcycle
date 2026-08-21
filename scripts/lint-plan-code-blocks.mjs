#!/usr/bin/env node
// Lints the JS/mjs code blocks pasted into a plan or spec before they reach a task brief. Given a
// plan path it lints exactly that file, wherever it lives; with no path it sweeps the local
// planning scratch — docs/superpowers/plans/ and docs/superpowers/specs/ — under --dir or the cwd.
// Both scan directories are gitignored, local-only, and normally absent (including in this repo's
// own CI); their absence is the expected case for a sweep, not an error. An explicit path that
// names nothing IS an error: a gate pointed at a target that found nothing has not passed.
import {
  readFileSync, readdirSync, existsSync, statSync, accessSync, constants,
  mkdtempSync, writeFileSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const args = process.argv.slice(2);
const USAGE =
  "lint-plan-code-blocks: usage: lint-plan-code-blocks.mjs <plan-path> | [--dir <root>]";
const die = (msg) => { console.error(msg); process.exit(1); };

const KNOWN_FLAGS = { "--dir": "value" };
let root = null;
let explicitPath = null;
try {
  // The only script here that legitimately takes a positional, so it is the only one that opts
  // out of cli-flags.mjs's default refusal of bare tokens.
  const { flags, positionals } = parseFlags(args, KNOWN_FLAGS, { allowPositionals: true });
  if (positionals.length > 1) die(`${USAGE}\nlint-plan-code-blocks: unexpected extra argument "${positionals[1]}"`);
  root = requireValue(flags, "--dir") ?? null;
  explicitPath = positionals[0] ?? null;
} catch (err) {
  // A flag whose value is missing, or that was never read at all, is a usage error, never a
  // silently absent flag.
  die(`${USAGE}\nlint-plan-code-blocks: ${err.message}`);
}
// The two name different targets; preferring one silently is the defect class this gate exists
// to catch, so the combination is refused rather than resolved.
if (explicitPath !== null && root !== null)
  die(`${USAGE}\nlint-plan-code-blocks: a plan path and --dir name different targets — pass one`);
if (root === null) root = process.cwd();

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

let files;
if (explicitPath !== null) {
  // Handed a target and unable to read it: a gate that was pointed at something and found
  // nothing has not passed.
  if (!existsSync(explicitPath))
    die(`lint-plan-code-blocks: ${explicitPath}: no such file`);
  // existsSync is equally true for a directory and for a file this process may not open, and
  // both reach readFileSync below, where they throw a raw Node stack trace that reads as a
  // broken tool rather than a failed gate. Refuse them here in the same path-naming style.
  if (!statSync(explicitPath).isFile())
    die(`lint-plan-code-blocks: ${explicitPath}: not a file`);
  try {
    accessSync(explicitPath, constants.R_OK);
  } catch {
    die(`lint-plan-code-blocks: ${explicitPath}: not readable`);
  }
  files = [explicitPath];
} else {
  files = SCAN_DIRS.flatMap((d) => mdFiles(join(root, d)));
  if (files.length === 0) {
    // The scan dirs are gitignored and normally absent; a discovery sweep that finds nothing
    // is the expected case, not a failure. Only an explicit target makes emptiness an error.
    console.log(`lint-plan-code-blocks: no plan/spec files found under ${root}`);
    process.exit(0);
  }
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
