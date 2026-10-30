#!/usr/bin/env node
// The state file's readiness row (references/resume.md § The state file): `- handoff: pending <stamp>`
// while a session works a stage, `- handoff: ready <stamp>` once its boundary completed; a cycle with
// no row reads as ready. It rewrites that one row only, and owns the row edit scripts/stop-cycle.mjs
// uses for its `stopped:` row. A ready mark also prints the notifications the cycle's handoffNotification
// knob asks for;
// references/handoff.md owns when each mark runs.
import { readFileSync } from "node:fs";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { ROSTER, parseRecordedLine } from "./resolve-knobs.mjs";
import { now } from "./stamp.mjs";

export const HANDOFF_STATES = ["pending", "ready"];
export const ACTIONS = ["clear", "fresh", "continue", "started", "stopped"];
const NOTIFY_KNOB = ROSTER.find(({ key }) => key === "handoffNotification");
const CHANNELS = { off: [], terminal: ["terminal"], push: ["push"], both: ["terminal", "push"] };
const ANY_ROW = /^- [a-z][a-z-]*:.*$/gm;

export function parseHandoff(value) {
  const m = /^(pending|ready)(?:\s+(\S+))?/.exec(value ?? "");
  return m ? { state: m[1], stamp: m[2] ?? null } : { state: "ready", stamp: null };
}

// Replaced in place when present, else added after the file's last `- key: value` row.
export function withStateRow(text, key, value) {
  const row = `- ${key}: ${value}`;
  const existing = new RegExp(`^- ${key}:.*$`, "m");
  if (existing.test(text)) return text.replace(existing, () => row);
  const last = [...text.matchAll(ANY_ROW)].at(-1);
  const end = last ? last.index + last[0].length : text.length;
  // The row it extends decides the ending, so one stray CRLF in a body line cannot change the file's style.
  const eol = /^\r?\n/.exec(text.slice(end))?.[0] ?? /\r?\n/.exec(text)?.[0] ?? "\n";
  if (!last) return `${text}${text === "" || text.endsWith("\n") ? "" : eol}${row}${eol}`;
  return `${text.slice(0, end)}${eol}${row}${text.slice(end)}`;
}

export const withoutStateRow = (text, key) => text.replace(new RegExp(`^- ${key}:.*(?:\\r?\\n|$)`, "m"), "");

export const withHandoffRow = (text, state, stamp) => withStateRow(text, "handoff", `${state} ${stamp}`);

// A Continue boundary and a started driver leave the user nothing to come back for.
export function notifyLines({ knob, action, completed, reason }) {
  const message =
    action === "clear" ? `devcycle: ${completed} done — safe to /clear + /devcycle:continue`
    : action === "fresh" ? `devcycle: ${completed} done — safe to start a fresh session and run /devcycle:continue`
    : action === "stopped" ? `devcycle: unattended run stopped${reason ? ` — ${reason}` : ""}, needs you`
    : null;
  return message ? (CHANNELS[knob] ?? []).map((channel) => `notify: ${channel} ${message}`) : [];
}

// A knobs: line that predates the knob, or carries a value it does not know, keeps the fallback.
export function notificationKnob(stateText) {
  const value = parseRecordedLine(field(stateText, "knobs") ?? "").handoffNotification;
  return NOTIFY_KNOB.values.includes(value) ? value : NOTIFY_KNOB.fallback;
}

// The driver owns a driven session's liveness and restarts it itself, so the mark stays out of its way.
export function markHandoff({ statePath, state, action = null, completed = null, reason = null, env = process.env }) {
  if (env.DEVCYCLE_DRIVE_TOKEN) return { written: false, lines: ["handoff: unchanged — a driven session never marks the handoff"] };
  const text = readFileSync(statePath, "utf8");
  const stamp = now();
  atomicWrite(statePath, withHandoffRow(text, state, stamp));
  const notices = state === "ready" ? notifyLines({ knob: notificationKnob(text), action, completed, reason }) : [];
  return { written: true, lines: [`handoff: ${state} ${stamp}`, ...notices] };
}

const FLAGS = { "--state": "value", "--pending": "none", "--ready": "none", "--action": "value", "--completed": "value", "--reason": "value" };
const USAGE = `usage: handoff-mark.mjs --state <path> (--pending | --ready --action ${ACTIONS.join("|")} [--completed <label>] [--reason <text>])`;

export function cli(argv, env = process.env) {
  const { flags } = parseFlags(argv, FLAGS);
  const statePath = requireValue(flags, "--state");
  if (!statePath) throw new Error("--state is required");
  const pending = flags["--pending"] === true;
  if (pending === (flags["--ready"] === true)) throw new Error("pass exactly one of --pending and --ready");
  const action = requireValue(flags, "--action", "an action");
  const completed = requireValue(flags, "--completed", "a label");
  // A --stop from another terminal ends the run with no detail, and the stop still has to notify.
  const reason = action === "stopped" && !flags["--reason"]?.trim() ? null : requireValue(flags, "--reason", "a reason");
  if (pending && (action || completed || reason)) throw new Error("--pending takes no --action, --completed or --reason");
  if (!pending && !ACTIONS.includes(action)) throw new Error(`--ready needs --action, one of ${ACTIONS.join(", ")}`);
  if ((action === "clear" || action === "fresh") && !completed) throw new Error(`--action ${action} needs --completed <what just finished>`);
  for (const [name, value] of [["--completed", completed], ["--reason", reason]])
    if (value && /[\r\n]/.test(value)) throw new Error(`${name} must be one line`);
  return markHandoff({ statePath, state: pending ? "pending" : "ready", action, completed, reason, env });
}

if (isMain(import.meta.url, process.argv[1])) {
  try {
    for (const line of cli(process.argv.slice(2)).lines) console.log(line);
  } catch (err) {
    console.error(`handoff-mark: ${err.message}`);
    console.error(`handoff-mark: ${USAGE}`);
    process.exit(1);
  }
}
