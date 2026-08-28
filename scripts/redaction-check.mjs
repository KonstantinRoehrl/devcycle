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
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const args = process.argv.slice(2);
// --auto-redact and --advisory-identity are the valueless flags here; --hashes names a deny-list
// file and takes one. Declaring that arity is what stops `--dir <clean> --auto-redact <leaky>`
// from scanning only the clean corpus and printing `redaction: ok` over a leaky one it never
// opened.
const KNOWN_FLAGS = {
  "--file": "value", "--dir": "value", "--hashes": "value", "--auto-redact": "none",
  "--advisory-identity": "none",
};
// Flag parsing lives in cli-flags.mjs, which owns it for every script here. This script keeps its
// own message prefix and exit code by catching what that module throws: an unknown flag (a typo
// such as `--fil`) and a flag whose value is missing or blank are both hard errors rather
// than silent pass-throughs — `--dir .devcycle` is this script's privacy gate over files
// `git ls-files` cannot see, and a caller whose flag was never read still gets `redaction: ok`
// against the wrong corpus. A dropped flag name is the same false green: this script takes no
// positional, so cli-flags.mjs refuses the bare token in `redaction-check.mjs .devcycle` rather
// than falling back to `git ls-files` and reporting a corpus it never opened clean.
let flags;
try {
  ({ flags } = parseFlags(args, KNOWN_FLAGS));
} catch (err) {
  console.error(`redaction-check: ${err.message}`);
  process.exit(1);
}
const read = (name) => {
  try {
    return requireValue(flags, name);
  } catch (err) {
    console.error(`redaction-check: ${err.message}`);
    process.exit(1);
  }
};
const dir = read("--dir");
// A second caller for the same engine: `--dir` and `git ls-files` both scan a corpus, and an
// issue draft is neither — it is one untracked file that must be screened before it is shown
// to the user. Takes precedence over --dir so a caller passing both gets the narrower scan
// rather than a silently widened one.
const file = read("--file");
// The playbook invokes this script by its absolute ${CLAUDE_PLUGIN_ROOT} path from inside the
// *user's own repo*, so cwd is never this repo. The default must resolve against this script's
// own directory, not cwd, or the deny-list is unreadable on every such invocation. An explicit
// --hashes keeps its current (cwd-relative or absolute) meaning.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const hashesPath = read("--hashes") ?? join(SCRIPT_DIR, "redaction-hashes.txt");
// Declared valueless above, so presence in argv is the whole meaning: "rewrite in place before
// scanning". A token following it is not its value and is refused as an unexpected argument.
const autoRedact = "--auto-redact" in flags;
// Downgrades the three machine-identity classes to advisory (reported, exit 0) — for a
// gitignored local-only corpus (`.devcycle/`) where those forms are the expected shape, not a
// leak. Deny-listed terms are NEVER downgraded: a real secret is a leak in any corpus.
const advisoryIdentity = "--advisory-identity" in flags;

// --auto-redact rewrites files in place, and a scan pattern has known false positives (a public
// UUID, a URL containing "/Users/"). Without an explicit corpus, listFiles() falls back to
// `git ls-files` — so an unscoped --auto-redact could silently mutate committed source on a
// false-positive match. Require the caller to name the corpus it may rewrite.
if (autoRedact && !dir && !file) {
  console.error(
    "redaction-check: --auto-redact requires an explicit --dir or --file (refusing to rewrite the whole tracked tree in place)"
  );
  process.exit(1);
}

// A --dir that names nothing, or names a file, must fail with this script's own diagnostic — not a
// raw ENOENT/ENOTDIR thrown out of readdirSync inside walk(). --file keeps its own read-time guard
// in the scan loop below; this guards the directory walk's entry.
if (dir !== undefined && (!existsSync(dir) || !statSync(dir).isDirectory())) {
  console.error(`redaction-check: --dir ${dir} is not a directory`);
  process.exit(1);
}

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

// Ordered rewrite table for --auto-redact. The project-directory form is redacted BEFORE the
// generic home-directory path, because the project form embeds a path-like span and must be
// collapsed as one unit before the narrower path patterns can bite into it. Each pattern is the
// global-flag twin of its detector in PATTERNS, so what the scan flags is exactly what a rewrite
// removes — auto-redact then re-scan cannot disagree on any class.
const REDACTIONS = [
  { re: new RegExp("projects/-(?:" + U + "|" + H + ")-[A-Za-z0-9_.-]+", "g"), to: "<redacted-project>" },
  { re: new RegExp("/" + U + "/" + "[A-Za-z0-9_.-]+", "g"), to: "<redacted-path>" },
  { re: new RegExp("/" + H + "/" + "[a-z_][a-z0-9_.-]*", "g"), to: "<redacted-path>" },
  { re: new RegExp("[A-Za-z]:\\\\" + U + "\\\\[A-Za-z0-9_.-]*", "g"), to: "<redacted-path>" },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, to: "<redacted-session>" },
];

// Applies every REDACTIONS substitution then the deny-term replacement, using the same tokenizer
// and hash source the scan does, so a rewritten file re-scans clean. Returns the rewritten text
// and how many spans it replaced, so the caller can report each mutation rather than making it
// silently — a false-positive rewrite must be visible, not invisible.
function redactText(text) {
  let out = text;
  let count = 0;
  for (const { re, to } of REDACTIONS) out = out.replace(re, () => { count++; return to; });
  for (const token of new Set(out.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])) {
    if (!hashes.has(sha(token))) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("\\b" + escaped + "\\b", "gi"), () => { count++; return "<redacted-term>"; });
  }
  return { out, count };
}

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
const advisories = [];
const rewritten = []; // {f, count} per file --auto-redact actually changed, for the visible summary
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
  // Rewrite in place first, then fall through to the normal scan so the exit code reflects the
  // POST-rewrite state. SELF_EXEMPT files are skipped above and so are never rewritten.
  if (autoRedact) {
    const { out: redacted, count } = redactText(text);
    if (redacted !== text) {
      writeFileSync(join(root, f), redacted);
      text = redacted;
      rewritten.push({ f, count });
    }
  }
  // Line-anchored so an inline `redaction-allow` marker can exempt one line from the
  // machine-identity classes (never from a deny-listed term). Every PATTERNS class is a
  // machine-identity form, so under --advisory-identity every class match is advisory.
  const firedClasses = new Set();
  for (const line of text.split("\n")) {
    if (line.includes("redaction-allow")) continue;
    for (const p of PATTERNS) if (p.re.test(line)) firedClasses.add(p.class);
  }
  for (const cls of firedClasses) {
    const msg = `${f}: contains ${cls} (redact it)`;
    (advisoryIdentity ? advisories : errors).push(msg);
  }
  for (const token of new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []))
    if (hashes.has(sha(token))) errors.push(`${f}: contains a deny-listed term ("${token[0]}…", redact it)`);
}

// Report every in-place mutation by file and span count (never the redacted text — a log is as
// public as the repo), so a false-positive rewrite of legitimate content is visible rather than
// silent. Named after the scan so the summary sits with the classes that survived, if any.
if (autoRedact) {
  const total = rewritten.reduce((n, r) => n + r.count, 0);
  process.stderr.write(
    rewritten.length
      ? `redaction-check: auto-redacted ${total} span(s) across ${rewritten.length} file(s): ` +
          rewritten.map((r) => `${r.f} (${r.count})`).join(", ") + "\n"
      : "redaction-check: auto-redact made no changes\n"
  );
}

// Advisory machine-identity findings never set the exit code — they are reported so the
// operator can still choose to --auto-redact a local-only corpus, not blocked. Never the
// matched text (a log is as public as the repo), only the class and file.
if (advisories.length)
  process.stderr.write(
    "redaction-check: advisory (machine identity in local-only corpus, not blocking):\n" +
      advisories.map((a) => " - " + a).join("\n") + "\n"
  );

if (errors.length) {
  console.error("REDACTION CHECK FAILED:\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("redaction: ok");
