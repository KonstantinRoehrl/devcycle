#!/usr/bin/env node
// Judges and resets the execution stage's ledger slot: a ledger, or per-task files with no ledger,
// left by another plan or another run belong to a previous cycle, and are archived before this run
// writes its own. One JSON object on stdout, per scripts/task-ledger.mjs's runTaskScript.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import { field } from "./md-field.mjs";
import { ledgerPlan, runTaskScript, taskFlags } from "./task-ledger.mjs";

// The directories the task scripts and implementer reports write per task, beside the ledger.
export const PER_TASK_DIRS = ["briefs", "dispatch", "evidence", "findings", "reports"];

const LEDGER_RUN_RE = /^Run:\s*`?([0-9a-f]{16})`?\s*$/m;
const LEDGER_BRANCH_RE = /^Branch:\s*`([^`]+)`/m;

const devcycleDir = (root) => join(root, ".devcycle");
const ledgerOf = (root) => join(devcycleDir(root), "ledger.md");

export function ledgerRun(ledgerPath) {
  if (!existsSync(ledgerPath)) return null;
  return readFileSync(ledgerPath, "utf8").match(LEDGER_RUN_RE)?.[1] ?? null;
}

// Every file below dir, relative to it; a missing directory holds none.
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).filter((rel) => statSync(join(dir, rel)).isFile()).sort();
}

// The per-task files, relative to .devcycle/ — the path an archive keeps them under.
const perTaskFiles = (root) => PER_TASK_DIRS.flatMap((d) => filesUnder(join(devcycleDir(root), d)).map((rel) => join(d, rel)));

export function ledgerSlotState({ root, plan, run }) {
  const ledgerPath = ledgerOf(root);
  if (!existsSync(ledgerPath)) return perTaskFiles(root).length > 0 ? "stale" : "fresh";
  // A ledger written before its preamble carried `Run:` is judged by `Plan:` alone.
  const recordedRun = ledgerRun(ledgerPath);
  return ledgerPlan(ledgerPath) !== plan || (recordedRun !== null && recordedRun !== run) ? "stale" : "fresh";
}

const slugOf = (branch) => (branch ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

function archiveDirs(root) {
  const dir = devcycleDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("archive-")).map((e) => join(dir, e.name));
}

function freeArchive(root, today, slug) {
  const base = join(devcycleDir(root), `archive-${today}-${slug}`);
  if (!existsSync(base)) return base;
  for (let n = 2; ; n++) if (!existsSync(`${base}-${n}`)) return `${base}-${n}`;
}

const hasArchivedCopy = (archives, src, rel) => {
  const bytes = readFileSync(src);
  return archives.some((dir) => {
    const copy = join(dir, rel);
    return existsSync(copy) && statSync(copy).isFile() && readFileSync(copy).equals(bytes);
  });
};

export function resetLedgerSlot({ root, today = new Date().toISOString().slice(0, 10) }) {
  const ledgerPath = ledgerOf(root);
  const branch = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").match(LEDGER_BRANCH_RE)?.[1] : null;
  const previous = archiveDirs(root);
  const archive = freeArchive(root, today, slugOf(branch));
  mkdirSync(archive, { recursive: true });
  const moved = [];
  const removed = [];
  for (const rel of [...(existsSync(ledgerPath) ? ["ledger.md"] : []), ...perTaskFiles(root)]) {
    const src = join(devcycleDir(root), rel);
    // Only a copy already archived may go: every other file is moved, so none is ever lost.
    if (hasArchivedCopy(previous, src, rel)) {
      rmSync(src);
      removed.push(relative(root, src));
      continue;
    }
    const dest = join(archive, rel);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    moved.push(relative(root, src));
  }
  return { archive: relative(root, archive), moved, removed };
}

// A state field's value without its annotation (`docs/plan.md (committed)`), or null when unset —
// the reading scripts/wave-setup.mjs gives the same fields.
const recorded = (raw) => {
  const value = (raw ?? "").split(/\s+/)[0];
  return ["", "none", "<tbd>"].includes(value) ? null : value;
};

const FLAGS = { "--state": "value", "--reset": "none" };

function cli(argv) {
  const flags = taskFlags(argv, FLAGS, ["--state"]);
  const statePath = resolve(flags["--state"]);
  let stateText;
  try {
    stateText = readFileSync(statePath, "utf8");
  } catch {
    throw new Error(`cannot read state file: ${statePath}`);
  }
  // The checkout the state file belongs to: the directory holding its .devcycle/.
  const root = dirname(dirname(statePath));
  const slot = ledgerSlotState({ root, plan: recorded(field(stateText, "plan")), run: recorded(field(stateText, "run")) });
  if (flags["--reset"] !== true) return { slot };
  return slot === "stale" ? { slot, reset: true, ...resetLedgerSlot({ root }) } : { slot, reset: false };
}

if (isMain(import.meta.url, process.argv[1])) runTaskScript("ledger-slot", () => cli(process.argv.slice(2)));
