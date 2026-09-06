#!/usr/bin/env node
// mechanical-sweep.js — piloted bulk mechanical edit over a file list (devcycle P7).
//
// Invoked by skills as:
//   node "${CLAUDE_PLUGIN_ROOT}/workflows/mechanical-sweep.js" '<json-args>'
// (${CLAUDE_PLUGIN_ROOT} substitutes in skill/command content; it is NOT an
// env var here — everything the script needs arrives via argv. See
// docs/platform-notes.md section (c).)
//
// Args (argv[2], JSON):
//   { files: string[], instruction: string, verifyCommand: string }
// Output (stdout, JSON):
//   { applied: string[], skipped: [{ file, reason }] }
//
// Flow: all edits happen in an isolated detached git worktree seeded with the
// working-tree contents of the target files. A baseline verifyCommand run
// guards against pre-existing breakage. The first 2-3 files are the pilot:
// each is edited by a claude subagent and gated by verifyCommand — if a pilot
// file fails verification (or its editor fails), the sweep HARD-STOPS and
// reports every file (pilot failures with their reasons, the rest as "not
// attempted"). After a green pilot, remaining files are processed one by one
// with the same per-file verify; failures skip that file (reverted) and the
// sweep continues. Verified changes are copied back into the real working
// tree. Every skip carries a reason — nothing is capped or dropped silently.
//
// The editor subagent may touch ONLY the target file (enforced by git status
// in the worktree; any collateral change reverts the attempt). Deletions are
// never applied. The real repository is only written on the applied path.
//
// Targets are force-added to the sweep base so a gitignored target is swept like any other, and the
// purity check counts ignored collateral that is NEW against a per-attempt snapshot of the
// worktree's ignored paths. The snapshot is retaken after every verifyCommand run and after every
// revert, because a verify that builds, installs or measures coverage writes gitignored output that
// `git clean -fd` cannot remove — without the snapshot the sweep blamed the editor agent for its own
// verify's artifacts and skipped every file. The snapshot goes one level below what git reports:
// git names a wholly ignored directory once (`dist/`), so a snapshot of entry paths alone would hide
// every file the agent later writes inside a directory the verify had already created. Snapshotting
// each such directory's contents makes that file a new entry of its own. A rejected attempt's
// ignored collateral is then deleted by path before the re-snapshot, so it neither stays on disk nor
// enters the next baseline. Stale worktree registrations from a killed run are pruned before the new
// worktree is added.
//
// Optional env: DEVCYCLE_SWEEP_MODEL sets --model for the claude editor
// subagents (unset -> the CLI's configured default model).
//
// Exit codes: 0 = sweep completed (report on stdout, individual skips
// possible); 1 = hard stop (baseline or pilot verification failed — report
// still on stdout) or fatal error (message on stderr).
//
// Smoke-tested (sandbox git repo, 4 js files, rename instruction,
// verifyCommand running node --check over the tree):
//   node "${CLAUDE_PLUGIN_ROOT}/workflows/mechanical-sweep.js" \
//     '{"files":["a.js","b.js","c.js","d.js"],"instruction":"Rename the variable oldName to newName.","verifyCommand":"for f in *.js; do node --check $f || exit 1; done"}'

"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } = require("node:fs");
const { join, dirname, resolve, relative, isAbsolute, sep } = require("node:path");
const os = require("node:os");
const { makeLogger, run, claudeStructured } = require("./lib/agent-cli.js");

const VERIFY_TIMEOUT_MS = 15 * 60 * 1000;
const PILOT_MAX = 3;
// Committing sweep checkpoints inside the worktree must not depend on the
// user's git identity being configured.
const GIT_IDENT = ["-c", "user.name=devcycle-sweep", "-c", "user.email=sweep@devcycle.invalid"];
// The sweep's editor agent runs single-attempt: a retry would re-run an agent
// that may already have partially edited the worktree.
const SWEEP_ERRORS = { agent: "editor agent", output: "editor", cap: 400 };

const { log, fatal } = makeLogger("mechanical-sweep");

function git(argv, cwd) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    changed: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["changed", "note"],
};

async function runEditorAgent(relPath, instruction, worktree, model) {
  const prompt = [
    `You are performing one step of a mechanical sweep in an isolated worktree`,
    `(your working directory). Apply the following instruction to exactly ONE`,
    `file: ${relPath}`,
    ``,
    `Instruction: ${instruction}`,
    ``,
    `Rules: edit only ${relPath} — never any other file. Make the minimal edit the`,
    `instruction describes; do not refactor, reformat, or "improve" anything else.`,
    `If the instruction does not apply to this file, change nothing and explain why`,
    `in "note". Report changed=true only if you actually edited the file.`,
  ].join("\n");
  return claudeStructured({
    prompt,
    tools: "Read,Grep,Glob,Edit,Write",
    schema: EDIT_SCHEMA,
    model,
    cwd: worktree,
    permissionMode: "acceptEdits",
    attempts: 1,
    errors: SWEEP_ERRORS,
  });
}

// Every entry `git status --porcelain --ignored=matching` reports, split into its two-letter status
// code and its path. `!!` marks an ignored entry; a wholly ignored directory is reported once as the
// directory, anything else per file. That collapsing is what keeps this call cheap next to a
// `node_modules/`, and it is why the purity check cannot judge ignored state by these entry paths
// alone — one `dist/` line stands for however many files are under it.
function statusEntries(worktree) {
  return git(["status", "--porcelain", "--ignored=matching"], worktree)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let p = line.slice(3);
      if (p.includes(" -> ")) p = p.split(" -> ").pop();
      if (p.startsWith('"') && p.endsWith('"')) {
        try { p = JSON.parse(p); } catch { /* keep quoted form */ }
      }
      return { ignored: line.slice(0, 2) === "!!", path: p };
    });
}

// Size and mtime are enough to notice a file being added or rewritten between two snapshots taken
// minutes apart, and unlike hashing they stay affordable over a node_modules.
function fingerprint(abs) {
  try {
    const st = statSync(abs);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "unreadable";
  }
}

// Every file under `rel` (a directory git reported as one collapsed entry), keyed by its
// worktree-relative path. A symlink is recorded as an entry but never descended into, so a link into
// the wider filesystem cannot make this walk unbounded.
function listTree(worktree, rel, out) {
  let entries;
  try {
    entries = readdirSync(join(worktree, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) listTree(worktree, `${rel}${e.name}/`, out);
    else out.set(`${rel}${e.name}`, fingerprint(join(worktree, rel, e.name)));
  }
  return out;
}

// The ignored state of the worktree right now — the baseline a later purity check subtracts. Keyed by
// the status entry, but a directory entry maps to a listing of its contents rather than to the entry
// itself: git collapses a wholly ignored directory into one line, so comparing entries alone would
// treat everything the agent writes inside an already-listed directory as already seen.
function ignoredSnapshot(worktree) {
  const snapshot = new Map();
  for (const e of statusEntries(worktree)) {
    if (!e.ignored) continue;
    snapshot.set(e.path, e.path.endsWith("/") ? listTree(worktree, e.path, new Map()) : fingerprint(join(worktree, e.path)));
  }
  return snapshot;
}

// Paths that differ from the sweep base and are attributable to the attempt: every tracked or
// non-ignored change (the sweep base leaves the tracked tree clean, so any of those is the attempt's),
// plus ignored paths that are new or rewritten since `ignoredBaseline` — collateral the agent created
// under an ignored path (audit 2026-09-05 L4). For a collapsed directory entry the comparison
// descends into the baseline's listing of it and reports the individual files that changed, so a
// verify-created `dist/` in the baseline cannot cloak what the agent puts inside it. Ignored paths
// unchanged since the snapshot are the sweep's own verify output and are not charged to the agent.
// Each entry carries whether it is ignored, because those are the ones a revert has to delete itself.
function changedPaths(worktree, ignoredBaseline) {
  const changed = [];
  for (const e of statusEntries(worktree)) {
    if (!e.ignored) {
      changed.push({ path: e.path, ignored: false });
      continue;
    }
    const base = ignoredBaseline.get(e.path);
    if (base === undefined) {
      changed.push({ path: e.path, ignored: true }); // a wholly new ignored path, directory or file
    } else if (base instanceof Map) {
      for (const [p, fp] of listTree(worktree, e.path, new Map())) {
        if (base.get(p) !== fp) changed.push({ path: p, ignored: true });
      }
    } else if (fingerprint(join(worktree, e.path)) !== base) {
      changed.push({ path: e.path, ignored: true });
    }
  }
  return changed;
}

// `git clean -fd` leaves ignored paths alone, and `-x` is not the answer: it would also wipe the
// node_modules, build caches and coverage data the verifyCommand needs. So the attempt's own ignored
// collateral is deleted by path — exactly the paths the purity check charged to it, nothing else —
// or it would survive the revert and be adopted by the re-snapshot that follows.
function revertWorktree(worktree, foreignIgnored = []) {
  git(["checkout", "--", "."], worktree);
  git(["clean", "-fd"], worktree);
  for (const p of foreignIgnored) {
    const abs = resolve(worktree, p);
    if (abs.startsWith(worktree + sep)) rmSync(abs, { recursive: true, force: true });
  }
}

async function runVerify(verifyCommand, worktree) {
  const res = await run("/bin/sh", ["-c", verifyCommand], { cwd: worktree, timeoutMs: VERIFY_TIMEOUT_MS });
  if (res.timedOut) return { ok: false, detail: "verify command timed out" };
  if (res.code === 0) return { ok: true };
  const tail = (res.stderr || res.stdout).trim().split("\n").slice(-5).join(" | ").slice(0, 400);
  return { ok: false, detail: `exit ${res.code}${tail ? `: ${tail}` : ""}` };
}

// Process one file inside the worktree. Returns
//   { applied: true } | { skip: string, hard?: true }
// where hard marks failures that must trip the pilot gate (verification
// failure or a broken editor), as opposed to benign per-file skips.
async function processFile(relPath, opts) {
  const { worktree, repoRoot, instruction, verifyCommand, model } = opts;
  // An ignored path the sweep cannot undo stops being this attempt's fault once its verdict is in:
  // re-snapshot after every revert and after every verify run, so the next file is judged against
  // what is actually on disk. Never before a purity check — that would baseline the agent's own
  // collateral and let it through.
  const rebaseline = () => { opts.ignoredBaseline = ignoredSnapshot(worktree); };
  const revert = (foreignIgnored) => { revertWorktree(worktree, foreignIgnored); rebaseline(); };
  log(`editing ${relPath}...`);
  const edit = await runEditorAgent(relPath, instruction, worktree, model);
  if (!edit.ok) {
    revert();
    return { skip: `editor agent failed: ${edit.error}`, hard: true };
  }
  const changes = changedPaths(worktree, opts.ignoredBaseline);
  if (changes.length === 0) {
    return { skip: `agent made no change: ${edit.value.note || "no reason given"}` };
  }
  if (changes.length > 1 || changes[0].path !== relPath) {
    revert(changes.filter((c) => c.ignored).map((c) => c.path));
    return { skip: `agent modified files other than the target (${changes.map((c) => c.path).join(", ")}); reverted` };
  }
  if (!existsSync(join(worktree, relPath))) {
    revert();
    return { skip: "agent deleted the file; deletions are not applied; reverted" };
  }
  const verify = await runVerify(verifyCommand, worktree);
  rebaseline();
  if (!verify.ok) {
    revert();
    return { skip: `verification failed: ${verify.detail}`, hard: true };
  }
  // Verified: copy back into the real tree and advance the worktree baseline.
  copyFileSync(join(worktree, relPath), join(repoRoot, relPath));
  git([...GIT_IDENT, "commit", "-am", `sweep: ${relPath}`], worktree);
  log(`applied ${relPath}`);
  return { applied: true };
}

async function main() {
  let args;
  try {
    args = JSON.parse(process.argv[2] ?? "");
  } catch {
    fatal("argv[2] must be a JSON object: { files, instruction, verifyCommand }");
  }
  if (!Array.isArray(args.files) || args.files.length === 0 || args.files.some((f) => typeof f !== "string" || !f)) {
    fatal("args.files must be a non-empty array of strings");
  }
  if (typeof args.instruction !== "string" || !args.instruction) fatal("args.instruction (string) is required");
  if (typeof args.verifyCommand !== "string" || !args.verifyCommand) fatal("args.verifyCommand (string) is required");
  const model = process.env.DEVCYCLE_SWEEP_MODEL || undefined;

  let repoRoot;
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  } catch {
    fatal("mechanical-sweep must run inside a git repository (worktree isolation requires it)");
  }

  const applied = [];
  const skipped = [];
  const skip = (file, reason) => {
    skipped.push({ file, reason });
    log(`skip ${file}: ${reason}`);
  };

  // Normalize the file list to repo-root-relative paths; log every drop.
  const seen = new Set();
  const targets = []; // { input, rel } — rel is repo-root-relative
  for (const input of args.files) {
    const abs = resolve(process.cwd(), input);
    const rel = relative(repoRoot, abs);
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === "..") {
      skip(input, "outside the repository");
      continue;
    }
    if (seen.has(rel)) {
      skip(input, `duplicate of ${rel} already in the list`);
      continue;
    }
    seen.add(rel);
    if (!existsSync(abs)) {
      skip(input, "file not found in the working tree");
      continue;
    }
    targets.push({ input, rel });
  }
  if (targets.length === 0) {
    process.stdout.write(JSON.stringify({ applied, skipped }, null, 2) + "\n");
    return;
  }

  // Isolated worktree at HEAD, seeded with the working-tree contents of the
  // targets and committed so per-file purity checks and reverts are clean.
  const worktree = mkdtempSync(join(os.tmpdir(), "devcycle-sweep-"));
  let worktreeAdded = false;
  const report = (code) => {
    process.stdout.write(JSON.stringify({ applied, skipped }, null, 2) + "\n");
    process.exitCode = code;
  };
  try {
    // A sweep killed mid-run leaves a registration whose directory is already gone; prune it so the
    // next `worktree add` neither fails on it nor points at a missing path.
    git(["worktree", "prune"], repoRoot);
    git(["worktree", "add", "--detach", "--force", worktree, "HEAD"], repoRoot);
    worktreeAdded = true;
    for (const t of targets) {
      mkdirSync(dirname(join(worktree, t.rel)), { recursive: true });
      copyFileSync(join(repoRoot, t.rel), join(worktree, t.rel));
    }
    // -f: a gitignored target must still be tracked by the sweep base, or its later edit is
    // invisible to the purity check and reported as "agent made no change" (audit 2026-09-05 L4).
    git(["add", "-A", "-f", "--", ...targets.map((t) => t.rel)], worktree);
    git([...GIT_IDENT, "commit", "--allow-empty", "-m", "sweep base"], worktree);

    // Baseline: a verifyCommand that fails before any edit would blame the
    // sweep for pre-existing breakage — hard-stop up front instead.
    log("running baseline verification...");
    const baseline = await runVerify(args.verifyCommand, worktree);
    if (!baseline.ok) {
      for (const t of targets) skip(t.input, `baseline verification failed before any edits (${baseline.detail})`);
      report(1);
      return;
    }

    // Taken after the baseline verify, which may already have installed dependencies or written build
    // output under ignored paths: none of that is the editor agent's doing.
    const opts = {
      worktree,
      repoRoot,
      instruction: args.instruction,
      verifyCommand: args.verifyCommand,
      model,
      ignoredBaseline: ignoredSnapshot(worktree),
    };
    const pilotCount = Math.min(PILOT_MAX, targets.length);
    log(`pilot: first ${pilotCount} of ${targets.length} file(s)`);

    let index = 0;
    let pilotFailure = null;
    for (; index < pilotCount; index++) {
      const t = targets[index];
      const outcome = await processFile(t.rel, opts);
      if (outcome.applied) applied.push(t.input);
      else {
        skip(t.input, outcome.skip);
        if (outcome.hard) {
          pilotFailure = `${t.input}: ${outcome.skip}`;
          index++;
          break;
        }
      }
    }
    if (pilotFailure) {
      for (; index < targets.length; index++) {
        skip(targets[index].input, `not attempted: pilot hard-stopped (${pilotFailure})`);
      }
      log("pilot failed — hard stop");
      report(1);
      return;
    }

    // Pilot green: sweep the remainder; per-file failures skip and continue.
    for (; index < targets.length; index++) {
      const t = targets[index];
      const outcome = await processFile(t.rel, opts);
      if (outcome.applied) applied.push(t.input);
      else skip(t.input, outcome.skip);
    }
    report(0);
  } finally {
    if (worktreeAdded) {
      try { git(["worktree", "remove", "--force", worktree], repoRoot); } catch { /* fall through */ }
    }
    rmSync(worktree, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((e) => fatal(String(e?.stack ?? e)));
}
