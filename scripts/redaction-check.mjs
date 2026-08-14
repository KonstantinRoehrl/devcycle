#!/usr/bin/env node
// Fails if scanned files carry machine identity or a deny-listed term.
//
// Division of labour with CI's secret scanner: gitleaks owns credentials and tokens — it is
// rule-maintained, and it reads history, which this script cannot. This script owns the
// privacy classes that are specific to how devcycle runs and that no generic scanner knows
// about: absolute home-directory paths, session ids, and the escaped project-directory form
// that binds a transcript path to one person's machine.
//
// Known limit, stated rather than implied: verbatim transcript *excerpts* are not detected.
// There is no reliable signature for "this prose was copied out of a session", so that class
// is held by review and by keeping excerpt-carrying artifacts out of the tracked tree.
//
// The deny-list stores sha256 hashes so the forbidden terms never appear in the public repo.
// No failure message ever reprints what it matched — a CI log is as public as the repo.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
// A flag's value must be an explicit, non-empty path: a missing value (the flag was the last
// token, or is immediately followed by another flag) and an empty or whitespace-only value are
// the same operator mistake in two guises — e.g. `--file "$draft"` for an unset shell variable
// — and both must fail loudly, naming the flag, rather than silently widening the scan to the
// whole corpus.
function requireValue(name) {
  if (!args.includes(name)) return undefined;
  const v = flagValue(name);
  if (v == null || v.trim() === "" || v.startsWith("--")) {
    console.error(`redaction-check: ${name} requires a path argument`);
    process.exit(1);
  }
  return v;
}
const dir = requireValue("--dir");
// A second caller for the same engine: `--dir` and `git ls-files` both scan a corpus, and an
// issue draft is neither — it is one untracked file that must be screened before it is shown
// to the user. Takes precedence over --dir so a caller passing both gets the narrower scan
// rather than a silently widened one.
const file = requireValue("--file");
// The playbook invokes this script by its absolute ${CLAUDE_PLUGIN_ROOT} path from inside the
// *user's own repo*, so cwd is never this repo. The default must resolve against this script's
// own directory, not cwd, or the deny-list is unreadable on every such invocation. An explicit
// --hashes keeps its current (cwd-relative or absolute) meaning.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const hashesPath = requireValue("--hashes") ?? join(SCRIPT_DIR, "redaction-hashes.txt");

const SELF_EXEMPT = ["scripts/redaction-check.mjs", "scripts/redaction-hashes.txt"];
const hashes = new Set(
  readFileSync(hashesPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
);
const sha = (s) => createHash("sha256").update(s).digest("hex");

// Patterns are assembled from fragments so this file never matches itself — the self-exemption
// above is a second line of defence, not the only one.
const U = "Users";
const H = "home";
const PATTERNS = [
  { class: "an absolute home-directory path", re: new RegExp("/" + U + "/" + "[A-Za-z0-9_.-]+") },
  { class: "an absolute home-directory path", re: new RegExp("/" + H + "/" + "[a-z_][a-z0-9_.-]*") },
  { class: "an absolute home-directory path", re: new RegExp("[A-Za-z]:\\\\" + U + "\\\\") },
  {
    class: "a session id",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  },
  {
    // The form Claude Code gives a transcript directory: the project's absolute path with
    // every separator turned into a dash. It survives every slash-shaped pattern above.
    class: "a local project directory",
    re: new RegExp("projects/-(?:" + U + "|" + H + ")-[A-Za-z0-9_.-]+"),
  },
];

function walk(root, base = root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

// Git's own file list is the right corpus in a checkout: it respects .gitignore, so the scan
// stays on what the repo actually publishes. Outside one — a `git archive` extraction, an
// unpacked release tarball — there is no such list and `git ls-files` dies, so the working
// tree stands in, minus the two directories a checkout would never publish anyway.
function listFiles() {
  if (file) return [basename(file)];
  if (dir) return walk(dir);
  try {
    return execSync("git ls-files", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter(Boolean);
  } catch {
    process.stderr.write(
      "redaction-check: not a git checkout — scanning the working tree instead (.git and node_modules excluded)\n"
    );
    return walk(process.cwd());
  }
}

// Entries are always relative to `root`, so a --file path is split into the two: an absolute
// path joined onto cwd resolves to a file that does not exist, and the scan would read as clean.
const root = file ? dirname(file) : (dir ?? process.cwd());
const files = listFiles();
// Scanning nothing is not a pass: an empty corpus would report the same `redaction: ok`
// as a clean one.
if (files.length === 0) {
  console.error(`redaction-check: no files to scan under ${root}`);
  process.exit(1);
}

const errors = [];
for (const f of files) {
  if (SELF_EXEMPT.includes(f)) continue;
  let text;
  try {
    text = readFileSync(join(root, f), "utf8");
  } catch (err) {
    // A file the caller named explicitly must not read as clean when it cannot be read; a
    // member of a scanned corpus that is binary still legitimately skips.
    if (file) {
      console.error(`redaction-check: cannot read ${f} (${err.code ?? err.message})`);
      process.exit(1);
    }
    continue; // binary
  }
  for (const cls of new Set(PATTERNS.filter((p) => p.re.test(text)).map((p) => p.class)))
    errors.push(`${f}: contains ${cls} (redact it)`);
  for (const token of new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []))
    if (hashes.has(sha(token))) errors.push(`${f}: contains a deny-listed term ("${token[0]}…", redact it)`);
}

if (errors.length) {
  console.error("REDACTION CHECK FAILED:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("redaction: ok");
