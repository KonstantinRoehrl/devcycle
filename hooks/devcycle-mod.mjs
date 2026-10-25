// devcycle's hooks module, loaded in-process from hooks/hooks.json's `modules`. In a session that
// joined the active devcycle run it observes each subagent and writes one agent-trace run-record row
// per finished subagent turn, under the agentId hooks/dispatch-sensor.mjs keys its agent-depth row by;
// it bounds a subagent's context by the subagentBudget tier, and shows the coordinator's stage budget
// on the status line. In any session it raises the terminal notifications scripts/handoff-mark.mjs
// prints and, in an interactive one, draws the execution driver's progress band above the prompt. The
// engine's own forks (compaction, memory) are neither traced nor bounded.
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
// The drive band's file, beside the state file. scripts/drive-progress.mjs owns its shape and writes it
// through Node, which this module cannot import, so the path is restated here.
const PROGRESS_REL = ".devcycle/drive-progress.json";
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

function atLeast(base, version) {
  const parts = String(base ?? "").match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== version[i]) return parts[i] > version[i];
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
// `meter` is the stage meter's counters for the stage it last displayed; `band` is the drive band's
// timer and the progress file it last read.
function newState(options) {
  return { version: null, notNested: null, joinedKey: null, scope: null, agents: new Map(),
    tier: TIERS.includes(options?.subagentBudget) ? options.subagentBudget : "warn",
    meter: { stage: null, calls: 0, files: new Set(), percent: null, shown: false },
    band: { timer: null, busy: false, stamp: null, progress: null, frame: 0, moving: false } };
}

const versionOf = (st, $) => (st.version ??= $.session.version().then((v) => v?.base ?? null, () => null));

async function resolveScope(st, $) {
  st.notNested ??= $.env.get("DEVCYCLE_NESTED_RUN").then((v) => !v, () => false);
  if (!atLeast(await versionOf(st, $), MIN_CLAUDE_CODE) || !(await st.notNested)) return INERT;
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

// A section read is a file read the meter must see too. The agent's command carries the expanded
// plugin root, so this matches the script name rather than the ${CLAUDE_PLUGIN_ROOT} citation form.
const SECTION_READ_CALL = /([^\s"']*)read-section\.mjs["']?\s+(["']?)(references\/[A-Za-z0-9._-]+\.md)\2/g;

// Keyed like a Read's file_path, so one file read both ways counts once: an absolute script path
// (<root>/scripts/read-section.mjs) names the plugin root; without one the relative path stands.
function sectionReadKey([, scriptDir, , reference]) {
  return scriptDir.startsWith("/") ? scriptDir.replace(/[^/]+\/$/, "") + reference : reference;
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
  if (e.tool === "Bash" && typeof e.command === "string")
    for (const m of e.command.matchAll(SECTION_READ_CALL)) meter.files.add(sectionReadKey(m));
  meter.shown = true;
  // Claude Code labels a plugin's status entry with the plugin's name, so the text leaves it out.
  await $.ui.status(`${meter.stage} · calls ${meter.calls}/~${STAGE_TOOL_CALLS} · ` +
    `files ${meter.files.size}/~${STAGE_FILES_READ} · ctx ${meter.percent ?? "–"}%`);
}

// scripts/handoff-mark.mjs prints one `notify: terminal <message>` line per handoff notification the
// handoffNotification knob asks for. A Bash child has no terminal of its own, so the module raises it
// through the person's notification channel; a Claude Code without $.ui.notify throws on the call, which
// the catch below absorbs.
const HANDOFF_MARK_CALL = /handoff-mark\.mjs/;
const TERMINAL_NOTICE = /^notify: terminal (.+)$/gm;

function relayNotifications($, e, result) {
  try {
    if (e.tool !== "Bash" || typeof e.command !== "string" || !HANDOFF_MARK_CALL.test(e.command)) return;
    const stdout = result?.result?.stdout;
    if (typeof stdout !== "string") return;
    for (const [, message] of stdout.matchAll(TERMINAL_NOTICE)) $.ui.notify(message, { title: "devcycle" }).catch(() => {});
  } catch { /* a notification never fails the call it rode on */ }
}

async function mainLoopToolCall(st, $, e, next) {
  const result = await next(e);
  relayNotifications($, e, result);
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

// The drive band: a running execution driver's progress above the prompt, read from the file the
// driver keeps (PROGRESS_REL), so watching a run costs no model turn. A timer stats the file each tick,
// reads it only when its size or mtime moved, and writes what the drawing needs into BAND; the
// drawing reads only BAND. Interactive sessions only: a `claude -p` run has nothing to draw on.
const BAND = { plugin: "devcycle", key: "band" };
const BAND_TICK_MS = 300;
const SILENT_AFTER_MS = 120_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const RUN_STATES = new Set(["running", "waiting", "stopped", "ended"]);
const LIVE_STATES = new Set(["running", "waiting"]);
// Below this Claude Code, AbovePrompt's bodyColumns still counts the five cells of the band's own
// [-] mark (seen on 2.1.287; 2.1.292 reports them left out).
const BODY_COLUMNS_LEAVE_MARK = [2, 1, 292];
const MARK_COLUMNS = 5;

const cells = (text) => [...text].length;
const pad2 = (n) => String(n).padStart(2, "0");
const clockTime = (iso) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "--:--" : `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
};
function elapsedText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return `${Math.floor(Math.max(0, ms) / 1000)}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m`;
}

function parseProgress(text) {
  try {
    const p = JSON.parse(text);
    return p?.v === 1 && RUN_STATES.has(p.state) && Array.isArray(p.waves) ? p : null;
  } catch {
    return null;
  }
}

// A live run whose driver has not rewritten the file for SILENT_AFTER_MS; its heartbeat is 30 s.
const silent = (p, now) => LIVE_STATES.has(p.state) && now - Date.parse(p.updatedAt) > SILENT_AFTER_MS;
const moving = (p, now) => p !== null && LIVE_STATES.has(p.state) && !silent(p, now);

async function startBand(st, $) {
  if (st.band.timer || (await $.session.surfaces()).length === 0) return;
  st.band.timer = $.clock.every(BAND_TICK_MS, () => bandTick(st, $));
}

// A slow host call never stacks ticks. BAND is written only when the file changed, while the spinner
// turns, and once more on the tick it stops, so an idle band costs one stat per tick.
async function bandTick(st, $) {
  const band = st.band;
  if (band.busy) return;
  band.busy = true;
  try {
    const { stateFile } = await current(st, $);
    const path = stateFile ? stateFile.slice(0, -STATE_REL.length) + PROGRESS_REL : null;
    const stat = path ? await $.fs.stat(path).catch(() => null) : null;
    const stamp = stat ? `${stat.mtimeMs} ${stat.size}` : null;
    const changed = stamp !== band.stamp;
    if (changed) {
      band.stamp = stamp;
      band.progress = stamp === null ? null : parseProgress(await $.fs.read(path).catch(() => ""));
    }
    const now = await $.clock.now();
    const turning = moving(band.progress, now);
    if (!changed && !turning && !band.moving) return;
    if (turning) band.frame += 1;
    band.moving = turning;
    await $.state.set(BAND, { progress: band.progress, frame: band.frame, now });
  } finally {
    band.busy = false;
  }
}

function waveMark(wave, currentWave) {
  const count = `${wave.wave} ${wave.committed}/${wave.tasks.length}`;
  if (wave.tasks.length > 0 && wave.committed >= wave.tasks.length) return { text: `✓${count}`, color: "success" };
  return wave.wave === currentWave ? { text: `●${count}`, color: "claude" } : { text: `○${count}`, color: "subtle" };
}

const joined = (marks, separator) => marks.flatMap((m, i) => (i === 0 ? [m] : [{ text: separator }, m]));
const width = (segments) => segments.reduce((sum, s) => sum + cells(s.text), 0);

// Separators go first, then the strip is windowed around the current wave; it never wraps.
function fitStrip(marks, at, room) {
  for (const separator of [" · ", " "]) {
    const strip = joined(marks, separator);
    if (width(strip) <= room) return strip;
  }
  let lo = at;
  let hi = at;
  const windowed = (a, b) => [
    ...(a > 0 ? [{ text: "… " }] : []), ...joined(marks.slice(a, b + 1), " "), ...(b < marks.length - 1 ? [{ text: " …" }] : []),
  ];
  for (let grew = true; grew; ) {
    grew = false;
    if (hi < marks.length - 1 && width(windowed(lo, hi + 1)) <= room) (hi += 1), (grew = true);
    if (lo > 0 && width(windowed(lo - 1, hi)) <= room) (lo -= 1), (grew = true);
  }
  return windowed(lo, hi);
}

function stripLine(p, columns) {
  const lead = "  waves  ";
  const total = `${p.committed}/${p.total} committed`;
  const marks = p.waves.map((w) => waveMark(w, p.currentWave));
  const at = p.waves.findIndex((w) => w.wave === p.currentWave);
  const strip = fitStrip(marks, at === -1 ? marks.length - 1 : at, columns - cells(lead) - cells(total) - 2);
  const gap = Math.max(2, columns - cells(lead) - width(strip) - cells(total));
  return [{ text: lead }, ...strip, { text: " ".repeat(gap) }, { text: total }];
}

function headerLine(p, spin, now) {
  const run = `session ${p.session} · ${p.model} · ${p.effort}`;
  if (silent(p, now)) return [{ text: `? driver silent since ${clockTime(p.updatedAt)} · devcycle drive · ${run}`, color: "warning" }];
  if (LIVE_STATES.has(p.state)) return [{ text: `${spin} devcycle drive · ${run} · ${elapsedText(now - Date.parse(p.startedAt))}` }];
  return [{ text: `devcycle drive · ${run} · ${elapsedText(Date.parse(p.updatedAt) - Date.parse(p.startedAt))}` }];
}

function taskRow(t, spin) {
  if (t.step === "committed") return [{ text: `✓ task ${t.task}  committed`, color: "success" }];
  if (t.step === "pending") return [{ text: `○ task ${t.task}  pending`, color: "subtle" }];
  const round = (t.step === "reviewing" || t.step === "fixing") && t.round > 0 ? ` · round ${t.round}` : "";
  const row = [{ text: `${spin} task ${t.task}  ` }, { text: `${t.step}${round}`, color: t.step === "needs-user" ? "warning" : undefined }];
  if (t.rejections > 0) row.push({ text: ` (${t.rejections} rejection${t.rejections === 1 ? "" : "s"})`, color: "warning" });
  return row;
}

function bodyLines(p, spin) {
  if (p.state === "waiting") return [[{ text: `  ⏸ ${p.waitWhat} — resumes ${clockTime(p.waitUntil)}`, color: "warning" }]];
  if (p.state === "stopped") return [[{ text: `  ✖ stopped for you — ${p.stopDetail}`, color: "error" }]];
  if (p.state === "ended" && p.outcome === "complete") return [[{ text: "  ✓ run complete — run /devcycle:continue", color: "success" }]];
  if (p.state === "ended") return [[{ text: `  ✖ run ended: ${p.outcome} — run /devcycle:continue`, color: "error" }]];
  const wave = p.waves.find((w) => w.wave === p.currentWave);
  if (!wave) return [];
  const lead = `  wave ${wave.wave}  `;
  return wave.tasks.map((t, i) => [{ text: i === 0 ? lead : " ".repeat(cells(lead)) }, ...taskRow(t, spin)]);
}

// Each line a list of { text, color } segments; color a theme key.
function bandLines({ progress: p, frame, now }, columns) {
  const spin = silent(p, now) ? "?" : SPINNER[frame % SPINNER.length];
  return [headerLine(p, spin, now), stripLine(p, columns), ...bodyLines(p, spin)];
}

async function drawBand(st, $, e, next) {
  if (e.props.hasSurvey) return next(e);
  const value = (await $.state.get(BAND))?.value;
  if (!value?.progress) return next(e);
  const leavesMark = atLeast(await versionOf(st, $), BODY_COLUMNS_LEAVE_MARK);
  const lines = bandLines(value, e.props.bodyColumns - (leavesMark ? 0 : MARK_COLUMNS));
  const { Box, Text } = $.ui.resolve(e);
  return h(Box, { flexDirection: "column" }, ...lines.map((line) =>
    h(Text, { wrap: "truncate" }, ...line.map((s) => (s.color ? h(Text, { color: s.color }, s.text) : s.text)))));
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

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    await startBand(st, $);
    return result;
  }).catch(($, e, next) => next(e));

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => drawBand(st, $, e, next)).catch(($, e, next) => next(e));

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    if (typeof e.context?.percent === "number") st.meter.percent = Math.round(e.context.percent);
    return result;
  }).catch(($, e, next) => next(e));
}
