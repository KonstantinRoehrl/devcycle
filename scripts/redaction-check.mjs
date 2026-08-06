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
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const dir = flagValue("--dir");
const hashesPath = flagValue("--hashes") ?? "scripts/redaction-hashes.txt";

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

const root = dir ?? process.cwd();
const files = dir ? walk(dir) : execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);

const errors = [];
for (const f of files) {
  if (SELF_EXEMPT.includes(f)) continue;
  let text;
  try {
    text = readFileSync(join(root, f), "utf8");
  } catch {
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
