#!/usr/bin/env node
// Validates a devcycle state file against on-disk reality before /devcycle:continue trusts it (#79):
// every named artifact path (spec/plan/checklist) exists, stage: is a real enum value, and the
// recorded branch still exists as a ref (#138).
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { field } from "./md-field.mjs";
import { stageEntry, entryLines, CLOSED_STAGE, CLOSED_LINE, FALLBACK } from "./stage-entry.mjs";
import { isMain } from "./is-main.mjs";
import { parseHandoff } from "./handoff-mark.mjs";
import { readStopRecord } from "./stop-files.mjs";
import { formatStopMessage, formatVerdict, isPendingRename, settleFormat } from "./cycle-format.mjs";

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

// The `- stopped:` row, with what the stop record adds. The record only reports: position is
// rederived from the stage log, the ledger and git (references/resume.md § The state file), so a
// missing or hand-edited record still prints and never fails the check.
function stoppedOf(statePath, text) {
  const row = field(text, "stopped");
  if (!row) return null;
  const [stamp, recordPath = null] = row.split(/\s+/);
  const record = readStopRecord(dirname(statePath));
  const run = field(text, "run");
  // A record left by another run is not this cycle's stop, whatever the row says.
  if (record?.run && run && record.run !== run) return null;
  return {
    stamp, recordPath, stage: record?.stage ?? field(text, "stage"), position: record?.position ?? null,
    left: record?.left ?? [], uncommitted: record?.uncommitted ?? [],
  };
}

const positionText = (position) => (position === null ? "position not recorded" : typeof position === "string" ? position : position.summary ?? JSON.stringify(position));

export function stoppedLines(stopped) {
  if (!stopped) return [];
  return [
    `stopped: ${stopped.stamp} in ${stopped.stage}: ${positionText(stopped.position)} (${stopped.recordPath ?? "no record path"})`,
    ...stopped.left.map(({ id, kind, reason }) => `stopped-left: ${id} (${kind}): ${reason}`),
    ...stopped.uncommitted.map((path) => `stopped-uncommitted: ${path}`),
  ];
}

// The ownership check, the stale checks and the stage's entry lines, as data: `kind` names the
// failing class (`unreadable`, `foreign`, `stale`), and a passing check's `lines` are what the CLI
// prints after its ok line. scripts/wave-setup.mjs runs it in-process; main() prints it.
export function checkState(statePath) {
  let text;
  try {
    text = readFileSync(statePath, "utf8");
  } catch {
    return { ok: false, kind: "unreadable", errors: [`cannot read state file: ${statePath}`] };
  }

  // references/resume.md § The ownership check: root: pins the file to one checkout, and a
  // differing root: means the file was copied or leaked from another project — never resume it.
  // This runs FIRST and returns on mismatch: every artifact path below is resolved against root:,
  // so once root: is wrong those verdicts are noise, not findings. The check reports; the
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
      if (real(recordedRoot) !== actualRoot)
        return { ok: false, kind: "foreign", recordedRoot: real(recordedRoot), actualRoot, request: field(text, "request") ?? "(none recorded)" };
    }
  }

  const errors = [];
  const stage = field(text, "stage");
  const format = formatVerdict(text);
  // A stage this plugin does not know is explained, not stale, when the file's format says why: an
  // older file's step renames it, and a newer plugin's cycle may have added it (the format stop below
  // tells the user to update).
  const stageExplained = format.verdict === "newer" || format.verdict === "unparseable"
    || (format.verdict === "older" && isPendingRename(stage, format.from));
  if (!stageExplained && (!stage || (VALID_STAGES.size > 0 && !VALID_STAGES.has(stage))))
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

  // references/resume.md § Settle the branch: the recorded branch is where any committed work
  // lives, so a recorded topic branch that no longer exists as a ref is a leftover from a
  // completed or abandoned cycle — continue.md step 4 would otherwise try to switch onto a
  // branch that is gone. This is stale-class, exactly like a missing artifact. The other case,
  // the branch still exists but the checkout drifted to another branch, is NOT stale: that is
  // the normal resume-switch continue.md step 4 owns, so this stays silent on it and never
  // compares against HEAD.
  const branchRaw = field(text, "branch");
  if (branchRaw !== null) {
    const branch = branchRaw.split(/\s+/)[0]; // strip the "(cut from <base> at <sha>)" annotation
    if (!NONE.has(branch)) {
      const at = dirname(statePath);
      // Confirm a repo first, then existence — same fail-open posture as the root check and
      // VALID_STAGES: a precondition the guard cannot confirm never blocks a resume.
      const inRepo = spawnSync("git", ["-C", at, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
      if (inRepo.status === 0) {
        const ref = spawnSync(
          "git",
          ["-C", at, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
          { encoding: "utf8" }
        );
        if (ref.status !== 0)
          errors.push(
            `branch: recorded branch "${branch}" no longer exists — this state file is a leftover from a completed or abandoned cycle`
          );
      }
    }
  }

  if (errors.length) return { ok: false, kind: "stale", errors };
  if (format.verdict === "newer" || format.verdict === "unparseable") return { ok: false, kind: "format", format, errors: [formatStopMessage(format)] };
  const handoff = parseHandoff(field(text, "handoff"));
  const stopped = stoppedOf(statePath, text);
  if (stage === CLOSED_STAGE) return { ok: true, stage, format, handoff, stopped, lines: [CLOSED_LINE] };
  try {
    return { ok: true, stage, format, handoff, stopped, lines: entryLines(stageEntry(stage)) };
  } catch (err) {
    return { ok: true, stage, format, handoff, stopped, lines: [`resume-check: no entry line — ${err.message}; fall back to ${FALLBACK}`] };
  }
}

function main(argv) {
  let statePath = ".devcycle/state.md";
  let answer = null;
  try {
    const { flags } = parseFlags(argv, { "--state": "value", "--format-answer": "value" });
    statePath = requireValue(flags, "--state") ?? statePath;
    answer = requireValue(flags, "--format-answer") ?? null;
    if (answer !== null && answer !== "yes" && answer !== "no") throw new Error(`--format-answer takes yes or no, got ${JSON.stringify(answer)}`);
  } catch (err) {
    // A flag whose value is missing, that was never read at all, or whose name was dropped so only
    // a bare path arrived, is a usage error -- never a silently absent flag resolving to the default
    // state file while the caller had named a different one.
    console.error(`resume-check: ${err.message}`);
    console.error("resume-check: usage: resume-check.mjs [--state <path>] [--format-answer yes|no]");
    process.exit(1);
  }

  let result = checkState(statePath);
  if (result.kind === "unreadable") {
    console.error(`resume-check: ${result.errors[0]}`);
    process.exit(1);
  }
  if (result.kind === "foreign") {
    console.error("resume-check: this state file belongs to another checkout — do not resume it:");
    console.error(`  - its root:  ${result.recordedRoot}`);
    console.error(`  - you are in: ${result.actualRoot}`);
    console.error(`  - its request: ${result.request}`);
    console.error("  Adopt it (rewrite root:, keep everything else) or leave it alone — the user decides.");
    process.exit(1);
  }
  if (result.kind === "stale") {
    console.error("resume-check: state file is stale — resolve before continuing:");
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  if (result.kind === "format") {
    console.error(`resume-check: ${result.errors[0]}`);
    process.exit(1);
  }
  const settled = settleFormat(statePath, { checked: result, answer });
  if (settled.status === "question") {
    console.log(`format-question: ${settled.question}`);
    return;
  }
  if (settled.status === "locked" || settled.status === "failed") {
    console.error(`resume-check: ${settled.detail}`);
    process.exit(1);
  }
  for (const line of settled.report) console.log(`format-report: ${line}`);
  if (settled.status === "migrated") result = checkState(statePath);
  console.log(`resume-check: ok — stage ${result.stage}, all recorded artifacts present`);
  for (const line of result.lines) console.log(line);
  for (const line of stoppedLines(result.stopped)) console.log(line);
  console.log(`handoff: ${result.handoff.state} ${result.handoff.stamp ?? "(no row)"}`);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
