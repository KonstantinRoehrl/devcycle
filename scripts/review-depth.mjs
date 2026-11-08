#!/usr/bin/env node
// Decides the branch-review engine from the reviewDepth knob and writes the decision record the panel's launcher guard checks; under auto it scans the change for risk signals, never its size.
// playbooks/reviewing-code.md § 3 owns when it runs; this file owns the depth-line forms, the decision record, the risk scan and .claude/devcycle-risk.json's format.
// scripts/risk-signals.mjs holds the built-in signal data.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { BUILTIN_SIGNALS } from "./risk-signals.mjs";

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

const run = (args, cwd, options = {}) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", ...options });

function git(args, cwd, options = {}) {
  const r = run(args, cwd, options);
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? ((r.stderr ?? "").trim() || `exit ${r.status}`);
    throw new Error(`git ${args.join(" ")} failed (${why})`);
  }
  return r.stdout;
}

const isValidRefName = (name, cwd) => !SHELL_UNSAFE.test(name) && run(["check-ref-format", "--allow-onelevel", name], cwd).status === 0;

// Spelled the way this clone resolves it: the bare name, else origin/<name>.
function resolveRef(name, cwd) {
  if (!isValidRefName(name, cwd)) throw new Error(`"${name}" is not a valid ref name`);
  for (const spelling of [name, `origin/${name}`])
    if (run(["rev-parse", "--verify", "--quiet", `${spelling}^{commit}`], cwd).status === 0) return spelling;
  throw new Error(`neither "${name}" nor "origin/${name}" resolves in this clone — fetch it, or name a ref that exists`);
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

const KNOBS = ["auto", "single", "panel"];
const SCOPES = ["branch", "files", "repo"];
const CALLERS = ["cycle", "standalone"];
const RUN_ID = /^[0-9a-f]{16}$/;
export const DECISION_FILES = Object.freeze({ cycle: ".devcycle/review/decision.json", standalone: ".devcycle/review/standalone-decision.json" });
// The profile's ceiling on how many diff chunks a panel reviews; past it the panel names the deferred files.
export const MAX_CHUNKS = Object.freeze({ lean: 2, standard: 4, thorough: 8 });
// Per panel lens job, from one recorded 5-lens round (2026-11-07, costByLens): 17 lens jobs cost $8.01
// before verification and $12.15 with verification and reconciliation. An estimate's range, never a quote.
export const PANEL_USD_PER_LENS_JOB = Object.freeze({ low: 0.47, high: 0.71 });
const { DIFF_CHAR_CAP } = createRequire(import.meta.url)("../workflows/review-panel.js");

const labelsOf = (hits) => hits.map((h) => h.label).join(", ");
const quietedNote = (quieted) => (quieted.length ? `quieted: ${quieted.map((h) => `${h.label} — ${h.reason}`).join("; ")}` : null);

export function decide({ knob, scope, signals = { matched: [], quieted: [] }, scanError = null }) {
  if (knob === "panel") return { verdict: "panel", depthLine: "Depth: panel (set)", note: null };
  if (knob === "single") {
    const note = scanError ? null
      : [signals.matched.length ? `risk signals (reviewDepth=single, not escalated): ${labelsOf(signals.matched)}` : null,
        quietedNote(signals.quieted)].filter(Boolean).join("; ") || null;
    return { verdict: "single", depthLine: "Depth: single (set)", note };
  }
  if (scope === "repo")
    return { verdict: "single", depthLine: "Depth: auto → single (whole-repo scope; reviewDepth=panel available)", note: "reviewDepth=panel is available for a whole-repo review" };
  if (scanError) return { verdict: "single", depthLine: `Depth: auto → single (scan failed: ${scanError})`, note: null };
  if (!signals.matched.length) return { verdict: "single", depthLine: "Depth: auto → single (no risk signal)", note: quietedNote(signals.quieted) };
  return { verdict: "ask", depthLine: null, note: quietedNote(signals.quieted) };
}

export function estimate({ chunks, lenses, profile }) {
  const reviewedChunks = Math.min(chunks, MAX_CHUNKS[profile]);
  const usd = (rate) => Math.round(reviewedChunks * lenses * rate * 100) / 100;
  return { chunks, reviewedChunks, unreviewedChunks: chunks - reviewedChunks, lenses,
    lowUsd: usd(PANEL_USD_PER_LENS_JOB.low), highUsd: usd(PANEL_USD_PER_LENS_JOB.high) };
}

export const consentLine = (answer, signals) => answer === "panel"
  ? `Depth: auto → panel (approved; signals: ${labelsOf(signals)})`
  : `Depth: auto → single (declined; signals: ${labelsOf(signals)})`;

// The panel splits the same base..branch diff it is given into DIFF_CHAR_CAP-sized chunks. The buffer
// is uncapped because a diff past spawnSync's default 1 MB is the case with the most chunks to count.
function countChunks({ base, branch, cwd }) {
  const diff = git(["diff", "--end-of-options", `${resolveRef(base, cwd)}..${resolveRef(branch, cwd)}`], cwd, { maxBuffer: Infinity });
  return Math.max(1, Math.ceil(diff.length / DIFF_CHAR_CAP));
}

const toplevel = (cwd) => git(["rev-parse", "--show-toplevel"], cwd).trim();
function writeRecord(cwd, caller, record) {
  const file = path.join(toplevel(cwd), DECISION_FILES[caller]);
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(record, null, 2) + "\n");
}

const USAGE = "run review-depth.mjs select|consent — see playbooks/reviewing-code.md § 3";
class UsageError extends Error {}
const usage = (message) => { throw new UsageError(message); };
const oneOf = (flags, name, allowed, hint = "") => allowed.includes(flags[name])
  ? flags[name] : usage(`${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(flags[name] ?? null)}${hint}`);

function select(flags, cwd) {
  const knob = oneOf(flags, "--reviewDepth", KNOBS, flags["--reviewDepth"] === "profile" ? " — resolve profile first: pass the knobs: line's reviewDepth" : "");
  const scope = oneOf(flags, "--scope", SCOPES);
  const profile = oneOf(flags, "--profile", Object.keys(MAX_CHUNKS), " — pass the knobs: line's profile");
  const caller = oneOf(flags, "--caller", CALLERS);
  const runId = flags["--run"] ?? null;
  if (caller === "cycle" && !RUN_ID.test(runId ?? "")) usage("--caller cycle needs --run <the state file's run: id>");
  const { "--base": base, "--branch": branch } = flags;
  const paths = flags["--paths"] ?? [];
  if (scope === "branch" && (!base || !branch)) usage("branch scope needs --base and --branch");
  if (scope === "files" && !paths.length) usage("files scope needs at least one --paths");
  const lenses = Number(flags["--lenses"]);
  if (knob === "auto" && scope !== "repo" && !(Number.isInteger(lenses) && lenses > 0)) usage("auto needs --lenses <n> for the cost estimate");
  if (scope === "branch")
    for (const name of [base, branch]) if (!isValidRefName(name, cwd)) usage(`"${name}" is not a valid ref name`);
  let signals = { matched: [], quieted: [] }, scanError = null;
  if (knob !== "panel" && scope !== "repo") {
    try {
      signals = scanRisk({ scope, base, branch, paths, cwd });
    } catch (e) {
      scanError = e.message;
    }
  }
  let decision = decide({ knob, scope, signals, scanError });
  let est = null;
  if (decision.verdict === "ask") {
    try {
      est = estimate({ chunks: scope === "branch" ? countChunks({ base, branch, cwd }) : 1, lenses, profile });
    } catch (e) {
      decision = decide({ knob, scope, signals, scanError: e.message });
    }
  }
  writeRecord(cwd, caller, {
    version: 1, caller, run: caller === "cycle" ? runId : null, knob, scope,
    verdict: decision.verdict, engine: decision.verdict, consent: "none",
    signals: [...signals.matched.map((h) => ({ ...h, quieted: false, reason: null })), ...signals.quieted.map((h) => ({ ...h, quieted: true }))],
    depthLine: decision.depthLine, at: new Date().toISOString(),
  });
  return { ...decision, signals: signals.matched, quieted: signals.quieted, estimate: est,
    maxChunks: MAX_CHUNKS[profile], recordPath: DECISION_FILES[caller] };
}

function consent(flags, cwd) {
  const caller = oneOf(flags, "--caller", CALLERS);
  const answer = ["panel", "single"].includes(flags["--answer"]) ? flags["--answer"] : usage("--answer must be panel or single");
  const file = path.join(toplevel(cwd), DECISION_FILES[caller]);
  if (!existsSync(file)) usage(`no ${caller} decision record at ${DECISION_FILES[caller]} — run select first`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.verdict !== "ask" || record.consent !== "none")
    usage(`the ${caller} decision record is already answered (verdict ${record.verdict}, consent ${record.consent}) — run select again for a new round 1`);
  const depthLine = consentLine(answer, record.signals.filter((s) => !s.quieted));
  writeRecord(cwd, caller, { ...record, engine: answer, consent: answer, depthLine, at: new Date().toISOString() });
  return { engine: answer, depthLine, recordPath: DECISION_FILES[caller] };
}

const FLAGS = {
  "--reviewDepth": "value", "--scope": "value", "--profile": "value", "--caller": "value", "--run": "value",
  "--base": "value", "--branch": "value", "--paths": "repeat", "--lenses": "value", "--answer": "value",
};

function main(argv) {
  try {
    const { flags, positionals } = parseFlags(argv, FLAGS, { allowPositionals: true, requireValues: "nonEmpty" });
    const [sub] = positionals;
    const commands = { select, consent };
    if (!commands[sub]) usage(`unknown subcommand ${JSON.stringify(sub ?? null)} — ${USAGE}`);
    console.log(JSON.stringify(commands[sub](flags, process.cwd())));
  } catch (e) {
    fail(e instanceof UsageError ? e.message : `${e.message} — ${USAGE}`);
  }
}

function fail(message) {
  console.error(`review-depth: ${message}`);
  process.exitCode = 1;
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
