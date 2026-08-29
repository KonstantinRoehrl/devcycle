#!/usr/bin/env node
// Validates a devcycle state file against on-disk reality before /devcycle:continue trusts it (#79):
// every named artifact path (spec/plan/checklist) exists, and stage: is a real enum value.
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { field } from "./md-field.mjs";

// The stage enum's single source of truth is the `- stage: <a|b|c>` line in
// commands/cycle.md, read the same way scripts/validate.mjs reads it, so this guard never
// keeps a second copy that can silently drift when a stage is added. Resolved relative to
// this script's own location (not the cwd) so it holds however resume-check is invoked. If
// the enum can't be read — a packaging fault that scripts/validate.mjs owns, not this
// guard's concern — the set is empty and the stage-membership check below is skipped
// rather than blocking a legitimate resume on a stage it simply could not confirm.
const VALID_STAGES = (() => {
  try {
    const cyclePath = new URL("../commands/cycle.md", import.meta.url);
    const m = readFileSync(cyclePath, "utf8").match(/stage:\s*<([a-z|-]+)>/);
    return new Set(m ? m[1].split("|") : []);
  } catch {
    return new Set();
  }
})();
const NONE = new Set(["none", "<tbd>", ""]);

const args = process.argv.slice(2);
const KNOWN_FLAGS = { "--state": "value" };
let statePath = ".devcycle/state.md";
try {
  const { flags } = parseFlags(args, KNOWN_FLAGS);
  statePath = requireValue(flags, "--state") ?? statePath;
} catch (err) {
  // A flag whose value is missing, that was never read at all, or whose name was dropped so only
  // a bare path arrived, is a usage error -- never a silently absent flag resolving to the default
  // state file while the caller had named a different one.
  console.error(`resume-check: ${err.message}`);
  console.error("resume-check: usage: resume-check.mjs [--state <path>]");
  process.exit(1);
}

let text;
try { text = readFileSync(statePath, "utf8"); }
catch { console.error(`resume-check: cannot read state file: ${statePath}`); process.exit(1); }

// references/resume.md § The ownership check: root: pins the file to one checkout, and a
// differing root: means the file was copied or leaked from another project — never resume it.
// This runs FIRST and exits on mismatch: every artifact path below is resolved against root:,
// so once root: is wrong those verdicts are noise, not findings. The script reports; the
// adopt-or-leave decision is the user's, per that same section.
const recordedRoot = field(text, "root");
if (recordedRoot && !NONE.has(recordedRoot)) {
  // Derived from the state file's OWN directory, not the cwd: the question is whether this file
  // belongs to the checkout it sits in, which is what makes it correct for nested checkouts and
  // for git worktrees, whose toplevel is the worktree rather than the main repo.
  const git = spawnSync("git", ["-C", dirname(statePath), "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  // Not a repo, or no git at all: a precondition the guard could not confirm never blocks a
  // legitimate resume — the same posture VALID_STAGES takes toward an unreadable enum.
  if (git.status === 0) {
    const real = (p) => { try { return realpathSync(p); } catch { return p; } };
    const actualRoot = real(git.stdout.trim());
    if (real(recordedRoot) !== actualRoot) {
      console.error("resume-check: this state file belongs to another checkout — do not resume it:");
      console.error(`  - its root:  ${real(recordedRoot)}`);
      console.error(`  - you are in: ${actualRoot}`);
      console.error(`  - its request: ${field(text, "request") ?? "(none recorded)"}`);
      console.error("  Adopt it (rewrite root:, keep everything else) or leave it alone — the user decides.");
      process.exit(1);
    }
  }
}

const errors = [];
const stage = field(text, "stage");
if (!stage || (VALID_STAGES.size > 0 && !VALID_STAGES.has(stage)))
  errors.push(`stage: "${stage}" is not a valid devcycle stage`);

const root = field(text, "root");
const baseForRel = root && !NONE.has(root) ? root : dirname(statePath);
const resolve = (p) => (isAbsolute(p) ? p : join(baseForRel, p));

for (const name of ["spec", "plan", "checklist"]) {
  const raw = field(text, name);
  if (raw === null) continue;
  // A field may carry a path plus a trailing "— note"; take the first whitespace-delimited token.
  const value = raw.split(/\s+/)[0];
  if (NONE.has(value) || value.startsWith("none")) continue;
  if (!existsSync(resolve(value)))
    errors.push(`${name}: recorded artifact does not exist on disk: ${value}`);
}

if (errors.length) {
  console.error("resume-check: state file is stale — resolve before continuing:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`resume-check: ok — stage ${stage}, all recorded artifacts present`);
