// devcycle's hooks module, loaded in-process from hooks/hooks.json's `modules`. In a session that
// joined the active devcycle run it observes each subagent and writes one agent-trace run-record row
// per finished subagent turn, under the agentId hooks/dispatch-sensor.mjs keys its agent-depth row by;
// it bounds a subagent's context by the subagentBudget tier, and shows the coordinator's stage budget
// on the status line. The engine's own forks (compaction, memory) are neither traced nor bounded.
// It runs without Node — nothing it imports may import a node: module, call require or import
// dynamically — so the state file's run, the joined-run check and the run-record write go through
// hooks/mod-sink.mjs, which it spawns. Settings hooks sit beneath it in one chain, so every hook that
// is not answering for itself returns next's result; every non-streaming hook passes the call through
// when it fails. Claude Code's loader refuses the module unless `$` reaches only functions declared
// at the top of this file and each event is registered once, so every helper below takes the
// per-load state, `st`, as an argument, and one tool.call hook serves every behaviour.
import { HARD_STOP, OVER_BUDGET, STAGE_FILES_READ, STAGE_TOOL_CALLS, budgetBand, contextDepth, windowFor } from "../scripts/depth-bands.mjs";
import { activeRun } from "./lib/run-scope.mjs";

// The first Claude Code whose hooks-module API this module is written against; below it the
// early-access API differs, so the module stays inert (docs/platform-notes.md § (j)).
const MIN_CLAUDE_CODE = [2, 1, 287];
// A module's environment has no CLAUDE_PLUGIN_ROOT; its own file URL is the anchor.
const SINK = decodeURIComponent(new URL("./mod-sink.mjs", import.meta.url).pathname);
const STATE_REL = ".devcycle/state.md";
const MAX_WALK = 64;
const INERT = Object.freeze({ active: false, stateFile: null });
// The limiter's tiers, the reads `enforce` refuses at the hard stop (never Write, Edit or Bash), and
// how often the over-budget note repeats after its first crossing.
const TIERS = ["off", "warn", "enforce"];
const BOUNDED_READS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
const NOTE_EVERY = 5;
const percent = (fraction) => Math.round(fraction * 100);
const HARD_STOP_DENY =
  `devcycle budget: hard stop at ${percent(HARD_STOP)}% of the context window. Do not read further; ` +
  "return what you have and name what you did not explore.";
const budgetNote = (fraction) =>
  `devcycle budget: this subagent is at ≈${percent(fraction)}% of its context window (over budget at ` +
  `${percent(OVER_BUDGET)}%, hard stop at ${percent(HARD_STOP)}%). Finish with what you have; name what you did not explore.`;

function atLeastFloor(base) {
  const parts = String(base ?? "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== MIN_CLAUDE_CODE[i]) return parts[i] > MIN_CLAUDE_CODE[i];
  return true;
}

const stateFileIn = (dir) => `${dir === "/" ? "" : dir}/${STATE_REL}`;
// A worktree's `.git` is a file, so only its existence is asked.
const gitIn = (dir) => `${dir === "/" ? "" : dir}/.git`;
const parentOf = (dir) => dir.slice(0, dir.lastIndexOf("/")) || "/";
// A session joins a run by appending its session row from a main-loop Bash call (commands/cycle.md,
// commands/continue.md), which leaves the state file untouched.
const appendsSessionRow = (e) => e.tool === "Bash" && typeof e.command === "string" && e.command.includes("--kind session");

// A subagent's per-turn counters. Its identity survives a reset, because a continued agent
// (SendMessage, a resume) keeps its agentId.
const turnCounters = () => ({ steps: 0, peakDepth: 0, lastDepth: null, model: null, toolResultChars: 0, warned: 0, refused: 0, overResults: 0 });

// Everything one load of the module knows. `joinedKey` is "<session id> <run id>" once the sink
// answered joined; a negative answer is never cached. `scope` is the promise active() answers from.
// `tier` is the subagentBudget value Claude Code hands register; anything else reads as warn.
// `meter` is the stage meter's counters for the stage it last displayed.
function newState(options) {
  return { versionOk: null, notNested: null, joinedKey: null, scope: null, agents: new Map(),
    tier: TIERS.includes(options?.subagentBudget) ? options.subagentBudget : "warn",
    meter: { stage: null, calls: 0, files: new Set(), percent: null, shown: false } };
}

async function resolveScope(st, $) {
  st.versionOk ??= $.session.version().then((v) => atLeastFloor(v?.base), () => false);
  st.notNested ??= $.env.get("DEVCYCLE_NESTED_RUN").then((v) => !v, () => false);
  if (!(await st.versionOk) || !(await st.notNested)) return INERT;
  const cwd = await $.session.cwd();
  let stateFile = null;
  let root = null;
  for (let dir = cwd, i = 0; i < MAX_WALK && !stateFile; i++) {
    if (await $.fs.exists(stateFileIn(dir))) stateFile = stateFileIn(dir);
    else {
      if (root === null && (await $.fs.exists(gitIn(dir)))) root = dir;
      if (parentOf(dir) === dir) break;
      dir = parentOf(dir);
    }
  }
  // A cycle writes its state file at the repo root (references/resume.md § The state file), so with
  // none found yet that is where one appears; the cwd's own candidate covers a directory outside git.
  if (!stateFile) return { active: false, stateFile: null, candidates: [...new Set([root ?? cwd, cwd])].map(stateFileIn) };
  const { mtimeMs } = await $.fs.stat(stateFile);
  const run = activeRun(await $.fs.read(stateFile));
  if (!run) return { active: false, stateFile, mtimeMs };
  const sessionId = await $.session.id();
  const key = `${sessionId} ${run.run}`;
  if (st.joinedKey !== key) {
    const answer = await $.process.run(["node", SINK, "check-joined", "--run", run.run, "--session", sessionId, "--cwd", cwd]);
    if (answer.exitCode !== 0 || answer.stdout.trim() !== "joined") return { active: false, stateFile, mtimeMs };
    st.joinedKey = key;
  }
  return { active: true, stateFile, mtimeMs, run: run.run, stage: run.stage, sessionId, cwd };
}

function current(st, $) {
  return (st.scope ??= resolveScope(st, $).catch(() => INERT));
}

function refresh(st, $) {
  st.scope = resolveScope(st, $).catch(() => INERT);
}

async function active(st, $) {
  return (await current(st, $)).active;
}

function entry(st, agentId) {
  let a = st.agents.get(agentId);
  if (!a) {
    a = { tracked: false, engineFork: false, agentType: null, requestedModel: null, resolvedModel: null,
      parentAgentId: null, background: false, fork: false, isTeammate: false, ...turnCounters() };
    st.agents.set(agentId, a);
  }
  return a;
}

// One stat per main-loop tool call: a cycle's start, a stage advance or a finished cycle writes the
// state file. A session-row append while inactive asks the joined question again, once, right then.
async function afterMainLoopCall(st, $, e) {
  const seen = await current(st, $);
  if ((appendsSessionRow(e) && !seen.active) || (await stateFileChanged($, seen))) refresh(st, $);
  await updateMeter(st, $, e);
}

// A state file that appeared or disappeared changed as much as a rewritten one. With none known, only
// the repo root's and the cwd's candidates are checked, so outside a devcycle run each call costs at
// most two exists.
async function stateFileChanged($, seen) {
  if (seen.stateFile) return (await $.fs.stat(seen.stateFile).then((s) => s.mtimeMs, () => null)) !== seen.mtimeMs;
  for (const candidate of seen.candidates ?? []) if (await $.fs.exists(candidate)) return true;
  return false;
}

// The stage meter: in an interactive session, the coordinator's stage budget on the status line
// (references/delegation.md § The stage budget). It only displays; it never refuses a call.
async function updateMeter(st, $, e) {
  const meter = st.meter;
  const now = await current(st, $);
  if (!now.active || (await $.session.surfaces()).length === 0) {
    if (meter.shown) {
      meter.shown = false;
      await $.ui.status(undefined);
    }
    return;
  }
  if (now.stage !== meter.stage) Object.assign(meter, { stage: now.stage, calls: 0, files: new Set() });
  meter.calls += 1;
  if (e.tool === "Read" && typeof e.file_path === "string") meter.files.add(e.file_path);
  meter.shown = true;
  // Claude Code labels a plugin's status entry with the plugin's name, so the text leaves it out.
  await $.ui.status(`${meter.stage} · calls ${meter.calls}/~${STAGE_TOOL_CALLS} · ` +
    `files ${meter.files.size}/~${STAGE_FILES_READ} · ctx ${meter.percent ?? "–"}%`);
}

async function mainLoopToolCall(st, $, e, next) {
  const result = await next(e);
  await afterMainLoopCall(st, $, e);
  return result;
}

// Where a bounded subagent stands, or null: untracked, a fork (it inherits its parent's context, so
// it would meet the hard stop on its first step) or a teammate (a session of its own), no measured
// step yet, or a window no model table knows. An assumed window counts.
function standing(st, agentId) {
  const a = st.agents.get(agentId);
  if (!a?.tracked || a.fork || a.isTeammate || a.lastDepth === null || !a.model) return null;
  const w = windowFor(a.model);
  return w ? { a, band: budgetBand(a.lastDepth, w.window), fraction: a.lastDepth / w.window } : null;
}

// The observer's character count and the limiter: past the over-budget band a bounded subagent's
// result carries the note on the first crossing and every NOTE_EVERY-th result after it; under
// enforce a bounded read at the hard stop is refused before it runs. A refused call carries no
// result to attach a note to.
async function subagentToolCall(st, $, e, next) {
  const at = st.tier === "off" ? null : standing(st, e.agentId);
  const bounded = at !== null && at.band !== "ok" && (await active(st, $));
  if (bounded && st.tier === "enforce" && at.band === "hard-stop" && BOUNDED_READS.has(e.tool)) {
    at.a.refused += 1;
    return { deny: HARD_STOP_DENY };
  }
  const result = await next(e);
  const a = st.agents.get(e.agentId);
  // A character count of the result text, named as such: not tokens.
  if (a?.tracked) a.toolResultChars += result.text?.length ?? 0;
  if (!bounded || result.deny !== undefined) return result;
  at.a.overResults += 1;
  if ((at.a.overResults - 1) % NOTE_EVERY !== 0) return result;
  at.a.warned += 1;
  return { ...result, context: [...(result.context ?? []), budgetNote(at.fraction)] };
}

// Whether a loop is a subagent's or a teammate's. One with no spawn on record counts only when
// `$.agent.list()` names it, as it does an agent whose spawn a module reload lost and never the
// engine's own forks; the list is asked once per such loop.
async function subagentLoop(st, $, agentId) {
  const known = st.agents.get(agentId);
  if (known) return !known.engineFork;
  const listed = (await $.agent.list()).some((agent) => agent.id === agentId);
  entry(st, agentId).engineFork = !listed;
  return listed;
}

function flush($, seen, agentId, a, e) {
  const w = a.model ? windowFor(a.model) : null;
  const record = {
    agentId, agentType: a.agentType, requestedModel: a.requestedModel, resolvedModel: a.resolvedModel,
    parentAgentId: a.parentAgentId, background: a.background, fork: a.fork, steps: a.steps, peakDepth: a.peakDepth,
    window: w?.window ?? null, windowAssumed: w?.windowAssumed === true, peakBand: w ? budgetBand(a.peakDepth, w.window) : null,
    toolResultChars: a.toolResultChars, warned: a.warned, refused: a.refused, reason: e.reason, isAborted: e.isAborted === true,
  };
  // Started, never awaited: a subagent's hand-back must not wait on a Node startup. A lost flush is
  // not retried; doctor's mod-inactive and COLLECTION GAP checks surface it.
  $.process.run(["node", SINK, "append"], { stdin: JSON.stringify({ run: seen.run, session: seen.sessionId, cwd: seen.cwd, record }) })
    .catch(() => {});
}

export function register(on, options) {
  const st = newState(options);

  // Every main-loop turn re-derives the run and the joined answer; the version and the child marker
  // are read once per load.
  on("turn.start", async ($, e, next) => {
    refresh(st, $);
    return next(e);
  }).catch(($, e, next) => next(e));

  // /clear starts a conversation under a new session id, which has not joined anything yet.
  on("session.end", async ($, e, next) => {
    const result = await next(e);
    if (e.reason === "clear") {
      st.joinedKey = null;
      st.scope = null;
    }
    return result;
  }).catch(($, e, next) => next(e));

  // /devcycle:continue appends this session's row mid-turn, after turn.start asked and was told
  // not-joined, so a spawn while inactive re-derives the scope before the agent runs: one sink check
  // per spawn, and only until the session has joined (spec §4.3 amendment, 2026-10-07).
  on("agent.spawn", async ($, e, next) => {
    if (!(await active(st, $))) refresh(st, $);
    const result = await next(e);
    if (result.agentId && (await active(st, $)))
      Object.assign(entry(st, result.agentId), {
        agentType: e.subagentType, requestedModel: e.model ?? null, resolvedModel: result.model ?? null,
        parentAgentId: e.parentAgentId ?? null, background: e.background === true, fork: e.fork === true,
        isTeammate: e.isTeammate === true,
      });
    return result;
  }).catch(($, e, next) => next(e));

  // Tracking starts at an agent's first step, not its spawn, so state lost to a module reload costs
  // the spawn's fields, never the record. A streaming hook: its bookkeeping catches its own errors
  // once the stream has been relayed.
  on("turn.step", async function* ($, e, next) {
    const stepping = next(e);
    for await (const chunk of stepping) yield chunk;
    const result = await stepping.result;
    try {
      if (e.agentId !== undefined && (await active(st, $)) && (await subagentLoop(st, $, e.agentId))) {
        const a = entry(st, e.agentId);
        a.tracked = true;
        const depth = contextDepth(result.usage);
        if (depth !== null) {
          a.steps += 1;
          a.lastDepth = depth;
          a.peakDepth = Math.max(a.peakDepth, depth);
          a.model = result.usage.model ?? e.model;
        }
      }
    } catch { /* observation only: a failed count never touches the step */ }
    return result;
  });

  // The module's one tool.call hook: the loader refuses a second unmatched registration.
  on("tool.call", async ($, e, next) =>
    (e.agentId === undefined ? mainLoopToolCall(st, $, e, next) : subagentToolCall(st, $, e, next)))
    .catch(($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    const a = e.agentId === undefined ? undefined : st.agents.get(e.agentId);
    if (a?.tracked) {
      const seen = await current(st, $);
      if (seen.active) flush($, seen, e.agentId, a, e);
      Object.assign(a, turnCounters());
    }
    return result;
  }).catch(($, e, next) => next(e));

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    if (typeof e.context?.percent === "number") st.meter.percent = Math.round(e.context.percent);
    return result;
  }).catch(($, e, next) => next(e));
}
