#!/usr/bin/env node
// What a session watching an unattended driver reads: one status report, a stream of the log lines
// worth relaying, or a wait for the run's end. What a run's state means is classifyDrive's alone
// (scripts/drive-result.mjs); this file only reads the log beside it.
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseFlags, requireCount, requireValue } from "./cli-flags.mjs";
import { classifyDrive, LOG_REL } from "./drive-result.mjs";
import { isMain } from "./is-main.mjs";

export const LOG_TAIL_LINES = 40;
// Ample for LOG_TAIL_LINES driver lines; a longer run of raw stderr is cut rather than read whole.
const TAIL_BYTES = 64 * 1024;
const DRIVER_PREFIX = /^\[drive [^\]]*\] /;
const ERROR_PREFIX = "drive-execution: ";
const LEDGER_LINE = /^session \d+ · \d+ tool calls · task=\S+ event=(\S+) outcome=(.*)$/;
const REPORTED_EVENTS = new Set(["committed", "review-verdict", "user-decision"]);
const USAGE = "drive-watch: usage: drive-watch.mjs (--status | --follow [--since <bytes>] | --wait) --state <path>";

const logOf = (statePath) => join(dirname(dirname(resolve(statePath))), LOG_REL);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function logSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// The log's bytes from `start` to its current end; a missing log reads as empty.
function readFrom(path, start) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const bytes = Buffer.alloc(Math.max(fstatSync(fd).size - start, 0));
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, start));
  } finally {
    closeSync(fd);
  }
}

export function reportedLine(rawLine) {
  if (rawLine.startsWith(ERROR_PREFIX)) return rawLine;
  const prefix = rawLine.match(DRIVER_PREFIX);
  if (!prefix) return null;
  const message = rawLine.slice(prefix[0].length);
  const entry = message.match(LEDGER_LINE);
  if (entry) return REPORTED_EVENTS.has(entry[1]) || entry[2].startsWith("rejected (intake bounce)") ? message : null;
  const reported = /^session \d+ starts — /.test(message) || /^wave \d+ of \d+ complete$/.test(message) ||
    message.startsWith("wait: ") || message.startsWith("stopped for you — ");
  return reported ? message : null;
}

function logTail(path) {
  const start = Math.max(logSize(path) - TAIL_BYTES, 0);
  const lines = readFrom(path, start).toString("utf8").split("\n");
  // A read that starts mid-file starts mid-line, and the text after the last newline is "".
  if (start > 0) lines.shift();
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-LOG_TAIL_LINES);
}

const withTail = (run, statePath) => ({ ...run, logTail: logTail(logOf(statePath)) });

export function statusReport({ statePath }) {
  return withTail(classifyDrive({ statePath }), statePath);
}

export async function follow({ statePath, since = null, pollMs = 2000, write = (s) => process.stdout.write(s) }) {
  const path = logOf(statePath);
  let offset = since ?? logSize(path);
  const drain = () => {
    if (logSize(path) < offset) offset = 0;
    const bytes = readFrom(path, offset);
    let start = 0;
    for (let nl = bytes.indexOf(0x0a); nl !== -1; nl = bytes.indexOf(0x0a, start)) {
      const message = reportedLine(bytes.toString("utf8", start, nl));
      start = nl + 1;
      if (message !== null) write(`${message} @${offset + start}\n`);
    }
    // A partial last line stays unread until its newline arrives.
    offset += start;
  };
  for (;;) {
    // Judged before the read: the driver writes its last line before it releases the lock.
    const run = classifyDrive({ statePath });
    drain();
    if (!run.running) {
      write(`drive ended: ${run.outcome ?? "none"} — ${run.reason ?? "none"} → next: ${run.next}\n`);
      return;
    }
    await sleep(pollMs);
  }
}

export async function waitForEnd({ statePath, pollMs = 30_000 }) {
  for (;;) {
    const run = classifyDrive({ statePath });
    if (!run.running) return withTail(run, statePath);
    await sleep(pollMs);
  }
}

const KNOWN_FLAGS = { "--status": "none", "--follow": "none", "--wait": "none", "--since": "value", "--state": "value" };
const MODES = ["--status", "--follow", "--wait"];

function parseArgs(argv) {
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  const modes = MODES.filter((m) => m in flags);
  if (modes.length !== 1) throw new Error("exactly one of --status, --follow or --wait is required");
  const statePath = requireValue(flags, "--state");
  if (!statePath) throw new Error("--state <path to .devcycle/state.md> is required");
  if (!existsSync(statePath)) throw new Error(`no state file at ${statePath}`);
  const since = requireCount(flags, "--since", { min: 0, noun: "a byte offset" });
  if (since !== undefined && modes[0] !== "--follow") throw new Error("--since applies to --follow only");
  return { mode: modes[0], statePath, since: since ?? null };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`drive-watch: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  const { mode, statePath, since } = args;
  const pollMs = Number(process.env.DEVCYCLE_DRIVE_POLL_MS) || undefined;
  if (mode === "--follow") await follow({ statePath, since, pollMs });
  else console.log(JSON.stringify(mode === "--wait" ? await waitForEnd({ statePath, pollMs }) : statusReport({ statePath })));
  return 0;
}

if (isMain(import.meta.url, process.argv[1]))
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
