#!/usr/bin/env node
// #257: fixtures leaked because 217 call sites each owned their own cleanup and none performed
// it. scripts/temp-dir.mjs now owns that lifetime; this check keeps it that way, because a
// convention enforced only by review is how the count reached 217 in the first place.
//
// Scope is the ESM surface makeTempDir serves: scripts/, tests/, hooks/. workflows/*.js is
// CommonJS and out of scope — both of its sites already remove their directory explicitly
// (workflows/review-panel.js:462, workflows/mechanical-sweep.js:512-514), so scanning them
// would report a violation where there is no leak.
//
// Only tmpdir()-ROOTED calls are violations. `mkdtempSync(join(dir, "..."))` nested inside an
// already-registered parent is legal and stays legal: removing the parent takes the child.
//
// KNOWN LIMITS: the matcher is syntactic and recognises the `join(tmpdir(), ...)` argument
// shape only. A template-literal root (mkdtempSync(`${tmpdir()}/x-`)) and a hoisted alias
// (const TMP = tmpdir(); mkdtempSync(join(TMP, "y-"))) both leak and are both missed —
// recognising either needs a parser rather than a regex, so review still owns those two forms.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const SCAN_DIRS = ["scripts", "tests", "hooks"];
// Assembled rather than written as one literal: golden-path.test.mjs's C3 leg 2 decides a
// module has a non-test importer by searching consumers for `/<module>"`, and spelling the
// exempt path out in full here — in code or in a comment — would satisfy that search from a
// file that imports nothing, hiding the very dead-module state leg 2 exists to catch.
const ALLOWED = ["scripts", "temp-dir.mjs"].join("/");
// Matched against the whole file text, not line by line, so a call wrapped across lines is
// caught too; the `\w+\.` qualifiers cover the `os.tmpdir()` and `path.join()` spellings that
// a copy-paste from the CommonJS surface brings along.
const ROOTED = /mkdtempSync\(\s*(?:[\w$]+\.)?join\(\s*(?:[\w$]+\.)?tmpdir\(\)/g;

const args = process.argv.slice(2);
const KNOWN_FLAGS = { "--dir": "value" };
let explicitDir = null;
try {
  const { flags } = parseFlags(args, KNOWN_FLAGS);
  explicitDir = requireValue(flags, "--dir") ?? null;
} catch (err) {
  console.error(`temp-dir-check: ${err.message}`);
  process.exit(1);
}
const root = explicitDir ?? process.cwd();

const abort = (m) => {
  console.error(`temp-dir-check: ${m}`);
  process.exit(1);
};

// A --dir that names nothing, or names a file, fails with this script's own diagnostic rather
// than being walked into an empty result that would read as a pass.
if (explicitDir !== null && (!existsSync(root) || !statSync(root).isDirectory())) {
  abort(`--dir ${explicitDir} is not a directory`);
}

// Read errors propagate: a directory that cannot be listed is reported, never skipped — a
// silently skipped subtree is a false green.
function collect(dir) {
  const out = [];
  for (const name of [...readdirSync(dir)].sort()) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p));
    else if (p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const violations = [];
let scanned = 0;
for (const dir of SCAN_DIRS) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const file of collect(abs)) {
    scanned++;
    const rel = relative(root, file).split(sep).join("/");
    if (rel === ALLOWED) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(ROOTED)) {
      violations.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
}

// Scanning nothing is not a pass: without this, running the documented `node
// scripts/temp-dir-check.mjs` from a subdirectory reports the same ok as a clean repository.
if (scanned === 0) {
  abort(`no .mjs files under ${SCAN_DIRS.map((d) => d + "/").join(", ")} in ${root} — nothing was checked`);
}

if (violations.length > 0) {
  console.error(
    "TEMP-DIR CHECK FAILED: these call sites create a temp directory nobody removes.\n" +
      "Use makeTempDir(prefix) from scripts/temp-dir.mjs instead:\n" +
      violations.map((v) => " - " + v).join("\n")
  );
  process.exit(1);
}
console.log("temp-dir-check: ok");
