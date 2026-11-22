#!/usr/bin/env node
// Bookkeeping for the issue triager, called only from playbooks/triaging-issues.md: where its
// reports live, which roadmap it cross-checks against, and what changed since the last report.
// It spawns no process, so it never reaches GitHub; fetching and verifying stay with
// scripts/issue-intake.mjs and the playbook. The delta is computed from the machine-readable
// `issue-triage-data` block each report ends in, never from the report's prose.
//
//   previous [--config <path>]                       -> JSON { reportDir, roadmap, previous }
//   remember --report-dir <d> --roadmap <path|none> [--config <path>]
//   delta --previous <file> --current <file>         -> Markdown delta sections
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";

const DEFAULT_CONFIG = ".devcycle/issue-triage.json";
const FALLBACK_REPORT_DIR = "docs/audits";
const REPORT_NAME = /^\d{4}-\d{2}-\d{2}-issue-triage\.md$/;
const DATA_BLOCK = /```issue-triage-data\n([\s\S]*?)\n```/g;
const SUBCOMMANDS = "previous | remember | delta";

// The block's parsed JSON, or null when the text has no block, the block is not JSON, or its
// version is not one this script reads. A report carries one block, last, so the last wins.
export function readTriageData(text) {
  const blocks = [...String(text).matchAll(DATA_BLOCK)];
  if (blocks.length === 0) return null;
  try {
    const data = JSON.parse(blocks[blocks.length - 1][1]);
    return data?.version === 1 && Array.isArray(data.issues) ? data : null;
  } catch {
    return null;
  }
}

const byNumber = (a, b) => a.number - b.number;
const section = (name, lines) =>
  `### ${name} (${lines.length})\n${lines.length ? lines.join("\n") : "- none"}\n`;

export function renderDelta(previousName, prev, curr) {
  const before = new Map(prev.issues.map((i) => [i.number, i]));
  const now = new Map(curr.issues.map((i) => [i.number, i]));
  const added = curr.issues.filter((i) => !before.has(i.number)).sort(byNumber);
  const closed = prev.issues.filter((i) => !now.has(i.number)).sort(byNumber);
  const reRanked = curr.issues
    .filter((i) => {
      const p = before.get(i.number);
      return p && (p.impact !== i.impact || p.severity !== i.severity);
    })
    .sort(byNumber);
  const finished = (prev.clusters ?? []).filter(
    (c) => c.issues.length > 0 && c.issues.every((n) => !now.has(n)),
  );
  const nowFixed = curr.issues.filter((i) => i.fixedBy && !before.get(i.number)?.fixedBy).sort(byNumber);
  return [
    `## Delta since ${previousName}\n`,
    section("New", added.map((i) => `- #${i.number} ${i.title}`)),
    section("Closed", closed.map((i) => `- #${i.number} ${i.title}`)),
    section(
      "Re-ranked",
      reRanked.map((i) => {
        const p = before.get(i.number);
        return `- #${i.number} ${i.title}: impact ${p.impact} → ${i.impact}, severity ${p.severity} → ${i.severity}`;
      }),
    ),
    section("Clusters finished", finished.map((c) => `- ${c.id} ${c.title}`)),
    section("Now fixed", nowFixed.map((i) => `- #${i.number} ${i.title} — fixed by ${i.fixedBy}`)),
  ].join("\n");
}

function readConfig(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

function previous(argv) {
  const { flags } = parseFlags(argv, { "--config": "value" });
  const config = readConfig(requireValue(flags, "--config") ?? DEFAULT_CONFIG);
  const reportDir = config.reportDir ?? (isDir(FALLBACK_REPORT_DIR) ? FALLBACK_REPORT_DIR : null);
  let newest = null;
  if (reportDir && isDir(reportDir)) {
    const name = readdirSync(reportDir).filter((f) => REPORT_NAME.test(f)).sort().pop();
    if (name) newest = join(reportDir, name);
  }
  return JSON.stringify({ reportDir, roadmap: config.roadmap ?? null, previous: newest }) + "\n";
}

function remember(argv) {
  const { flags } = parseFlags(argv, { "--report-dir": "value", "--roadmap": "value", "--config": "value" });
  const reportDir = requireValue(flags, "--report-dir", "a directory");
  const roadmap = requireValue(flags, "--roadmap", "a path or none");
  if (reportDir === undefined || roadmap === undefined) throw new Error("remember needs --report-dir and --roadmap");
  const config = requireValue(flags, "--config") ?? DEFAULT_CONFIG;
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ reportDir, roadmap }) + "\n");
  return "";
}

function delta(argv) {
  const { flags } = parseFlags(argv, { "--previous": "value", "--current": "value" });
  const files = ["--previous", "--current"].map((name) => {
    const file = requireValue(flags, name);
    if (file === undefined) throw new Error(`delta needs ${name}`);
    return file;
  });
  const [prev, curr] = files.map((file) => {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      /* an unreadable file reports the same named reason as a missing block */
    }
    const data = readTriageData(text);
    if (!data) throw new Error(`${file} has no readable issue-triage-data block`);
    return data;
  });
  return renderDelta(basename(files[0]), prev, curr);
}

function main(argv) {
  const [verb, ...rest] = argv;
  const verbs = { previous, remember, delta };
  try {
    if (!Object.hasOwn(verbs, verb ?? "")) throw new Error(`unknown subcommand ${verb ?? ""} (${SUBCOMMANDS})`);
    process.stdout.write(verbs[verb](rest));
  } catch (err) {
    process.stderr.write(`issue-triage: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
