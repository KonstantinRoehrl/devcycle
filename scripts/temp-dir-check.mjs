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
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const SCAN_DIRS = ["scripts", "tests", "hooks"];
const ALLOWED = "scripts/temp-dir.mjs";
// Matches both spellings: `join(tmpdir(), ...)` in ESM and `join(os.tmpdir(), ...)` in the
// CommonJS style, so a copy-paste from either surface is caught.
const ROOTED = /mkdtempSync\(\s*join\(\s*(?:os\.)?tmpdir\(\)/;

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
for (const dir of SCAN_DIRS) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const file of collect(abs)) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel === ALLOWED) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (ROOTED.test(line)) violations.push(`${rel}:${i + 1}`);
      });
  }
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
