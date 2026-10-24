#!/usr/bin/env node
// Picks the review engine for `reviewDepth: auto` from the measured size of a ref range.
// playbooks/reviewing-code.md § 3 owns when it runs; this file owns the thresholds and what the
// measurement leaves out.
import { spawnSync } from "node:child_process";
import { parseFlags } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";

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
