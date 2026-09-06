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
// purity check charges the editor agent with every ignored path written during its attempt's WINDOW
// — the stretch between the marker the sweep stamps just before the agent runs and the purity check
// straight after it. A verifyCommand that builds, installs or measures coverage writes gitignored
// output that `git clean -fd` cannot remove, but it only ever runs between windows, so none of it is
// ever mistaken for the agent's collateral; that is also why nothing has to be re-snapshotted after
// a verify or a revert. The check goes one level below what git reports: git names a wholly ignored
// directory once (`dist/`), so judging by entry paths alone would hide every file the agent writes
// inside a directory the verify had already created. A charge the attempt CREATED is deleted by
// path; one it merely overwrote is left where it is, because the sweep cannot put back contents it
// never held — and the skip reason names it rather than implying the revert undid it. Stale worktree
// registrations from a killed run are pruned before the new worktree is added.
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
const { existsSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, lstatSync, writeFileSync } = require("node:fs");
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

// Every entry `git status --porcelain --ignored=matching -z` reports, split into its two-letter
// status code and its path. `!!` marks an ignored entry; a wholly ignored directory is reported once
// as the directory (with a trailing slash), anything else per file. That collapsing is what keeps
// this call cheap next to a `node_modules/`, and it is why the purity check cannot judge ignored
// state by these entry paths alone — one `dist/` line stands for however many files are under it.
// `-z` is what makes the paths usable: in its default form git C-quotes any path outside printable
// ASCII (`"caf\303\251/"`), and those octal escapes are not JSON, so an ignored directory with a
// non-ASCII name kept its quotes, stopped ending in a slash, and had its contents inspected by
// nobody. The NUL-separated form quotes nothing.
function statusEntries(worktree) {
  const fields = git(["status", "--porcelain", "--ignored=matching", "-z"], worktree).split("\0");
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const code = field.slice(0, 2);
    // A rename or copy arrives as two NUL-terminated fields, the destination first and the source
    // second. Only the destination exists now, so the source field is stepped over, not read as an
    // entry of its own.
    if (code.includes("R") || code.includes("C")) i++;
    entries.push({ ignored: code === "!!", path: field.slice(3) });
  }
  return entries;
}

// lstat, never stat: a path is judged as itself, so a symlink the agent drops into an ignored
// directory is charged for its own creation rather than for whatever it points at. A path that
// cannot be stat'd reports 0, which no window can contain.
function mtimeOf(abs) {
  try {
    return lstatSync(abs).mtimeMs;
  } catch {
    return 0;
  }
}

// Opens an attempt's window: the marker is written and its mtime read straight back, so the boundary
// is expressed in the worktree filesystem's own clock and granularity rather than this process's —
// nothing about `>= since` depends on the two agreeing. The marker sits beside the worktree, never
// inside it, so `git status` never sees it.
function openWindow(marker) {
  writeFileSync(marker, "");
  return mtimeOf(marker);
}

// Walks one directory git collapsed into a single ignored entry, charging every file written inside
// the attempt's window and recording every path it passes for the next attempt's `known` set. A
// symlink is recorded as an entry but never descended into, so a link into the wider filesystem
// cannot make this walk unbounded.
function scanIgnoredDir(worktree, rel, attempt, changed, seen) {
  let entries;
  try {
    entries = readdirSync(join(worktree, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = `${rel}${e.name}`;
    if (e.isDirectory()) {
      seen.add(`${path}/`);
      scanIgnoredDir(worktree, `${path}/`, attempt, changed, seen);
      continue;
    }
    seen.add(path);
    if (mtimeOf(join(worktree, path)) >= attempt.since) {
      changed.push({ path, ignored: true, created: !attempt.known.has(path) });
    }
  }
}

// Paths that differ from the sweep base and are attributable to the attempt: every tracked or
// non-ignored change (the sweep base leaves the tracked tree clean, so any of those is the
// attempt's), plus every ignored path written inside the attempt's window — collateral the agent
// created OR overwrote under an ignored path (audit 2026-09-05 L4). The window is what separates the
// agent's writes from the sweep's own: a verifyCommand's gitignored build, install or coverage
// output is written between windows and so is never charged, which is why this is one pass per
// attempt rather than a snapshot rebuilt after every verify and every revert. A collapsed directory
// entry the attempt itself created is one charge and one delete; an already-known one is descended
// into, so a verify-created `dist/` cannot cloak what the agent puts inside it. Each ignored charge
// carries `created`, decided by the paths the previous pass saw, because a path the attempt created
// can be deleted on revert and one it overwrote cannot be put back. The pass returns its full path
// set, which becomes the next attempt's `known`.
function changedPaths(worktree, attempt) {
  const changed = [];
  const seen = new Set();
  for (const e of statusEntries(worktree)) {
    if (!e.ignored) {
      changed.push({ path: e.path, ignored: false });
      continue;
    }
    seen.add(e.path);
    const abs = join(worktree, e.path);
    if (!e.path.endsWith("/")) {
      if (mtimeOf(abs) >= attempt.since) {
        changed.push({ path: e.path, ignored: true, created: !attempt.known.has(e.path) });
      }
      continue;
    }
    if (!attempt.known.has(e.path) && mtimeOf(abs) >= attempt.since) {
      changed.push({ path: e.path, ignored: true, created: true });
      continue;
    }
    scanIgnoredDir(worktree, e.path, attempt, changed, seen);
  }
  return { changed, seen };
}

// An ignored path the attempt overwrote instead of creating cannot be reverted: the sweep knows only
// that it changed, never what it held, and deleting it would destroy the dependency, cache or
// artifact the verifyCommand needs rather than restore it. It stays where the agent left it and is
// named in the skip reason, so "reverted" is never read as more than it is.
function overwrittenNote(changed) {
  const overwritten = changed.filter((c) => c.ignored && !c.created).map((c) => c.path);
  return overwritten.length
    ? `; left in place because the sweep cannot restore what they held: ${overwritten.join(", ")}`
    : "";
}

// `git clean -fd` leaves ignored paths alone, and `-x` is not the answer: it would also wipe the
// node_modules, build caches and coverage data the verifyCommand needs. So the ignored paths the
// attempt CREATED are deleted by path — exactly those, nothing else — or they would survive the
// revert and pollute the tree every later verify runs in. Paths the attempt only overwrote are not
// passed here (see overwrittenNote): deleting them would be destruction, not a revert.
function revertWorktree(worktree, createdIgnored = []) {
  git(["checkout", "--", "."], worktree);
  git(["clean", "-fd"], worktree);
  for (const p of createdIgnored) {
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
  const { worktree, repoRoot, instruction, verifyCommand, model, marker } = opts;
  // Everything written from here to the purity check below is this attempt's, and nothing outside it
  // is — which is what lets the verifyCommand's own gitignored output stay uncharged without any
  // re-snapshotting after a verify or a revert (branch review round 1, finding B).
  const attempt = { since: openWindow(marker), known: opts.known };
  log(`editing ${relPath}...`);
  const edit = await runEditorAgent(relPath, instruction, worktree, model);
  if (!edit.ok) {
    revertWorktree(worktree);
    return { skip: `editor agent failed: ${edit.error}`, hard: true };
  }
  const { changed, seen } = changedPaths(worktree, attempt);
  opts.known = seen;
  if (changed.length === 0) {
    return { skip: `agent made no change: ${edit.value.note || "no reason given"}` };
  }
  if (changed.length > 1 || changed[0].path !== relPath) {
    const created = changed.filter((c) => c.ignored && c.created).map((c) => c.path);
    revertWorktree(worktree, created);
    // A deleted path must not stay in `known`, or the next attempt would read a recreation of it as
    // something it merely overwrote and leave it on disk.
    for (const p of created) opts.known.delete(p);
    const names = changed.map((c) => c.path).join(", ");
    return { skip: `agent modified files other than the target (${names}); reverted${overwrittenNote(changed)}` };
  }
  if (!existsSync(join(worktree, relPath))) {
    revertWorktree(worktree);
    return { skip: "agent deleted the file; deletions are not applied; reverted" };
  }
  const verify = await runVerify(verifyCommand, worktree);
  if (!verify.ok) {
    revertWorktree(worktree);
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
  // Beside the worktree, not in it: the window marker must be on the same filesystem as the paths it
  // is compared against, and invisible to the `git status` that runs inside the worktree.
  const marker = `${worktree}.window`;
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

    // One pass over the ignored paths, taken after the baseline verify has installed dependencies or
    // written build output: a window nothing can fall inside charges nothing, so this runs purely for
    // the path set it returns — what the first attempt may overwrite but did not create.
    const opts = {
      worktree,
      repoRoot,
      marker,
      instruction: args.instruction,
      verifyCommand: args.verifyCommand,
      model,
      known: changedPaths(worktree, { since: Infinity, known: new Set() }).seen,
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
    rmSync(marker, { force: true });
  }
}

if (require.main === module) {
  main().catch((e) => fatal(String(e?.stack ?? e)));
}
