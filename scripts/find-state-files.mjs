#!/usr/bin/env node
// Reliably enumerates every .devcycle/state.md under the repo root for /devcycle:continue's
// resume discovery. Node-walks the tree with readdirSync, which consults NO gitignore, so the
// RTK shell hook that rewrites find/rg to be gitignore-aware cannot blind it — the failure
// recorded in memory devcycle-state-file-not-found-culprit, where the exact discovery command
// continue.md ran silently dropped the real state file under the gitignored .devcycle/. This
// script only lists; commands/continue.md asks which one to resume and never picks.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { stageEntry, entryLines } from "./stage-entry.mjs";

// Reuses scripts/validate.mjs's walk-prune convention: .git holds no state file and node_modules
// would be slow noise. .devcycle is NEVER pruned — it is exactly what this walk looks for.
const PRUNE = new Set([".git", "node_modules"]);
const LEDGER_EVENT_RE = /^- \[[^\]]+\].*\bevent=/;

export function findStateFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (basename(dir) === ".devcycle") {
      const sf = join(dir, "state.md");
      try {
        if (statSync(sf).isFile()) out.push(sf);
      } catch {
        /* no state.md in this .devcycle dir */
      }
      return; // run scratch holds no nested checkout — stop descending
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions): skip, never abort the whole scan
    }
    for (const e of entries) {
      if (e.isSymbolicLink() || !e.isDirectory()) continue; // don't follow symlinks (cycle safety)
      if (PRUNE.has(e.name)) continue;
      walk(join(dir, e.name));
    }
  };
  walk(root);
  return out.sort();
}

const field = (text, name) => {
  const m = text.match(new RegExp(`^- ${name}:\\s*(.+?)\\s*$`, "m"));
  return m ? m[1] : null;
};

export function describe(statePath) {
  let text = "";
  try {
    text = readFileSync(statePath, "utf8");
  } catch {
    /* unreadable state file: fields stay null */
  }
  const updated = field(text, "updated");
  let ageSeconds = null;
  if (updated) {
    const t = Date.parse(updated);
    if (!Number.isNaN(t)) ageSeconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  }
  let lastEvent = null;
  try {
    const lines = readFileSync(join(dirname(statePath), "ledger.md"), "utf8")
      .split("\n")
      .filter((l) => LEDGER_EVENT_RE.test(l));
    if (lines.length) lastEvent = lines[lines.length - 1].trim();
  } catch {
    /* no sibling ledger: lastEvent stays null */
  }
  return {
    path: statePath,
    root: field(text, "root"),
    request: field(text, "request"),
    branch: field(text, "branch"),
    stage: field(text, "stage"),
    lastEvent,
    updated,
    ageSeconds,
  };
}

function fmtAge(s) {
  if (s == null) return "unknown";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// The same lines resume-check prints, so the candidate list already says where each cycle would
// resume; a stage with no entry says why instead of printing a guess.
function entryFor(stage) {
  try {
    const e = stageEntry(stage);
    return { entry: e.entry, note: e.note, lines: entryLines(e) };
  } catch (err) {
    return { entry: null, note: null, entryError: err.message, lines: [`(no entry — ${err.message})`] };
  }
}

function main(argv) {
  let flags, root;
  try {
    ({ flags } = parseFlags(argv, { "--dir": "value", "--json": "none" }));
    root = requireValue(flags, "--dir"); // throws on a present-but-valueless --dir — same usage error as a bad flag
  } catch (err) {
    console.error(`find-state-files: ${err.message}`);
    console.error("find-state-files: usage: find-state-files.mjs [--dir <root>] [--json]");
    process.exit(1);
  }
  if (!root) {
    const g = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    root = g.status === 0 ? g.stdout.trim() : process.cwd();
  }
  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`find-state-files: root is not a readable directory: ${root}`);
    process.exit(1);
  }

  const records = findStateFiles(root).map(describe);
  if (flags["--json"]) {
    const withEntries = records.map((r) => {
      const { lines, ...e } = entryFor(r.stage);
      return { ...r, ...e };
    });
    process.stdout.write(JSON.stringify(withEntries) + "\n");
    return;
  }
  if (!records.length) {
    console.log("no devcycle state file found in this repo — there is no in-flight cycle to resume");
    return;
  }
  console.log(`${records.length} devcycle state file(s) found:\n`);
  records.forEach((r, i) => {
    console.log(`${i + 1}. ${r.path}`);
    console.log(`   request: ${r.request ?? "(none)"}`);
    console.log(`   branch:  ${r.branch ?? "(none)"}   stage: ${r.stage ?? "(none)"}   age: ${fmtAge(r.ageSeconds)}`);
    console.log(`   last event: ${r.lastEvent ?? "(no ledger events)"}`);
    for (const line of entryFor(r.stage).lines) console.log(`   ${line}`);
    console.log("");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
