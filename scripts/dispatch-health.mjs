#!/usr/bin/env node
// A dispatched subagent's health, read from files only, so the coordinator, the driver's watchdog and
// the drive band can tell a dispatch that is working from one that ended without its report or
// findings file. This module is the one writer of the `dispatch-ended` ledger event and the owner
// of its cap (references/resume.md § Resuming a wave's per-task position, **Retry caps**). Run as a CLI
// by the coordinator (`playbooks/executing-waves.md` § Per-task cycle), and as a library by the
// driver's watchdog, the drive band's progress builder and the SubagentStop sensor.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { claudeProjectsDir } from "./depth-probe.mjs";
import { isMain } from "./is-main.mjs";
import { eachRecord } from "./jsonl.mjs";
import { briefPathFor, roundFindingsPath } from "./task-dispatch.mjs";
import { UsageError, appendLedgerLine, nextRetry, parseLedgerLine, taskEntries, taskFlags, workTreeRoot } from "./task-ledger.mjs";

export const DISPATCH_ENDED = "dispatch-ended";
// One redispatch per role per task, counted across sessions: a second death of the same role on the
// same task is systematic, so it is the user's to decide.
export const DEATH_CAP = 1;
const ROLES = new Set(["implementer", "reviewer"]);

export const endedOutcome = (role) => `without output (${role})`;
export const endedRole = (outcome) => outcome.match(/^without output \((implementer|reviewer)\)$/)?.[1] ?? null;

// Counted by event and role, never by outcome prefix, so the missing-report and intake-bounce caps
// stay apart from this one.
export const deathsOf = (entries, role) =>
  entries.filter((e) => e.event === DISPATCH_ENDED && endedRole(e.outcome) === role).length;

export function deathRoute(entries, role) {
  if (!ROLES.has(role) || deathsOf(entries, role) > DEATH_CAP) return "needs-user";
  return `redispatch-${role}`;
}

// The line's ref is the dead dispatch's record, so a second writer — the driver's watchdog beside the
// session's own check — finds it and appends nothing; two racing writers compute the same retry, and
// appendLedgerLine keeps one line per key.
export function recordDeath({ ledgerPath, task, role, round, recordPath }) {
  if (!ROLES.has(role)) throw new Error(`a dispatch-ended role is implementer or reviewer, got "${role}"`);
  if (!taskEntries(ledgerPath, task).some((e) => e.event === DISPATCH_ENDED && e.ref === recordPath))
    appendLedgerLine(ledgerPath, {
      task, event: DISPATCH_ENDED, outcome: endedOutcome(role), ref: recordPath, round, retry: nextRetry(ledgerPath, task, DISPATCH_ENDED),
    });
  return { next: deathRoute(taskEntries(ledgerPath, task), role) };
}


const LEDGER_REL = ".devcycle/ledger.md";
// A transcript silent this long, with no end and no tool call still inside its ceiling, is quiet: longer
// than the Bash tool's 10-minute ceiling, so a long gate run never reads quiet.
export const QUIET_MS = Number(process.env.DEVCYCLE_DISPATCH_QUIET_MS) || 15 * 60_000;
export const TOOL_CEILING_MS = Number(process.env.DEVCYCLE_DISPATCH_TOOL_CEILING_MS) || 11 * 60_000;
// A dispatch record this old with no transcript naming its brief: the Agent call never happened.
export const UNBOUND_MS = Number(process.env.DEVCYCLE_DISPATCH_UNBOUND_MS) || 2 * 60_000;
const IN_FLIGHT = { dispatched: "implementer", "review-round": "reviewer" };
const INTERRUPTED = /^\[Request interrupted by user/;
const FINAL_STOPS = new Set(["end_turn", "stop_sequence"]);
const BRIEF_IN_PROMPT = /\.devcycle\/briefs\/([A-Za-z0-9][A-Za-z0-9._-]*?)-(implementer|reviewer)(?:-round-(\d+))?\.md/;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : "";
const isMessage = (r) => r?.type === "user" || r?.type === "assistant";

// <projects>/<slug> for a session, found by its id rather than derived from the checkout's path, whose
// escaping is Claude Code's to change.
export function sessionSlugDir(sessionId, env = process.env) {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId ?? "")) return null;
  const projects = claudeProjectsDir(env);
  let slugs;
  try {
    slugs = readdirSync(projects);
  } catch {
    return null;
  }
  const slug = slugs.find((p) => existsSync(join(projects, p, `${sessionId}.jsonl`)) || existsSync(join(projects, p, sessionId)));
  return slug ? join(projects, slug) : null;
}

function sessionAgents(slugDir, sessionId) {
  const dir = join(slugDir, sessionId, "subagents");
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files.filter((f) => /^agent-[0-9a-z]+\.jsonl$/.test(f)).map((f) => ({ agentId: f.slice(6, -6), file: join(dir, f) }));
}

// Binding needs only the dispatch prompt, so it stops at the first message record.
function firstMessage(file) {
  let first = null;
  try {
    eachRecord(file, (r) => {
      if (!isMessage(r)) return true;
      first = r;
      return false;
    });
  } catch {
    return null;
  }
  return first;
}

const metaFinished = (file) => readJson(file.replace(/\.jsonl$/, ".meta.json"))?.finished === true;

// What the classifier needs from a whole transcript. Its end, as Claude Code writes it (2.1.288–2.1.311):
// the tool_result of the closing SubagentHandback (`toolEndsTurn`), an interrupt marker (a denied tool
// call, or the session killed under it), or a final assistant message with no tool call. Hook
// attachments and a torn trailing line are skipped.
export function readTranscript(file) {
  if (!existsSync(file)) return null;
  let first = null;
  let last = null;
  let toolUses = 0;
  let lastTool = null;
  eachRecord(file, (r) => {
    if (!isMessage(r)) return true;
    first ??= r;
    last = r;
    if (r.type === "assistant")
      for (const b of Array.isArray(r.message?.content) ? r.message.content : [])
        if (b?.type === "tool_use") {
          toolUses += 1;
          if (typeof b.name === "string") lastTool = b.name;
        }
    return true;
  });
  const mtimeMs = statSync(file).mtimeMs;
  if (!first) return { firstStamp: null, prompt: "", toolUses: 0, lastTool: null, terminal: false, pendingSince: null, mtimeMs };
  const blocks = Array.isArray(last.message?.content) ? last.message.content : [];
  const callsTool = blocks.some((b) => b?.type === "tool_use");
  const terminal = last.toolEndsTurn === true
    || (last.type === "user" && INTERRUPTED.test(textOf(last.message?.content).trim()))
    || (last.type === "assistant" && FINAL_STOPS.has(last.message?.stop_reason) && !callsTool);
  return {
    firstStamp: Date.parse(first.timestamp) || null, prompt: textOf(first.message?.content), toolUses, lastTool, terminal,
    pendingSince: last.type === "assistant" && callsTool ? Date.parse(last.timestamp) || null : null, mtimeMs,
  };
}

export function transcriptState(t, { now, ended = false }) {
  if (ended || t.terminal) return "ended";
  if (t.pendingSince !== null && now - t.pendingSince < TOOL_CEILING_MS) return "running";
  return now - t.mtimeMs < QUIET_MS ? "running" : "quiet";
}

const owedPath = (task, role, round) => (role === "implementer" ? `.devcycle/reports/${task}.md` : roundFindingsPath(task, round));

// The owed file counts only when written since the dispatch started: a report from an earlier round is
// not this dispatch's.
function outputPresent(root, rec) {
  const path = join(root, owedPath(rec.task, rec.role, rec.round));
  return existsSync(path) && statSync(path).mtimeMs >= Date.parse(rec.record.startedAt);
}

// This session's in-flight task dispatches: a task whose last ledger line is its dispatch, keyed, with
// a record this session wrote. An earlier session's are orphans of a cut-off, which the resume path
// redispatches uncapped (references/resume.md § Resuming a wave's per-task position).
function inFlightRecords(root, ledgerPath, sessionId) {
  const last = new Map();
  const text = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
  for (const entry of text.split("\n").map(parseLedgerLine).filter(Boolean)) last.set(entry.task, entry);
  return [...last.values()].flatMap((e) => {
    const role = IN_FLIGHT[e.event];
    if (!role || !e.key) return [];
    const [, , round, retry] = e.key.split("/").map(Number);
    const recordPath = `.devcycle/dispatch/${e.task}-${role}-${round}-${retry}.json`;
    const record = readJson(join(root, recordPath));
    return record?.sessionId === sessionId ? [{ task: e.task, role, round, retry, recordPath, record }] : [];
  });
}

// A transcript binds to the record whose brief its dispatch prompt names, started at or after the
// record; the earliest such wins. The agent id is written back, so later calls read one file.
function bindRecord(root, rec, agents, claimed) {
  if (rec.record.agentId) return agents.find((a) => a.agentId === rec.record.agentId) ?? null;
  const brief = briefPathFor(rec.task, rec.role, rec.round);
  const startedMs = Date.parse(rec.record.startedAt);
  const hit = agents
    .filter((a) => !claimed.has(a.agentId))
    .map((a) => ({ ...a, first: firstMessage(a.file) }))
    .filter((a) => a.first && Date.parse(a.first.timestamp) >= startedMs && textOf(a.first.message?.content).includes(brief))
    .sort((a, b) => Date.parse(a.first.timestamp) - Date.parse(b.first.timestamp))[0];
  if (!hit) return null;
  rec.record = { ...rec.record, agentId: hit.agentId };
  atomicWrite(join(root, rec.recordPath), JSON.stringify(rec.record) + "\n");
  return hit;
}

export function inFlight({ root, ledgerPath = join(root, LEDGER_REL), sessionId, env = process.env, now = Date.now() }) {
  const slugDir = sessionSlugDir(sessionId, env);
  const agents = slugDir ? sessionAgents(slugDir, sessionId) : [];
  const records = inFlightRecords(root, ledgerPath, sessionId);
  const claimed = new Set(records.map((r) => r.record.agentId).filter(Boolean));
  const tasks = records.map((rec) => {
    const agent = bindRecord(root, rec, agents, claimed);
    if (agent) claimed.add(agent.agentId);
    return { rec, agent };
  });
  return tasks.map(({ rec, agent }) => {
    const base = {
      kind: "task", task: rec.task, role: rec.role, round: rec.round, retry: rec.retry, recordPath: rec.recordPath,
      agentId: agent?.agentId ?? null, elapsedMs: now - Date.parse(rec.record.startedAt), liveUnknown: 0,
    };
    const t = agent ? readTranscript(agent.file) : null;
    if (!t) {
      // Agents started since this record that no in-flight record binds: any of them could be it.
      const startedMs = Date.parse(rec.record.startedAt);
      const liveUnknown = agents.filter((a) => !claimed.has(a.agentId)).filter((a) => {
        const u = readTranscript(a.file);
        return u && u.firstStamp !== null && u.firstStamp >= startedMs && transcriptState(u, { now, ended: metaFinished(a.file) }) !== "ended";
      }).length;
      return { ...base, state: "unbound", toolUses: 0, sinceActivityMs: null, lastTool: null, liveUnknown };
    }
    const state = transcriptState(t, { now, ended: Boolean(rec.record.endedAt) || metaFinished(agent.file) });
    return {
      ...base, toolUses: t.toolUses, sinceActivityMs: now - t.mtimeMs, lastTool: t.lastTool,
      state: state !== "ended" ? state : outputPresent(root, rec) ? "ended-with-output" : "ended-without-output",
    };
  });
}

const WAIT_ACTIONS = {
  running: () => "wait",
  unbound: () => "wait",
  quiet: (d) => `stop-agent ${d.agentId}`,
  "ended-with-output": (d) => (d.role === "implementer" ? "intake" : "verdict"),
};

// The coordinator's one call: each in-flight dispatch with what to do next. With `record`, a dispatch
// that is dead — ended without its output, unbound past UNBOUND_MS with no unaccounted live agent, or
// quiet and confirmed stopped (`stopped` names its task) — is recorded and routed.
export function dispatchHealth({ root, ledgerPath = join(root, LEDGER_REL), sessionId, env = process.env, now = Date.now(), record = false, stopped = null }) {
  return inFlight({ root, ledgerPath, sessionId, env, now }).map((d) => {
    const dead = d.state === "ended-without-output"
      || (d.state === "quiet" && stopped !== null && d.task === stopped)
      || (d.state === "unbound" && d.elapsedMs >= UNBOUND_MS && d.liveUnknown === 0);
    if (!dead) return { ...d, action: WAIT_ACTIONS[d.state](d), recorded: false };
    if (!record) return { ...d, action: "record", recorded: false };
    const { next } = recordDeath({ ledgerPath, task: d.task, role: d.role, round: d.round, recordPath: d.recordPath });
    return { ...d, action: next, recorded: true };
  });
}

const mins = (ms) => `${Math.floor(Math.max(ms, 0) / 60_000)}m`;

export function formatDispatch(d) {
  const parts = [d.kind === "task" ? `task ${d.task} ${d.role} round ${d.round}` : `progress ${d.id}`, d.state];
  if (d.milestone) parts.push(`${d.milestone.i}/${d.milestone.n} ${d.milestone.text}`);
  parts.push(mins(d.elapsedMs), `${d.toolUses} tools`);
  if (d.sinceActivityMs !== null) parts.push(`idle ${mins(d.sinceActivityMs)}`);
  if (d.lastTool) parts.push(`last ${d.lastTool}`);
  return `${parts.join(" · ")} → ${d.action}${d.recorded ? " (recorded)" : ""}`;
}

// The SubagentStop sensor's merge (hooks/dispatch-sensor.mjs): the stopped agent's record, found by the
// brief its prompt names and this session, the latest one started at or before the agent.
export function markEnded({ root, sessionId, transcriptPath, agentId = null, now = Date.now() }) {
  const first = firstMessage(transcriptPath);
  const match = first && textOf(first.message?.content).match(BRIEF_IN_PROMPT);
  if (!match) return false;
  const [, task, role, roundText = "0"] = match;
  const round = Number(roundText);
  const firstMs = Date.parse(first.timestamp);
  const dir = join(root, ".devcycle/dispatch");
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return false;
  }
  const hit = files
    .filter((f) => f.startsWith(`${task}-${role}-${round}-`) && f.endsWith(".json"))
    .map((f) => ({ f, record: readJson(join(dir, f)) }))
    .filter((x) => x.record?.sessionId === sessionId && Date.parse(x.record.startedAt) <= firstMs)
    .sort((a, b) => Date.parse(b.record.startedAt) - Date.parse(a.record.startedAt))[0];
  if (!hit) return false;
  const rec = { task, role, round, record: hit.record };
  atomicWrite(join(dir, hit.f), JSON.stringify({
    ...hit.record, agentId: hit.record.agentId ?? agentId, endedAt: new Date(now).toISOString(), outputPresent: outputPresent(root, rec),
  }) + "\n");
  return true;
}

const FLAGS = { "--record": "none", "--stopped": "value", "--json": "none", "--ledger": "value" };

if (isMain(import.meta.url, process.argv[1])) {
  try {
    const flags = taskFlags(process.argv.slice(2), FLAGS, []);
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "";
    const root = workTreeRoot(process.cwd());
    const dispatches = sessionId
      ? dispatchHealth({ root, ledgerPath: flags["--ledger"] ?? join(root, LEDGER_REL), sessionId, record: Boolean(flags["--record"]), stopped: flags["--stopped"] ?? null })
      : [];
    if (flags["--json"]) console.log(JSON.stringify({ ok: true, sessionId: sessionId || null, dispatches }));
    else if (!sessionId) console.log("no session id (CLAUDE_CODE_SESSION_ID is unset): nothing to classify");
    else console.log(dispatches.length ? dispatches.map(formatDispatch).join("\n") : "no dispatch in flight");
  } catch (err) {
    console.error(`dispatch-health: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
