#!/usr/bin/env node
// Moves one cycle between two worktrees of one repository, on the user's confirmation. It copies
// the state file, its ledger, the stage log, the per-task directories, and the gitignored
// spec/plan/checklist/diagnosis/scope files the state names, then deletes only the source state
// file: the source ledger and per-task files stay behind. Without --confirm it prints what it
// would copy and writes nothing. The run record keeps its id and needs no move, because its slug
// is per repository.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { gitToplevel } from "./git-identity.mjs";
import { isMain } from "./is-main.mjs";
import { PER_TASK_DIRS } from "./ledger-slot.mjs";
import { field } from "./md-field.mjs";
import { stageLogPath } from "./stage-log.mjs";

const ARTIFACT_FIELDS = ["spec", "plan", "checklist", "diagnosis", "scope"];
const NO_VALUE = new Set(["", "none", "<tbd>"]);

const git = (dir, args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true });

// The checkout's own root: for a linked worktree that is the worktree, not the main checkout
// gitToplevel canonicalizes to.
function checkoutRoot(dir) {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  return top.status === 0 && top.stdout.trim() ? realpathSync(top.stdout.trim()) : null;
}

const refusal = (refused, from = null, to = null) => ({ ok: false, dryRun: false, from, to, moved: [], copiedArtifacts: [], refused });

const filesUnder = (dir) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((rel) => statSync(join(dir, rel)).isFile()).sort() : [];

// The first token of a state field, or null when it names nothing movable.
function fieldPath(state, key) {
  const token = (field(state, key) ?? "").split(/\s+/)[0];
  return NO_VALUE.has(token) ? null : token;
}

function runScopedFiles({ state, devcycleDir, from }) {
  const ledgerValue = fieldPath(state, "ledger");
  const ledgerAbs = ledgerValue ? resolve(from, ledgerValue) : null;
  const underDevcycle = ledgerAbs !== null && !relative(devcycleDir, ledgerAbs).startsWith("..") && !isAbsolute(relative(devcycleDir, ledgerAbs));
  const ledger = underDevcycle ? relative(devcycleDir, ledgerAbs) : "ledger.md";
  const run = field(state, "run");
  const candidates = [
    "state.md",
    ledger,
    ...(run ? [relative(devcycleDir, stageLogPath(devcycleDir, run))] : []),
    ...PER_TASK_DIRS.flatMap((dir) => filesUnder(join(devcycleDir, dir)).map((rel) => join(dir, rel))),
  ];
  return candidates.filter((rel) => existsSync(join(devcycleDir, rel)));
}

// Ignored artifacts do not travel through git, so they are copied; a tracked one arrives with the branch.
function artifactsToCopy({ state, from, to }) {
  const wanted = ARTIFACT_FIELDS.map((key) => fieldPath(state, key))
    .filter((p) => p !== null && !isAbsolute(p) && !normalize(p).startsWith(".."));
  return [...new Set(wanted)].filter((p) =>
    existsSync(join(from, p)) && git(from, ["check-ignore", "-q", p]).status === 0 && !existsSync(join(to, p)));
}

// The directories from `dir` upward that do not exist yet, outermost first.
function missingDirs(dir) {
  const missing = [];
  for (let at = dir; !existsSync(at) && dirname(at) !== at; at = dirname(at)) missing.unshift(at);
  return missing;
}

// The outermost existing ancestor of `target` below `root` that is not a directory, or null when every
// ancestor is one or does not exist yet. lstat sees a dangling symlink, which a plain existence check misses;
// a symlink to a directory is a directory.
function nonDirectoryAncestor(root, target) {
  const chain = [];
  for (let at = dirname(target); at !== root && dirname(at) !== at; at = dirname(at)) chain.unshift(at);
  for (const at of chain) {
    let stat;
    try {
      stat = lstatSync(at);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      return at;
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isDirectory()) return at;
      continue;
    }
    try {
      if (!statSync(at).isDirectory()) return at;
    } catch {
      return at;
    }
  }
  return null;
}

// Writes each copy and reads it back, returning the first target whose bytes differ. `created` receives
// every file and directory this call brings into being, so a failure can remove exactly those.
function copyVerified(copies, created) {
  for (const { target, bytes } of copies) {
    created.dirs.push(...missingDirs(dirname(target)));
    mkdirSync(dirname(target), { recursive: true });
    created.files.push(target);
    writeFileSync(target, bytes);
  }
  const bad = copies.find(({ target, bytes }) => !readFileSync(target).equals(bytes));
  return bad ? bad.target : null;
}

function undoCopy({ files, dirs }) {
  for (const file of files) rmSync(file, { force: true });
  for (const dir of dirs.reverse()) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty or already gone: it holds something this call did not create
    }
  }
}

export function moveCycle({ statePath, to, confirm = false }) {
  const devcycleDir = dirname(resolve(statePath));
  const fromRoot = checkoutRoot(dirname(devcycleDir));
  if (fromRoot === null) return refusal(`${dirname(devcycleDir)} is not a git checkout`);
  const toRoot = existsSync(to) ? checkoutRoot(to) : null;
  if (toRoot === null) return refusal(`${to} is not a git checkout`, fromRoot);
  const sameRepository = realpathSync(gitToplevel(fromRoot)) === realpathSync(gitToplevel(toRoot));
  if (!sameRepository) return refusal(`${to} is not a worktree of this cycle's repository`, fromRoot, toRoot);
  if (toRoot === fromRoot) return refusal(`the cycle is already in ${to}`, fromRoot, toRoot);
  const targetDevcycle = join(toRoot, ".devcycle");
  const targetState = join(targetDevcycle, "state.md");
  if (existsSync(targetState)) return refusal(`${targetState} already holds a cycle's state file — move or close that cycle first`, fromRoot, toRoot);

  const state = readFileSync(statePath, "utf8");
  const moved = runScopedFiles({ state, devcycleDir, from: fromRoot });
  const copiedArtifacts = artifactsToCopy({ state, from: fromRoot, to: toRoot });
  const blocker = [...moved.map((rel) => join(targetDevcycle, rel)), ...copiedArtifacts.map((rel) => join(toRoot, rel))]
    .map((target) => nonDirectoryAncestor(toRoot, target)).find((at) => at !== null);
  if (blocker) return refusal(`${blocker} is not a directory — move or remove it first`, fromRoot, toRoot);
  const collisions = moved.filter((rel) => rel !== "state.md" && existsSync(join(toRoot, ".devcycle", rel))).map((rel) => join(toRoot, ".devcycle", rel));
  if (collisions.length)
    return refusal(`${to} already holds files this move would overwrite: ${collisions.join(", ")} — move or remove them first`, fromRoot, toRoot);
  const plan = { ok: true, dryRun: !confirm, from: fromRoot, to: toRoot, moved, copiedArtifacts };
  if (!confirm) return plan;

  const copyOf = (rel) => ({ target: join(toRoot, ".devcycle", rel), bytes: readFileSync(join(devcycleDir, rel)) });
  const stateCopy = { target: targetState, bytes: Buffer.from(state.replace(/^- root:.*$/m, () => `- root: ${toRoot}`)) };
  const others = [
    ...moved.filter((rel) => rel !== "state.md").map(copyOf),
    ...copiedArtifacts.map((rel) => ({ target: join(toRoot, rel), bytes: readFileSync(join(fromRoot, rel)) })),
  ];
  // The state file goes last: it is what makes the target a cycle, so a copy that fails earlier leaves
  // nothing a retry would refuse. A failure removes exactly what this call wrote.
  const created = { files: [], dirs: [] };
  try {
    const unverified = copyVerified(others, created) ?? copyVerified([stateCopy], created);
    if (unverified !== null) {
      undoCopy(created);
      return refusal(`copy did not verify: ${unverified}`, fromRoot, toRoot);
    }
  } catch (err) {
    undoCopy(created);
    return refusal(`copy failed: ${err.message}`, fromRoot, toRoot);
  }
  unlinkSync(statePath);
  return plan;
}

function main(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, { "--state": "value", "--to": "value", "--confirm": "none" }));
    const statePath = requireValue(flags, "--state");
    const to = requireValue(flags, "--to", "a worktree path");
    if (!statePath) throw new Error("--state requires a path argument");
    if (!to) throw new Error("--to requires a worktree path");
    if (!existsSync(statePath)) throw new Error(`no state file at ${statePath}`);
    const result = moveCycle({ statePath, to, confirm: flags["--confirm"] === true });
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.error(`move-cycle: ${err.message}`);
    process.exit(1);
  }
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
