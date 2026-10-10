#!/usr/bin/env node
// Commits one accepted execution-stage task: the coordinator's green gate and the acceptance commit
// in one call (playbooks/executing-waves.md steps 6-7, references/commit-convention.md § The task
// commit). The gate is this script's own run of the task's test command, never a report's word.
// Each commit carries a `Devcycle-Task: <run>/<task>` trailer, so a re-run after a crash finds it
// and appends only the ledger and run-record lines still missing instead of committing twice.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireValue } from "./cli-flags.mjs";
import { taskFileMap } from "./task-files.mjs";
import { field } from "./md-field.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { eachRecord } from "./jsonl.mjs";
import { gitToplevel, recordPath, validateCulprit } from "./run-record.mjs";
import { isMain } from "./is-main.mjs";
import { INTEGRATION_BRANCHES, defaultBranches } from "./branch-names.mjs";
import { ROUND_CAP, exhaustReviewLoop, pendingReviewLoop, reviewLoopId } from "./task-verdict.mjs";
import {
  MISSING_FINDINGS, UsageError, appendLedgerLine, appendRunRecordOnce, checkIds, latestKeyed, ledgerKey, nextRetry,
  runTaskScript, taskEntries, taskFlags, workTreeRoot,
} from "./task-ledger.mjs";

const FOREIGN_CHANGE_CHECK = fileURLToPath(new URL("./foreign-change-check.mjs", import.meta.url));
const TRAILER_KEY = "Devcycle-Task";
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: \S/;
const GATE_FAIL_PREFIX = "rejected (green gate:";
const DEFERRED_OUTCOME = "deferred (concurrent sibling edits)";
const FLAGS = {
  "--run": "value", "--task": "value", "--plan": "value", "--test-cmd": "value", "--subject": "value",
  "--subset-cmd": "value", "--culprit": "value", "--trailers": "value", "--ledger": "value",
};
const REQUIRED = ["--run", "--task", "--plan", "--test-cmd", "--subject"];

// An optional flag given with no value is the same operator mistake as a missing required one.
function optionalFlag(flags, name, noun) {
  try {
    return requireValue(flags, name, noun);
  } catch (err) {
    throw new UsageError(err.message);
  }
}

function parseArgs(argv) {
  const flags = taskFlags(argv, FLAGS, REQUIRED);
  const args = {
    run: flags["--run"], task: flags["--task"], plan: flags["--plan"], testCmd: flags["--test-cmd"],
    subject: flags["--subject"],
    subsetCmd: optionalFlag(flags, "--subset-cmd", "a command"),
    culprit: optionalFlag(flags, "--culprit", "a culprit slug") ?? "gate-caught-regression",
    trailers: (optionalFlag(flags, "--trailers", "trailer lines") ?? "").split("\n").map((l) => l.trim()).filter(Boolean),
    ledger: optionalFlag(flags, "--ledger"),
  };
  checkIds(args);
  if (/[\r\n]/.test(args.subject)) throw new UsageError("--subject must be a single line");
  for (const t of args.trailers)
    if (!TRAILER_LINE.test(t) || t.toLowerCase().startsWith(`${TRAILER_KEY.toLowerCase()}:`))
      throw new UsageError(`--trailers line "${t}" is not a "Key: value" trailer other than ${TRAILER_KEY}`);
  const culpritErrors = validateCulprit(args.culprit);
  if (culpritErrors.length) throw new UsageError(culpritErrors.join("; "));
  return args;
}

// Plan paths are literal file names: as a pathspec, `src/[id].tsx` would also stage `src/i.tsx`.
const git = (cwd, args) =>
  spawnSync("git", ["--literal-pathspecs", "-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.error || r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}`}`);
  return r.stdout;
}

function readText(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read the ${what} at ${path}: ${err.code ?? err.message}`);
  }
}

function recordedBranch(stateText) {
  const line = field(stateText, "branch") ?? "";
  return { name: line.split(/\s+/)[0] || null, cut: line.match(/\(cut from .+ at ([0-9a-f]{7,40})\)/)?.[1] ?? null };
}

// The commits since the branch was cut: from the recorded cut sha, else everything no sanctioned
// cut-point reaches, which is the nearest merge-base by ancestry, as references/branch.md's Base rule
// picks it.
function sinceCut(cwd, cut) {
  if (cut) return [`${cut}..HEAD`];
  // No recorded cut: exclude every cut-point references/branch.md names (§ Committing's integration
  // branches and the default branch, each candidate when it is unresolved).
  const cutPoints = new Set([...INTEGRATION_BRANCHES, ...defaultBranches(cwd), "main", "master"]);
  const exclude = ["refs/remotes/origin/HEAD", ...[...cutPoints].flatMap((n) => [`refs/heads/${n}`, `refs/remotes/origin/${n}`])]
    .filter((ref) => git(cwd, ["rev-parse", "--verify", "--quiet", ref]).status === 0);
  return exclude.length ? ["HEAD", "--not", ...exclude] : ["HEAD"];
}

function findTaskCommit(cwd, range, value, files) {
  const log = gitOut(cwd, ["log", `--format=%H%x09%(trailers:key=${TRAILER_KEY},valueonly,separator=%x2C)`, ...range]);
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, values = ""] = line.split("\t");
    if (!values.split(",").map((v) => v.trim()).includes(value)) continue;
    const touched = gitOut(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]).split("\n").filter(Boolean);
    if (touched.every((p) => files.has(p))) return sha;
  }
  return null;
}

// The test command is the plan's own text, so it runs through the shell exactly as typed; its output
// goes to the gate evidence file, never to this script's stdout.
function runShell(cwd, cmd) {
  const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`cannot run "${cmd}": ${r.error.message}`);
  return { cmd, status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// executing-waves.md step 6: a whole-suite red is the task's own unless foreign-change-check reports a
// sibling's edit and the task's file-scoped subset is green — then it is deferred, never attributed.
function greenGate(cwd, { testCmd, subsetCmd, files }) {
  const whole = runShell(cwd, testCmd);
  if (whole.status === 0) return { gate: "pass", runs: [whole] };
  const foreign = spawnSync(process.execPath, [FOREIGN_CHANGE_CHECK, ...files], { cwd, encoding: "utf8" });
  if (foreign.error) throw new Error(`foreign-change-check did not run: ${foreign.error.message}`);
  if (foreign.status === 0) return { gate: "fail", status: whole.status, runs: [whole] };
  const subset = runShell(cwd, subsetCmd ?? testCmd);
  return subset.status === 0
    ? { gate: "deferred", runs: [whole, subset] }
    : { gate: "fail", status: subset.status, runs: [whole, subset] };
}

function writeGateEvidence(root, task, runs) {
  const rel = `.devcycle/evidence/${task}-gate.txt`;
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWrite(abs, runs.map((r) => `# devcycle-cmd: ${r.cmd}\n${r.output}# exit ${r.status}\n`).join("\n"));
  return rel;
}

// The task's changed Files the commit names, and those `git add` must take: all but a path already
// gone from the index — a staged deletion, a staged rename's source — which `git add` refuses as
// matching nothing. A path new to the index and since deleted from the work tree — added, renamed or
// copied, then removed — is no change against HEAD: `git add` drops it from the index, after which
// git knows it nowhere and a commit naming it fails. `-z` keeps paths verbatim; a rename's or copy's
// source path follows its entry as a field of its own. Either status column may carry the R — X for a
// staged rename, Y for a work-tree one `git add -N <new>` made visible — and a renamed-away Files path
// is a deletion the commit takes.
function changedTaskFiles(cwd, files) {
  const fields = gitOut(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...files]).split("\0");
  const changed = [];
  const toAdd = [];
  const take = (path, { add = true, commit = true } = {}) => {
    if (!files.has(path)) return;
    if (commit) changed.push(path);
    if (add) toAdd.push(path);
  };
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const [x, y] = entry;
    take(entry.slice(3), { add: x !== "D", commit: !(/[ARC]/.test(x) && y === "D") });
    if (!/[RC]/.test(x + y)) continue;
    const source = fields[++i];
    if (y === "R") take(source);
    else if (x === "R") take(source, { add: false });
  }
  return { changed, toAdd };
}

function appendRows({ toplevel, run }, specs) {
  const appended = [];
  for (const [kind, fields, matchKeys] of specs)
    if (appendRunRecordOnce({ toplevel, run, kind, fields, matchKeys }).appended) appended.push(`rr:${kind}`);
  return appended;
}

function acceptedVerdict({ toplevel, run, task }, round) {
  let hit = null;
  eachRecord(recordPath(toplevel, run), (r) => {
    if (r.kind === "verdict" && r.taskId === task && r.round === round && r.conformance === "pass") hit = r;
  });
  return hit;
}

// Every gate line of this task in the ledger gets its run-record rows, keyed by the line's own stamp,
// so rows a crash cut off after their ledger line are written by the task's next call.
function reconcileGateRows(ctx) {
  const { ledgerPath, task, culprit } = ctx;
  const specs = [];
  for (const e of taskEntries(ledgerPath, task)) {
    if (e.event !== "review-verdict" || !e.key) continue;
    if (e.outcome === DEFERRED_OUTCOME)
      specs.push(["event", { event: "gate-deferred-foreign-change", stage: "execution", task, ts: e.stamp }, ["event", "task", "ts"]]);
    if (!e.outcome.startsWith(GATE_FAIL_PREFIX)) continue;
    specs.push(["event", { event: "gate-fail", stage: "execution", task, culprit, attributedBy: "coordinator", ts: e.stamp }, ["event", "task", "ts"]]);
    const round = Number(e.key.split("/")[2]);
    // Only a round whose own reviewer wrote conformance=pass gets the gate's conformance=fail line.
    const accepted = round > 0 ? acceptedVerdict(ctx, round) : null;
    if (accepted)
      specs.push(["verdict", { taskId: task, round, blockingCount: 0, evidenceClass: accepted.evidenceClass, conformance: "fail" }, ["taskId", "round", "conformance"]]);
  }
  return appendRows(ctx, specs);
}

function recordGate(ctx, gate, evidenceRef, round) {
  const { ledgerPath, task } = ctx;
  const retry = nextRetry(ledgerPath, task, "review-verdict");
  const outcome = gate.gate === "fail" ? `${GATE_FAIL_PREFIX} exit ${gate.status})` : DEFERRED_OUTCOME;
  const line = appendLedgerLine(ledgerPath, { task, event: "review-verdict", outcome, ref: evidenceRef, round, retry });
  return [...(line.appended ? [ledgerKey({ task, event: "review-verdict", round, retry })] : []), ...reconcileGateRows(ctx)];
}

// The verdict that keeps the task from its commit, or null. What commits is the reviewer's accept with
// no red gate since — what fixes a red has had no review yet — or the user's decision on the task's
// review loop after its latest verdict. A deferral or a missing findings file decides nothing.
function unaccepted(entries, task) {
  const at = entries.findLastIndex((e) =>
    e.event === "review-verdict" && e.outcome !== DEFERRED_OUTCOME && !e.outcome.startsWith(MISSING_FINDINGS));
  const verdict = entries[at]?.outcome ?? "none";
  if (verdict.startsWith("accepted")) return null;
  const decided = entries.findLastIndex((e) => e.event === "user-decision" && e.outcome.includes(reviewLoopId(task)));
  return decided > at ? null : verdict;
}

function recordCommit(ctx, sha) {
  const { ledgerPath, task } = ctx;
  const appended = [];
  if (appendLedgerLine(ledgerPath, { task, event: "committed", outcome: "green gate passed", ref: sha }).appended)
    appended.push(ledgerKey({ task, event: "committed" }));
  const committed = latestKeyed(ledgerPath, task, "committed");
  appended.push(...appendRows(ctx, [
    ["event", { event: "gate-pass-clean", stage: "execution", task, culprit: null, ts: committed.stamp }, ["event", "task"]],
    ["commit", { taskId: task, sha }, ["taskId", "sha"]],
  ]));
  return [...appended, ...reconcileGateRows(ctx)];
}

export function taskCommit(argv, cwd = process.cwd()) {
  const args = parseArgs(argv);
  const root = workTreeRoot(cwd);
  const ctx = {
    ...args,
    toplevel: gitToplevel(root),
    ledgerPath: args.ledger ? resolve(cwd, args.ledger) : join(root, ".devcycle", "ledger.md"),
  };
  const files = taskFileMap(readText(resolve(cwd, args.plan), "plan")).get(Number(args.task));
  if (!files?.size) throw new UsageError(`task ${args.task} has no **Files:** block in ${args.plan}`);
  const branch = recordedBranch(readText(join(root, ".devcycle", "state.md"), "state file"));
  if (!branch.name) throw new Error("the state file records no branch: line");
  const result = (action, extra) => ({ action, task: args.task, ...extra });
  const branchMismatch = () => {
    const current = gitOut(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return current === branch.name ? null : result("branch-mismatch", { recorded: branch.name, current, appended: [] });
  };

  const found = findTaskCommit(root, sinceCut(root, branch.cut), `${args.run}/${args.task}`, files);
  if (found) return result("already-committed", { gate: "pass", sha: found, appended: recordCommit(ctx, found) });
  const entries = taskEntries(ctx.ledgerPath, args.task);
  const waiting = pendingReviewLoop(root, args.task, entries);
  if (waiting) return result("needs-user", { reason: "review loop exhausted-unresolved", loopId: waiting, appended: [] });
  const blocker = unaccepted(entries, args.task);
  if (blocker)
    throw new UsageError(`task ${args.task} has no open accept to commit (its latest verdict: ${blocker}) — a fix after a red gate needs the next round's review first`);

  const before = branchMismatch();
  if (before) return before;
  const gate = greenGate(root, { testCmd: args.testCmd, subsetCmd: args.subsetCmd, files: [...files] });
  const evidenceRef = writeGateEvidence(root, args.task, gate.runs);
  if (gate.gate !== "pass") {
    const round = latestKeyed(ctx.ledgerPath, args.task, "review-round")?.round ?? 0;
    // A red gate rejects the round its reviewer accepted, so it counts toward the review loop's cap;
    // past it, the red gate is the one item left unresolved. The status goes before the gate's line,
    // so that line never stands without it as one more fix round; a crash between them leaves the
    // accept to gate again.
    const loopId = gate.gate === "fail" && round >= ROUND_CAP ? exhaustReviewLoop(root, args.task, round, 1) : null;
    const appended = recordGate(ctx, gate, evidenceRef, round);
    if (gate.gate === "deferred") return result("deferred", { gate: "deferred", appended });
    if (!loopId) return result("gate-fail", { gate: "fail", appended });
    return result("needs-user", { gate: "fail", reason: "review loop exhausted-unresolved", loopId, appended });
  }

  const after = branchMismatch();
  if (after) return after;
  const { changed, toAdd } = changedTaskFiles(root, files);
  if (!changed.length) return result("nothing-to-commit", { gate: "pass", appended: [] });
  if (toAdd.length) gitOut(root, ["add", "--", ...toAdd]);
  const trailers = [...args.trailers, `${TRAILER_KEY}: ${args.run}/${args.task}`].flatMap((t) => ["--trailer", t]);
  const commit = git(root, ["commit", "--quiet", "-m", args.subject, ...trailers, "--", ...changed]);
  if (commit.status !== 0) {
    process.stderr.write(commit.stderr ?? "");
    return result("commit-failed", { gate: "pass", appended: [] });
  }
  const sha = gitOut(root, ["rev-parse", "HEAD"]).trim();
  return result("committed", { gate: "pass", sha, appended: recordCommit(ctx, sha) });
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("task-commit", () => taskCommit(process.argv.slice(2)));
