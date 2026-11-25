#!/usr/bin/env node
// Moves one cycle's run-scoped files between two worktrees of one repository, on the user's
// confirmation: the state file, its ledger, the stage log, the per-task directories, and the
// gitignored spec/plan/checklist/diagnosis/scope files the state names. Without --confirm it
// prints what it would move and writes nothing. The run record keeps its id and needs no move,
// because its slug is per repository.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

function copyVerified(copies) {
  for (const { target, bytes } of copies) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const bad = copies.find(({ target, bytes }) => !readFileSync(target).equals(bytes));
  return bad ? bad.target : null;
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
  const targetState = join(toRoot, ".devcycle", "state.md");
  if (existsSync(targetState)) return refusal(`${targetState} already holds a cycle's state file — move or close that cycle first`, fromRoot, toRoot);

  const state = readFileSync(statePath, "utf8");
  const moved = runScopedFiles({ state, devcycleDir, from: fromRoot });
  const copiedArtifacts = artifactsToCopy({ state, from: fromRoot, to: toRoot });
  const plan = { ok: true, dryRun: !confirm, from: fromRoot, to: toRoot, moved, copiedArtifacts };
  if (!confirm) return plan;

  const copies = [
    ...moved.map((rel) => ({
      target: join(toRoot, ".devcycle", rel),
      bytes: rel === "state.md" ? Buffer.from(state.replace(/^- root:.*$/m, () => `- root: ${toRoot}`)) : readFileSync(join(devcycleDir, rel)),
    })),
    ...copiedArtifacts.map((rel) => ({ target: join(toRoot, rel), bytes: readFileSync(join(fromRoot, rel)) })),
  ];
  const unverified = copyVerified(copies);
  if (unverified !== null) return refusal(`copy did not verify: ${unverified}`, fromRoot, toRoot);
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
