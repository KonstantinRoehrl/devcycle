// The shared core of the execution stage's task scripts (references/ledger.md § Task scripts):
// keyed, locked ledger appends, once-only run-record rows, the session's depth band, and the CLI
// contract every task script prints through. Idempotency is by key, never by ordering: a line or
// row that already exists is not appended again, so a crash re-run is harmless while the next
// round or retry — a new key — still appends.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { withFileLock } from "./file-lock.mjs";
import { now } from "./stamp.mjs";
import { parseFlags, requireCount } from "./cli-flags.mjs";
import { recordPath, subSchemaFor, validate, validateCulprit, writeLine } from "./run-record.mjs";
import { resolveDepth } from "./depth-probe.mjs";

const SCHEMA_PATH = new URL("../tests/fixtures/run-record.schema.json", import.meta.url);
const LEDGER_LINE_RE = /^- \[([^\]]+)\] task=(\S+) event=(\S+) outcome=(.*?) ref=(\S+)(?: key=(\S+))?$/;

export class UsageError extends Error {}

export function ledgerKey({ task, event, round = 0, retry = 0 }) {
  return `${task}/${event}/${round}/${retry}`;
}

export function parseLedgerLine(line) {
  const m = LEDGER_LINE_RE.exec(line);
  if (!m) return null;
  const [, stamp, task, event, outcome, ref, key = null] = m;
  return { stamp, task, event, outcome, ref, key };
}

const ledgerText = (ledgerPath) => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "");
const ledgerEntries = (ledgerPath) => ledgerText(ledgerPath).split("\n").map(parseLedgerLine).filter(Boolean);

// The retry index a key carries, or — for a line written before keys existed — its position among
// the task's lines for that event, so an upgraded run still counts its earlier dispatches.
const retryOf = (entry, ordinal) => (entry.key ? Number(entry.key.split("/")[3]) : ordinal);

export function nextRetry(ledgerPath, task, event) {
  const lines = ledgerEntries(ledgerPath).filter((e) => e.task === task && e.event === event);
  return lines.length ? Math.max(...lines.map(retryOf)) + 1 : 0;
}

export function retryCount(ledgerPath, task, outcomePrefix) {
  return ledgerEntries(ledgerPath).filter((e) => e.task === task && e.outcome.startsWith(outcomePrefix)).length;
}

// The newest keyed line of a task for one event, with its round and retry read back out of the key.
export function latestKeyed(ledgerPath, task, event, { round } = {}) {
  const keyed = ledgerEntries(ledgerPath)
    .filter((e) => e.task === task && e.event === event && e.key)
    .map((e) => {
      const [, , r, k] = e.key.split("/");
      return { ...e, round: Number(r), retry: Number(k) };
    })
    .filter((e) => round === undefined || e.round === round);
  return keyed.at(-1) ?? null;
}

export function appendLedgerLine(ledgerPath, { task, event, outcome, ref = "none", round = 0, retry = 0 }) {
  if (/[\n\r]/.test(outcome) || !/^\S+$/.test(ref))
    throw new Error(`task-ledger: outcome must be one line and ref one token (task ${task}, event ${event})`);
  if (!existsSync(ledgerPath))
    throw new Error(`task-ledger: no ledger at ${ledgerPath} — the execution stage creates it with its preamble first`);
  const key = ledgerKey({ task, event, round, retry });
  return withFileLock(ledgerPath, () => {
    const text = readFileSync(ledgerPath, "utf8");
    const existing = text.split("\n").find((l) => parseLedgerLine(l)?.key === key);
    if (existing) return { appended: false, line: existing };
    const line = `- [${now()}] task=${task} event=${event} outcome=${outcome} ref=${ref} key=${key}`;
    appendFileSync(ledgerPath, (text === "" || text.endsWith("\n") ? "" : "\n") + line + "\n");
    return { appended: true, line };
  });
}

const recordRows = (path) =>
  (existsSync(path) ? readFileSync(path, "utf8") : "").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return []; // a torn trailing line is normal
    }
  });

export function appendRunRecordOnce({ toplevel, run, kind, fields, matchKeys }) {
  const sub = subSchemaFor(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")), kind);
  if (!sub) throw new Error(`task-ledger: unknown run-record kind "${kind}"`);
  const row = { kind, runId: run, ...fields };
  if (sub.required?.includes("ts") && row.ts === undefined) row.ts = now();
  const errors = [...validate(row, sub), ...validateCulprit(row.culprit)];
  if (errors.length) throw new Error(`task-ledger: ${kind} row rejected — ${errors.join("; ")}`);
  const path = recordPath(toplevel, run);
  mkdirSync(dirname(path), { recursive: true });
  return withFileLock(path, () => {
    if (recordRows(path).some((r) => r.kind === kind && matchKeys.every((k) => r[k] === row[k]))) return { appended: false };
    writeLine(toplevel, run, row);
    return { appended: true };
  });
}

export function depthBandNow(env = process.env, cwd = process.cwd()) {
  try {
    return resolveDepth(env, cwd, {})?.band ?? "unknown";
  } catch {
    return "unknown";
  }
}

// The checkout the cycle runs in — where `.devcycle/` lives. The run record keys on gitToplevel
// instead, which canonicalises a linked worktree to its main checkout.
export function workTreeRoot(cwd = process.cwd()) {
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new Error(`not a git repository: ${cwd}`);
  return top.stdout.trim();
}

// Flags per the task-script contract: parseFlags' refusals and a missing required flag are usage
// errors (exit 2), never environment errors.
export function taskFlags(argv, known, required) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, known));
  } catch (err) {
    throw new UsageError(err.message);
  }
  for (const name of required)
    if (flags[name] === undefined || String(flags[name]).trim() === "") throw new UsageError(`${name} is required`);
  return flags;
}

// A whole-number flag at or above `min`, undefined when absent; a bad value is a usage error.
export function countFlag(flags, name, min) {
  try {
    return requireCount(flags, name, { min });
  } catch (err) {
    throw new UsageError(err.message);
  }
}

const RUN_ID_RE = /^[0-9a-f]{16}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function checkIds({ run, task }) {
  if (!RUN_ID_RE.test(run)) throw new UsageError(`--run must be a 16-hex run id, got "${run}"`);
  if (!TASK_ID_RE.test(task)) throw new UsageError(`--task must be a plan task id, got "${task}"`);
}

// The task-script CLI contract: exactly one JSON object on stdout; exit 0 for every normal outcome,
// 2 for a usage error, 3 for an environment error (no repo, no ledger, an unwritable file).
export function runTaskScript(name, body) {
  let result;
  try {
    result = { ok: true, appended: [], ...body() };
  } catch (err) {
    const usage = err instanceof UsageError;
    process.exitCode = usage ? 2 : 3;
    result = { ok: false, action: usage ? "usage-error" : "environment-error", error: `${name}: ${err.message}`, appended: [] };
  }
  process.stdout.write(JSON.stringify({ ...result, depthBand: depthBandNow() }) + "\n");
}
