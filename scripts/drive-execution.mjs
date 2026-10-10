#!/usr/bin/env node
// The execution driver. After the user opted in at planning's close, it walks the execution stage
// one fresh `claude -p` session per wave — the session a manual /clear + /devcycle:continue would
// start — and stands in for the user at the wave → wave boundary only (docs/decisions/README.md,
// 2026-10-08, D7). Every other gate stops it: a driven session writes .devcycle/drive-stop.json
// through scripts/drive-signal.mjs, and the driver exits 4 with that reason. POSIX only: a signal
// reaches a session through its process group.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import agentCli from "../workflows/lib/agent-cli.js";
import { defaultBranches, isProtectedBranch } from "./branch-names.mjs";
import { parseFlags, requireCount, requireValue } from "./cli-flags.mjs";
import { contextDepth, OVER_BUDGET, windowFor } from "./depth-bands.mjs";
import { claudeProjectsDir } from "./depth-probe.mjs";
import { costUSD, provisionalCostUSD } from "./doctor.mjs";
import { acquireDriveLock, DRIVE_LOCK_REL, driveTokenHash, readLiveDriveLock, releaseDriveLock } from "./drive-lock.mjs";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { gitToplevel, hashSession, recordPath } from "./run-record.mjs";
import { eachRecord } from "./jsonl.mjs";
import { PRICING } from "./pricing.mjs";
import { now } from "./stamp.mjs";
import { parseDispatchMap, taskFileMap } from "./task-files.mjs";
import { appendRunRecordOnce, parseLedgerLine } from "./task-ledger.mjs";

const { spawnStreaming, killGroup } = agentCli;

// Measured over 69 execution sessions (2026-10-08): a session holds ~55k tokens before it reads
// anything. A window that puts that in the over-budget band cannot carry a wave.
export const SESSION_START_TOKENS = 55_000;
const LOG_REL = ".devcycle/drive.log";
const STOP_REL = ".devcycle/drive-stop.json";
const LEDGER_REL = ".devcycle/ledger.md";
const RUN_ID = /^[0-9a-f]{16}$/;
// The last of the three usage-limit signals, after a rejected rate_limit_event and the result
// text: a session silent this long is taken to be held by a limit. DEVCYCLE_DRIVE_IDLE_MS shortens
// it for tests.
const IDLE_LIMIT_MS = Number(process.env.DEVCYCLE_DRIVE_IDLE_MS) || 30 * 60_000;
const DEFAULT_BACKOFF_MS = 5 * 60_000;
const SIGNAL_GRACE_MS = 10_000;
const USAGE_LIMIT_TEXT = /usage limit|rate limit|hit your limit/i;
const MID_WAVE_LABEL = "Session ended mid-wave:";
// The ledger events that mean a task moved: a session that adds lines but none of these is churn.
const OUTCOME_EVENTS = new Set(["committed", "report-received", "review-verdict"]);
// An implementer's and a reviewer's dispatch: a session whose only lines are these made no progress,
// it sent work out and never saw it back.
const DISPATCH_EVENTS = new Set(["dispatched", "review-round"]);
// A request on a model with no price is charged as the dearest priced model, so an estimate never
// falls short.
const DEAREST_MODEL = Object.keys(PRICING.models).reduce((a, b) => (PRICING.models[b].out > PRICING.models[a].out ? b : a));

const KNOWN_FLAGS = {
  "--state": "value",
  "--model": "value",
  "--max-usd": "value",
  "--max-stalls": "value",
  "--max-churn": "value",
  "--max-backoff": "value",
  "--dry-run": "none",
  "--claude": "value",
  "--check-sandbox": "none",
  "--detach": "none",
};

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  const checkSandbox = "--check-sandbox" in flags;
  const state = requireValue(flags, "--state");
  if (!state && !checkSandbox) throw new Error("--state <path to .devcycle/state.md> is required");
  const usd = requireValue(flags, "--max-usd", "a dollar amount");
  const maxUsd = usd === undefined ? undefined : Number(usd);
  if (maxUsd !== undefined && !(maxUsd > 0))
    throw new Error(`--max-usd requires a positive dollar amount, got ${JSON.stringify(usd)}`);
  return {
    checkSandbox,
    state,
    maxUsd,
    model: requireValue(flags, "--model", "a model id"),
    maxStalls: requireCount(flags, "--max-stalls") ?? 2,
    maxChurn: requireCount(flags, "--max-churn") ?? 3,
    maxBackoffMs: (requireCount(flags, "--max-backoff", { min: 0 }) ?? 360) * 60_000,
    dryRun: "--dry-run" in flags,
    detach: "--detach" in flags,
    bin: requireValue(flags, "--claude", "an executable") ?? "claude",
  };
}

function readState(statePath) {
  const text = readFileSync(statePath, "utf8");
  const first = (key) => field(text, key)?.split(/\s+/)[0] || null;
  const drive = field(text, "drive") ?? "";
  return {
    stage: first("stage"),
    branch: first("branch"),
    plan: first("plan"),
    run: first("run"),
    opted: /^auto\b/.test(drive),
    model: drive.match(/\bmodel=(\S+)/)?.[1] ?? null,
    session: drive.match(/\bsession=([0-9a-f]{64})\b/)?.[1] ?? null,
  };
}

// A ledger whose `Plan:` header names another plan is a previous cycle's (references/resume.md).
function ledgerEntries(root, plan) {
  const path = join(root, LEDGER_REL);
  if (!plan || !existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.match(/^Plan:\s*`([^`]+)`/m)?.[1] !== plan) return [];
  return text.split("\n").map(parseLedgerLine).filter(Boolean);
}

const progressOf = (entries) => ({
  lines: entries.length,
  advanced: entries.filter((e) => !DISPATCH_EVENTS.has(e.event)).length,
  committed: entries.filter((e) => e.event === "committed").length,
  outcomes: entries.filter((e) => OUTCOME_EVENTS.has(e.event)).length,
});

// The current wave is the first Dispatch-Map wave holding an uncommitted task; those tasks are in
// flight, and so is any later wave's uncommitted task the ledger already names (wave-setup.mjs
// dispatches by readiness). Their Files blocks are where a crashed session's implementer edits may
// still sit.
export function inFlightFiles(planText, entries) {
  const committed = new Set(entries.filter((e) => e.event === "committed").map((e) => String(e.task)));
  const started = new Set(entries.map((e) => String(e.task)));
  const filesOf = taskFileMap(planText);
  const waves = [...(parseDispatchMap(planText) ?? new Map())].sort(([a], [b]) => a - b);
  for (const [wave, tasks] of waves) {
    const open = tasks.filter((t) => !committed.has(String(t)));
    if (!open.length) continue;
    const early = waves.filter(([w]) => w > wave).flatMap(([, later]) => later).filter((t) => !committed.has(String(t)) && started.has(String(t)));
    return { wave, files: new Set([...open, ...early].flatMap((t) => [...(filesOf.get(t) ?? [])])) };
  }
  return { wave: null, files: new Set() };
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function trackedChanges(root) {
  const r = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no"], { encoding: "utf8" });
  if (r.status !== 0) throw new Exit(3, `git status failed in ${root}: ${(r.stderr ?? "").trim()}`);
  const tokens = r.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    paths.push(tokens[i].slice(3));
    // A rename or copy carries its source path as the next token.
    if (/^[RC]/.test(tokens[i])) paths.push(tokens[++i]);
  }
  return paths.filter((p) => !p.startsWith(".devcycle/"));
}

// Claude Code's Bash sandbox lets a command write in the checkout but not under ~/.claude, and a
// driver started inside it would start every session sandboxed too.
function sandboxed() {
  const dir = join(homedir(), ".claude", "devcycle");
  const probe = join(dir, `.drive-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return false;
  } catch {
    return true;
  }
}

function modelRefusal(model) {
  const w = windowFor(model);
  if (!w) return `no context window is known for ${model} — add it to scripts/pricing.mjs`;
  if (SESSION_START_TOKENS / w.window >= OVER_BUDGET)
    return `${model}'s ${w.window}-token window puts a session start (~${SESSION_START_TOKENS} tokens) in the over-budget band`;
  return null;
}

// The opt-in is used once a driven session has ended: every session end writes a `drive` row.
function optInUsed(root, run) {
  let used = false;
  eachRecord(recordPath(gitToplevel(root), run), (r) => {
    used = r.kind === "drive";
    return !used;
  });
  return used;
}

const heldBy = (h) =>
  `a driver already runs for this checkout (pid ${h.pid}, log ${h.log}) — stop it, or wait for it to end; ` +
  `if pid ${h.pid} is no longer running (after a reboot, say), remove ${DRIVE_LOCK_REL}`;

const sessionHashOf = (env) => (env.CLAUDE_CODE_SESSION_ID ? hashSession(env.CLAUDE_CODE_SESSION_ID) : null);

function checkEnvironment(root, state, opts) {
  if (!state.opted) throw new Exit(3, "the state file has no `drive: auto` row — unattended execution is opted into at planning's close");
  if (state.stage !== "execution") throw new Exit(3, `the state is at stage ${state.stage}, not execution`);
  if (!RUN_ID.test(state.run ?? "")) throw new Exit(3, "the state file names no run id, so no drive record could be written");
  // An agent never starts a driver (D7). Inside a Claude Code session the one start allowed is the
  // opt-in gate's start-now: from the session the drive row names as the one the user answered in,
  // before any driven session has ended. A row naming no session admits none.
  const gateSession = state.session !== null && sessionHashOf(process.env) === state.session;
  if (process.env.CLAUDECODE && (!gateSession || optInUsed(root, state.run)))
    throw new Exit(3, "inside a Claude Code session only the opt-in gate's start-now may start a driver, before its first session ends — start it from your own terminal");
  const model = opts.model ?? state.model;
  if (!model) throw new Exit(3, "no model: the drive row records none and --model is absent");
  const current = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current !== state.branch) throw new Exit(3, `the checkout is on ${current}, but the state records ${state.branch}`);
  if (!defaultBranches(root).length)
    throw new Exit(3, "cannot resolve the default branch to keep cycle work off it — set origin/HEAD (`git remote set-head origin --auto`) or `git config init.defaultBranch <name>`");
  if (isProtectedBranch(root, current))
    throw new Exit(3, `${current} is the default or an integration branch — cycle work runs on a topic branch`);
  let planText;
  try {
    planText = readFileSync(join(root, state.plan), "utf8");
  } catch {
    throw new Exit(3, `the plan ${state.plan} cannot be read`);
  }
  const { files } = inFlightFiles(planText, ledgerEntries(root, state.plan));
  const stray = trackedChanges(root).filter((p) => !files.has(p));
  if (stray.length)
    throw new Exit(3, `tracked changes outside the current wave's in-flight tasks: ${stray.slice(0, 5).join(", ")}${stray.length > 5 ? ", …" : ""}`);
  const refusal = modelRefusal(model);
  if (refusal) throw new Exit(3, refusal);
  if (sandboxed()) throw new Exit(3, "cannot write under ~/.claude — this looks like a Claude Code Bash sandbox; start the driver from a normal terminal");
  return { model, planText, plan: state.plan, run: state.run };
}

function release(ctx) {
  if (ctx.lock) releaseDriveLock(ctx.root, ctx.lock);
  ctx.lock = null;
}

// Fail closed: every refusal exits 3 and leaves no lock behind.
function preflight(opts) {
  let statePath;
  try {
    statePath = realpathSync(resolve(opts.state));
  } catch {
    throw new Exit(3, `no state file at ${opts.state}`);
  }
  if (basename(dirname(statePath)) !== ".devcycle") throw new Exit(2, "--state must name a .devcycle/state.md");
  const root = dirname(dirname(statePath));
  // The token proves to wave-setup.mjs that a session was started by this driver; the lock keeps
  // only its hash, and only the sessions this driver starts are handed the token itself.
  const ctx = { root, statePath, stateRel: relative(root, statePath), lock: null, session: null, token: randomBytes(16).toString("hex") };
  if (opts.dryRun) {
    const holder = readLiveDriveLock(root);
    if (holder) throw new Exit(3, heldBy(holder));
  } else {
    const got = acquireDriveLock(root, { statePath: ctx.stateRel, logPath: LOG_REL, tokenHash: driveTokenHash(ctx.token) });
    if (!got.ok) throw new Exit(3, heldBy(got.holder));
    ctx.lock = got.lock;
  }
  try {
    Object.assign(ctx, checkEnvironment(root, readState(statePath), opts));
  } catch (err) {
    release(ctx);
    throw err;
  }
  return ctx;
}

function sessionArgs(ctx, opts, spent) {
  const args = ["-p", `/devcycle:continue --drive ${ctx.stateRel}`, "--model", ctx.model,
    "--permission-mode", "auto", "--output-format", "stream-json", "--verbose"];
  if (opts.maxUsd !== undefined) args.push("--max-budget-usd", Math.max(opts.maxUsd - spent, 0.01).toFixed(2));
  return args;
}

function childEnv(ctx) {
  const env = { ...process.env, DEVCYCLE_DRIVE_TOKEN: ctx.token };
  // agent-cli's claudeStructured sets this for its own children, and a driver started from one of
  // them inherits it; a driven session that kept it would run with the hooks module inert — no
  // agent tracing, no subagent budget governor.
  delete env.DEVCYCLE_NESTED_RUN;
  return env;
}

// killGroup is safe only while the child is unreaped (workflows/lib/agent-cli.js).
function stopSession(handle) {
  if (handle && handle.child.exitCode === null && handle.child.signalCode === null) killGroup(handle.child);
}

// Stream-json repeats a request's assistant event once per content block and reports its output
// tokens before they are generated. So a request is priced once, with its output taken as no less
// than half the characters it streamed or logged: an over-count, which is the side a cap may err on.
function estimateUsd(requests, sessionModel) {
  let usd = 0;
  for (const { usage, model = sessionModel, chars } of requests.values()) {
    const priced = { ...usage, output_tokens: Math.max(usage.output_tokens ?? 0, Math.ceil(chars / 2)) };
    usd += costUSD(priced, model) ?? provisionalCostUSD(priced, model)?.dollars ?? costUSD(priced, DEAREST_MODEL);
  }
  return usd;
}

// A request seen more than once keeps the usage of whichever record counts more output.
const moreOutput = (a, b) => ((b.output_tokens ?? 0) > (a.output_tokens ?? 0) ? b : a);

function tallyRequest(requests, message) {
  if (!message?.usage) return;
  const key = message.id ?? Symbol("unnamed request");
  const request = requests.get(key) ?? { usage: message.usage, model: message.model, chars: 0 };
  request.usage = moreOutput(request.usage, message.usage);
  request.chars += JSON.stringify(message.content ?? []).length;
  requests.set(key, request);
}

// <projects>/<slug>/<session>.jsonl and <projects>/<slug>/<session>/subagents/agent-<id>.jsonl. The
// slug is found by the session id rather than derived from the checkout's path, whose escaping
// is Claude Code's to change.
function sessionTranscripts(sessionId) {
  const projects = claudeProjectsDir();
  const listing = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const slug = listing(projects).find((p) => existsSync(join(projects, p, `${sessionId}.jsonl`)));
  if (!slug) return [];
  const agents = join(projects, slug, sessionId, "subagents");
  return [join(projects, slug, `${sessionId}.jsonl`), ...listing(agents).filter((f) => f.endsWith(".jsonl")).map((f) => join(agents, f))];
}

// Claude Code appends these transcripts as a session runs, so they outlive a killed one, and they
// hold what the stream lacks: the main session's final output counts, and any subagent request the
// stream did not carry. A request is logged once per content block. A subagent's rows carry the
// output count from before it generated anything (Claude Code 2.1.296), so, as for the stream, the
// characters it logged are what floor its output.
function tallyTranscripts(requests, sessionId) {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId ?? "")) return;
  const logged = new Map();
  const visit = (r) => {
    if (r.type === "assistant" && r.message?.id) tallyRequest(logged, r.message);
  };
  for (const file of sessionTranscripts(sessionId)) {
    try {
      eachRecord(file, visit, { lineFilter: (line) => line.includes('"usage"') });
    } catch {
      // An unreadable transcript leaves the estimate to the stream.
    }
  }
  // A request the stream carried too is priced once, on whichever record of it says more.
  for (const [id, request] of logged) {
    const known = requests.get(id);
    if (!known) requests.set(id, request);
    else {
      known.usage = moreOutput(known.usage, request.usage);
      known.chars = Math.max(known.chars, request.chars);
    }
  }
}

// Only devcycle's own errors stop a session; an entry that names no plugin is counted, not guessed away.
const devcycleErrors = (errors) =>
  errors.filter((err) => {
    const name = err?.plugin ?? err?.name;
    return typeof name !== "string" || /^devcycle(@|$)/.test(name);
  });

function finalize(s, model) {
  const r = s.result;
  s.resultText = typeof r?.result === "string" ? r.result : "";
  s.costUsd = typeof r?.total_cost_usd === "number" ? r.total_cost_usd : null;
  // A session killed or crashed before its result event still spent money.
  if (s.costUsd === null) tallyTranscripts(s.requests, s.sessionId);
  s.spentUsd = s.costUsd ?? estimateUsd(s.requests, model);
  s.denials = Array.isArray(r?.permission_denials) ? r.permission_denials.length : 0;
  if (!s.limit && r?.is_error && USAGE_LIMIT_TEXT.test(s.resultText))
    s.limit = { resetAt: Number(s.resultText.match(/\|(\d{9,})\b/)?.[1]) || null };
  return s;
}

function runSession(ctx, bin, args, log, n) {
  const s = { sessionId: null, environment: null, result: null, limit: null, silent: false, tools: 0, depthTokens: null, requests: new Map() };
  let seen = ledgerEntries(ctx.root, ctx.plan).length;
  return new Promise((settle) => {
    let handle;
    let idle;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        // After its result a session has nothing left to say: silence then is a slow exit, not a limit.
        if (!s.result) s.silent = true;
        stopSession(handle);
      }, IDLE_LIMIT_MS);
    };
    const onEvent = (e) => {
      if (e.type === "system" && e.subtype === "init") {
        s.sessionId = e.session_id ?? null;
        // `plugin_errors` is absent, not [], when there are none (docs/platform-notes.md § (k)).
        const loaded = (e.plugins ?? []).some((p) => p?.name === "devcycle");
        const errors = devcycleErrors(e.plugin_errors ?? []);
        if (!loaded || errors.length) {
          s.environment = loaded
            ? `the driven session reports ${errors.length} plugin error(s)`
            : "devcycle is not loaded in the driven session";
          stopSession(handle);
        }
      } else if (e.type === "assistant") {
        tallyRequest(s.requests, e.message);
        if (!e.parent_tool_use_id) {
          s.tools += (e.message?.content ?? []).filter((c) => c?.type === "tool_use").length;
          s.depthTokens = contextDepth(e.message?.usage) ?? s.depthTokens;
        }
      } else if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") {
        s.limit = { resetAt: e.rate_limit_info.resetsAt ?? null };
      } else if (e.type === "result") {
        s.result = e;
      }
    };
    const onStdoutLine = (line) => {
      armIdle();
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      onEvent(event);
      const entries = ledgerEntries(ctx.root, ctx.plan);
      for (const entry of entries.slice(seen))
        log(`session ${n} · ${s.tools} tool calls · task=${entry.task} event=${entry.event} outcome=${entry.outcome}`);
      seen = Math.max(seen, entries.length);
    };
    let startError = null;
    handle = spawnStreaming(bin, args, { cwd: ctx.root, env: childEnv(ctx), onStdoutLine, onStderrLine: armIdle });
    ctx.session = handle;
    handle.child.once("error", (err) => {
      startError = err;
    });
    armIdle();
    // Neither an exit code nor a signal: the binary never started (workflows/lib/agent-cli.js).
    handle.done.then(({ code, signal }) => {
      clearTimeout(idle);
      ctx.session = null;
      if (code === null && signal === null) s.environment = `cannot run ${bin}: ${startError?.message ?? "it never started"}`;
      settle(finalize(s, ctx.model));
    });
  });
}

function readStop(root) {
  const path = join(root, STOP_REL);
  if (!existsSync(path)) return null;
  try {
    const stop = JSON.parse(readFileSync(path, "utf8"));
    return { reason: String(stop.reason), detail: String(stop.detail ?? "") };
  } catch {
    return { reason: "needs-user", detail: `${STOP_REL} is unreadable` };
  }
}

// Progress, judged the same however a session ended: a ledger line beyond a dispatch resets the
// stall count, and a report, verdict or commit the churn count too: churn is such lines but no task
// outcome. A session a usage limit held adds to neither count.
function progressCounts(before, after, { stalls, churn }, limited) {
  const advanced = after.advanced > before.advanced;
  const step = limited ? 0 : 1;
  return {
    stalls: advanced ? 0 : stalls + step,
    churn: after.outcomes > before.outcomes ? 0 : advanced ? churn + step : churn,
  };
}

// The evaluation order the driver promises: an interrupt, a broken environment, a stop the session
// signalled, a usage limit (its stall and churn counts, then the dollar cap, before any wait), the
// stage leaving execution, then progress and the dollar cap.
function judge({ ctx, opts, s, before, after, stalls, churn, spent, waited, interrupted }) {
  const verdict = (exitReason, code, message, extra = {}) => ({ exitReason, code, message, stalls, churn, ...extra });
  if (interrupted) return verdict("interrupted", 130, "interrupted — the session was stopped and the lock released");
  if (s.environment) return verdict("environment", 3, s.environment);
  const stop = readStop(ctx.root);
  if (stop) return verdict("stopped", 4, `stopped for you — ${stop.reason}: ${stop.detail}`, { stopReason: stop.reason });
  const overBudget = opts.maxUsd !== undefined && spent >= opts.maxUsd;
  const counts = progressCounts(before, after, { stalls, churn }, Boolean(s.limit));
  const budgetSpent = () => verdict("budget", 6, `spent $${spent.toFixed(2)} of --max-usd ${opts.maxUsd}`, counts);
  const said = `The last session said:\n${s.resultText || "(no result)"}`;
  const churned = () => verdict("stalled", 5, `stalled: ${counts.churn} sessions in a row added ledger lines but no report, verdict or commit. ${said}`, counts);
  if (s.limit || s.silent) {
    // Silence with no usage-limit signal may be a limit — or a session that hangs every time, so it
    // also counts toward a stall or churn, as an ended session would.
    if (counts.stalls >= opts.maxStalls)
      return verdict("stalled", 5, `stalled: ${counts.stalls} sessions in a row went silent with no usage-limit signal until the driver stopped them`, counts);
    if (counts.churn >= opts.maxChurn) return churned();
    if (overBudget) return budgetSpent();
    const waitMs = s.limit?.resetAt ? Math.max(s.limit.resetAt * 1000 - Date.now(), 1000) : DEFAULT_BACKOFF_MS;
    if (waited + waitMs > opts.maxBackoffMs) return verdict("budget", 6, "usage limit: waiting it out would pass --max-backoff", counts);
    return verdict("budget", null, null, { waitMs, ...counts });
  }
  const crashed = s.result === null;
  if (readState(ctx.statePath).stage !== "execution") return verdict(crashed ? "error" : "handoff", null, null);
  if (counts.stalls >= opts.maxStalls) return verdict("stalled", 5, `stalled: ${counts.stalls} sessions in a row added no ledger line beyond a dispatch. ${said}`, counts);
  if (counts.churn >= opts.maxChurn) return churned();
  const reason = crashed ? "error" : counts.stalls ? "stalled" : s.resultText.includes(MID_WAVE_LABEL) ? "valve" : "handoff";
  if (overBudget) return budgetSpent();
  return verdict(reason, null, null, counts);
}

// A session that died before its init event has no id. Its stand-in must differ per session —
// such sessions start within one second, too close for any timestamp — and the record keeps only
// its hash, so the drive token never lands there.
function writeRecord(ctx, s, r, n) {
  const fields = {
    sessionHash: hashSession(s.sessionId ?? `drive:${ctx.token}:${n}`),
    startedAt: r.startedAt,
    endedAt: now(),
    model: ctx.model,
    ledgerLinesBefore: r.before.lines,
    ledgerLinesAfter: r.after.lines,
    committedBefore: r.before.committed,
    committedAfter: r.after.committed,
    exitReason: r.exitReason,
    stallCount: r.stalls,
    guardDenials: s.denials,
  };
  if (r.stopReason) fields.stopReason = r.stopReason;
  if (s.costUsd !== null) fields.costUsd = s.costUsd;
  if (s.depthTokens !== null) fields.depthTokens = s.depthTokens;
  if (r.waveAtStart !== null) fields.waveAtStart = r.waveAtStart;
  appendRunRecordOnce({ toplevel: gitToplevel(ctx.root), run: ctx.run, kind: "drive", fields, matchKeys: ["sessionHash"] });
}

function trapSignals(ctx) {
  const trap = { interrupted: false, wake: () => {} };
  const onSignal = (sig) => {
    const handle = ctx.session;
    if (trap.interrupted) {
      stopSession(handle);
      return;
    }
    trap.interrupted = true;
    trap.wake();
    if (!handle) return;
    try {
      process.kill(-handle.child.pid, sig);
    } catch {
      stopSession(handle);
    }
    setTimeout(() => {
      if (ctx.session === handle) stopSession(handle);
    }, SIGNAL_GRACE_MS).unref();
  };
  const names = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const name of names) process.on(name, onSignal);
  trap.dispose = () => {
    for (const name of names) process.off(name, onSignal);
  };
  return trap;
}

function sleep(trap, ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    trap.wake = () => {
      clearTimeout(timer);
      done();
    };
  });
}

function isStdout(path) {
  try {
    const out = fstatSync(process.stdout.fd);
    const file = statSync(path);
    return out.dev === file.dev && out.ino === file.ino;
  } catch {
    return false;
  }
}

function makeLog(root) {
  // The lock names .devcycle/drive.log as where to watch, so the driver always writes it; started
  // detached, its stdout already is that file.
  const path = join(root, LOG_REL);
  const tee = isStdout(path) ? null : path;
  return (msg) => {
    const line = `[drive ${now()}] ${msg}\n`;
    process.stdout.write(line);
    if (tee) appendFileSync(tee, line);
  };
}

async function walk(ctx, opts, log, trap) {
  let stalls = 0;
  let churn = 0;
  let spent = 0;
  let waited = 0;
  for (let n = 1; ; n++) {
    if (trap.interrupted) return 130;
    const stage = readState(ctx.statePath).stage;
    if (stage === "branch-review") {
      log("execution is complete — the branch is ready for branch review");
      return 0;
    }
    if (stage !== "execution") {
      log(`the state left execution for stage ${stage}; stopping`);
      return 1;
    }
    rmSync(join(ctx.root, STOP_REL), { force: true });
    const entriesBefore = ledgerEntries(ctx.root, ctx.plan);
    const before = progressOf(entriesBefore);
    const waveAtStart = inFlightFiles(ctx.planText, entriesBefore).wave;
    const startedAt = now();
    log(`session ${n} starts — wave ${waveAtStart ?? "?"}, model ${ctx.model}`);
    const s = await runSession(ctx, opts.bin, sessionArgs(ctx, opts, spent), log, n);
    const after = progressOf(ledgerEntries(ctx.root, ctx.plan));
    spent += s.spentUsd;
    const verdict = judge({ ctx, opts, s, before, after, stalls, churn, spent, waited, interrupted: trap.interrupted });
    ({ stalls, churn } = verdict);
    writeRecord(ctx, s, { startedAt, before, after, waveAtStart, ...verdict }, n);
    const cost = s.costUsd !== null ? `, $${s.costUsd.toFixed(2)}` : s.spentUsd > 0 ? `, ~$${s.spentUsd.toFixed(2)} estimated` : "";
    log(`session ${n} ended — ${verdict.exitReason}; ledger +${after.lines - before.lines}, commits +${after.committed - before.committed}${cost}`);
    if (verdict.message) log(verdict.message);
    if (verdict.code !== null) return verdict.code;
    if (verdict.waitMs) {
      log(`usage limit — waiting ${Math.ceil(verdict.waitMs / 60_000)} min before the next session`);
      await sleep(trap, verdict.waitMs);
      waited += verdict.waitMs;
    }
  }
}

async function drive(opts) {
  const ctx = preflight(opts);
  if (opts.dryRun) {
    console.log(JSON.stringify({ dryRun: true, command: [opts.bin, ...sessionArgs(ctx, opts, 0)] }));
    return 0;
  }
  const trap = trapSignals(ctx);
  try {
    return await walk(ctx, opts, makeLog(ctx.root), trap);
  } finally {
    trap.dispose();
    release(ctx);
  }
}

// Runs the pre-flight here, so a refusal still exits 3 in the caller's terminal, then starts the
// driver again without --detach as a new session's leader (`detached: true` calls setsid on POSIX):
// no terminal's hangup reaches it, unlike a `nohup … &` child of the caller's session.
function detach(opts, argv) {
  const { root } = preflight({ ...opts, dryRun: true });
  const log = openSync(join(root, LOG_REL), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== "--detach")], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  console.log(JSON.stringify({ pid: child.pid, log: LOG_REL }));
  return 0;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`drive-execution: ${err.message}`);
    return 2;
  }
  if (opts.checkSandbox) {
    // The opt-in gate asks this first, and writes sessionHash into the drive row on a start-now answer.
    console.log(JSON.stringify({ sandboxed: sandboxed(), sessionHash: sessionHashOf(process.env) }));
    return 0;
  }
  try {
    return opts.detach && !opts.dryRun ? detach(opts, argv) : await drive(opts);
  } catch (err) {
    console.error(`drive-execution: ${err.message}`);
    return err instanceof Exit ? err.code : 1;
  }
}

if (isMain(import.meta.url, process.argv[1]))
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
