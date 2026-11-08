#!/usr/bin/env node
// Picks the review engine for `reviewDepth: auto` from the measured size of a ref range.
// playbooks/reviewing-code.md § 3 owns when it runs; this file owns the thresholds, what the
// measurement leaves out, the risk scan and the repo risk file's format. scripts/risk-signals.mjs
// holds the built-in signal data.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlags } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { BUILTIN_SIGNALS } from "./risk-signals.mjs";

// Starting values, to be tuned from the run records' review-depth events.
export const PANEL_LINE_THRESHOLD = 400;
export const PANEL_FILE_THRESHOLD = 15;

const PROFILES = ["lean", "standard", "thorough"];
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock",
  "Gemfile.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "go.sum", "flake.lock",
]);
const GENERATED_DIRS = new Set(["dist", "build", "vendor", "node_modules"]);
const GENERATED_NAME = /\.min\.(?:js|css)$|\.map$|\.generated\./;
// git accepts these in a ref name and a shell does not (references/branch.md § Deriving a branch's
// file set); refused here too, so a name this script accepts is one a playbook can quote safely.
const SHELL_UNSAFE = /[$`'"\\;&|<>\n]/;

export function isExcluded(path) {
  const segments = path.split("/");
  const name = segments.pop();
  return LOCKFILES.has(name) || GENERATED_NAME.test(name) || segments.some((s) => GENERATED_DIRS.has(s));
}

const run = (args, cwd) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function git(args, cwd) {
  const r = run(args, cwd);
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? ((r.stderr ?? "").trim() || `exit ${r.status}`);
    throw new Error(`git ${args.join(" ")} failed (${why})`);
  }
  return r.stdout;
}

// Spelled the way this clone resolves it: the bare name, else origin/<name>.
function resolveRef(name, cwd) {
  if (SHELL_UNSAFE.test(name) || run(["check-ref-format", "--allow-onelevel", name], cwd).status !== 0)
    throw new Error(`"${name}" is not a valid ref name`);
  for (const spelling of [name, `origin/${name}`])
    if (run(["rev-parse", "--verify", "--quiet", `${spelling}^{commit}`], cwd).status === 0) return spelling;
  throw new Error(`neither "${name}" nor "origin/${name}" resolves in this clone`);
}

export const RISK_FILE = ".claude/devcycle-risk.json";
export const MAX_SIGNAL_PATHS = 3;
export class RiskFileError extends Error {}

// The patch is read hunk by hunk, so a removed line that itself starts with "-- " is content, never
// a header. The prefixes are passed explicitly because a user's diff.noprefix would drop them. A path
// git still quotes (a tab, a newline, a double quote) keeps its path signals but not its line signals.
export function rangeChanges({ base, branch, cwd = process.cwd() }) {
  const from = resolveRef(base, cwd);
  const to = resolveRef(branch, cwd);
  const mergeBase = git(["merge-base", from, to], cwd).trim();
  const files = new Map();
  const fields = git(["diff", "--name-status", "-z", "-M", mergeBase, to], cwd).split("\0");
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const renamed = code.startsWith("R") || code.startsWith("C");
    const path = fields[i + (renamed ? 2 : 1)];
    i += renamed ? 2 : 1;
    if (!isExcluded(path)) files.set(path, { path, status: renamed ? "R" : code[0], added: [], removed: [] });
  }
  const patch = git(["-c", "core.quotePath=false", "diff", "-U0", "--no-color", "--no-ext-diff", "-M",
    "--src-prefix=a/", "--dst-prefix=b/", mergeBase, to], cwd);
  let current = null, oldPath = null, inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { current = null; oldPath = null; inHeader = true; continue; }
    if (inHeader) {
      if (line.startsWith("--- ")) oldPath = line === "--- /dev/null" ? null : line.slice(6);
      else if (line.startsWith("+++ ")) current = files.get(line === "+++ /dev/null" ? oldPath : line.slice(6)) ?? null;
      else if (line.startsWith("@@")) inHeader = false;
      continue;
    }
    if (!current || line.startsWith("@@")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  return [...files.values()];
}

export function pathChanges({ paths, cwd = process.cwd() }) {
  const tracked = git(["ls-files", "-z", "--", ...paths], cwd).split("\0").filter(Boolean);
  if (!tracked.length) throw new Error(`no tracked file under ${paths.join(", ")}`);
  return tracked.filter((p) => !isExcluded(p)).map((p) => {
    const text = readFileSync(path.join(cwd, p), "utf8");
    return { path: p, status: "M", added: text.includes("\0") ? [] : text.replace(/\n$/, "").split("\n"), removed: [] };
  });
}

export function loadRepoRisk(root) {
  const file = path.join(root, RISK_FILE);
  if (!existsSync(file)) return { signals: [], quiet: new Map() };
  const bad = (why) => { throw new RiskFileError(`${RISK_FILE}: ${why}`); };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    bad(`does not parse (${e.message})`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) bad("must be a JSON object");
  for (const key of Object.keys(data)) if (!["paths", "content", "quiet"].includes(key)) bad(`unknown key "${key}"`);
  const list = (key) => (Array.isArray(data[key] ?? []) ? data[key] ?? [] : bad(`"${key}" must be an array`));
  const text = (value, where) => (typeof value === "string" && value.trim() ? value : bad(`${where} must be a non-empty string`));
  const signals = [];
  list("paths").forEach((e, i) => {
    const glob = text(e?.glob, `paths[${i}].glob`);
    const label = text(e.label, `paths[${i}].label`);
    signals.push({ id: `repo:${label}`, label, matchers: [{ on: "path", glob }] });
  });
  list("content").forEach((e, i) => {
    const source = text(e?.pattern, `content[${i}].pattern`);
    const label = text(e.label, `content[${i}].label`);
    let pattern;
    try {
      pattern = new RegExp(source);
    } catch (err) {
      bad(`content[${i}].pattern is not a valid regular expression (${err.message})`);
    }
    signals.push({ id: `repo:${label}`, label, matchers: [{ on: "added", pattern }] });
  });
  const builtIn = BUILTIN_SIGNALS.map((s) => s.id);
  const quiet = new Map();
  list("quiet").forEach((e, i) => {
    const id = text(e?.signal, `quiet[${i}].signal`);
    if (!builtIn.includes(id)) bad(`quiet[${i}].signal "${id}" is not a built-in signal (${builtIn.join(", ")})`);
    quiet.set(id, text(e.reason, `quiet[${i}].reason`));
  });
  return { signals, quiet };
}

const countMatches = (lines, pattern) => lines.filter((l) => pattern.test(l)).length;

function hits(m, file) {
  if (m.glob && !path.matchesGlob(file.path, m.glob)) return false;
  if (m.notGlob && path.matchesGlob(file.path, m.notGlob)) return false;
  if (m.on === "path") return !m.deleted || file.status === "D";
  if (m.on === "added") return countMatches(file.added, m.pattern) > 0;
  if (m.on === "removed") return countMatches(file.removed, m.pattern) > 0;
  if (m.on === "gained") return countMatches(file.added, m.pattern) > countMatches(file.removed, m.pattern);
  if (m.on === "lost") return countMatches(file.removed, m.pattern) > countMatches(file.added, m.pattern);
  throw new Error(`unknown matcher kind ${JSON.stringify(m.on)}`);
}

export function matchSignals(files, { signals = BUILTIN_SIGNALS, quiet = new Map() } = {}) {
  const matched = [], quieted = [];
  for (const signal of signals) {
    const paths = files.filter((f) => signal.matchers.some((m) => hits(m, f))).map((f) => f.path);
    if (!paths.length) continue;
    const hit = { id: signal.id, label: signal.label, paths: paths.slice(0, MAX_SIGNAL_PATHS) };
    if (quiet.has(signal.id)) quieted.push({ ...hit, reason: quiet.get(signal.id) });
    else matched.push(hit);
  }
  return { matched, quieted };
}

export function scanRisk({ scope, base, branch, paths, cwd = process.cwd() }) {
  if (typeof path.matchesGlob !== "function") throw new Error("this Node has no path.matchesGlob, which the risk scan needs");
  const repo = loadRepoRisk(git(["rev-parse", "--show-toplevel"], cwd).trim());
  const files = scope === "branch" ? rangeChanges({ base, branch, cwd }) : pathChanges({ paths, cwd });
  return matchSignals(files, { signals: [...BUILTIN_SIGNALS, ...repo.signals], quiet: repo.quiet });
}

export function measureRange({ base, branch, cwd = process.cwd() }) {
  const from = resolveRef(base, cwd);
  const to = resolveRef(branch, cwd);
  const mergeBase = git(["merge-base", from, to], cwd).trim();
  // -z keeps a path with odd characters verbatim, and -M makes a rename one file whatever diff.renames says.
  const fields = git(["diff", "--numstat", "-z", "-M", mergeBase, to], cwd).split("\0");
  let changedLines = 0, changedFiles = 0, excludedFiles = 0;
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const [add, del, ...rest] = fields[i].split("\t");
    let path = rest.join("\t");
    // A rename leaves the path empty and puts source and destination in the next two fields.
    if (path === "") {
      path = fields[i + 2];
      i += 2;
    }
    if (isExcluded(path)) {
      excludedFiles++;
      continue;
    }
    changedFiles++;
    if (add !== "-") changedLines += Number(add) + Number(del); // "-" marks a binary file
  }
  return { changedLines, changedFiles, excludedFiles };
}

export function pickDepth({ profile, changedLines, changedFiles }) {
  if (profile === "lean") return { depth: "single", reason: "profile lean" };
  if (profile === "thorough") return { depth: "panel", reason: "profile thorough" };
  if (profile !== "standard") throw new Error(`unknown profile ${JSON.stringify(profile)}`);
  if (changedLines > PANEL_LINE_THRESHOLD)
    return { depth: "panel", reason: `${changedLines} changed lines > ${PANEL_LINE_THRESHOLD}` };
  if (changedFiles > PANEL_FILE_THRESHOLD)
    return { depth: "panel", reason: `${changedFiles} changed files > ${PANEL_FILE_THRESHOLD}` };
  return { depth: "single", reason: `${count(changedLines, "changed line")}, ${count(changedFiles, "file")}` };
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const USAGE = "run review-depth.mjs --base <ref> --branch <ref> --profile <lean|standard|thorough> [--json]";

function main(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, { "--base": "value", "--branch": "value", "--profile": "value", "--json": "none" },
      { requireValues: "nonEmpty" }));
  } catch (e) {
    return fail(`${e.message} — ${USAGE}`);
  }
  const profile = flags["--profile"];
  if (!PROFILES.includes(profile))
    return fail(`--profile must be one of ${PROFILES.join(", ")}, got ${JSON.stringify(profile ?? null)} — pass the knobs: line's profile`);
  let counts = { changedLines: null, changedFiles: null, excludedFiles: null };
  if (profile === "standard") {
    const { "--base": base, "--branch": branch } = flags;
    if (!base || !branch) return fail(`profile standard measures a diff, so it needs --base and --branch — ${USAGE}`);
    try {
      counts = measureRange({ base, branch, cwd: process.cwd() });
    } catch (e) {
      return fail(`measuring ${base}..${branch} failed: ${e.message} — fetch the missing ref, or take the profile's branch-review row`);
    }
  }
  const { depth, reason } = pickDepth({ profile, ...counts });
  if (flags["--json"]) console.log(JSON.stringify({ depth, reason, profile, ...counts }));
  else console.log(reason === `profile ${profile}` ? `${depth} (${reason})` : `${depth} (${reason}; profile ${profile})`);
}

function fail(message) {
  console.error(`review-depth: ${message}`);
  process.exitCode = 1;
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
