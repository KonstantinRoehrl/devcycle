#!/usr/bin/env node
// Proposes a benchmark corpus from a repo's own past cycles (spec §9.9 "Corpus"): every archived
// execution ledger names its plan and the exact sha its branch was cut from, the plan's Dispatch Map
// gives the planned task count, and the count gives the size. It writes a *proposed* manifest for
// the user to confirm and rename; it never writes the manifest a pass reads.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { gitToplevel } from "./run-record.mjs";
import { parseDispatchMap } from "./task-files.mjs";
import { BENCH_DIR, DEFAULT_TASKS, validateManifest } from "./plan-bench.mjs";

const SPECS_DIR = join("docs", "superpowers", "specs");

/** small up to 4 planned tasks, medium 5-8, large 9 and more. */
export const sizeOf = (tasks) => (tasks <= 4 ? "small" : tasks <= 8 ? "medium" : "large");

/** A ledger's `Plan:` path and the sha its `Branch:` line says the branch was cut from, or null. */
export function parseLedgerHeader(text) {
  const plan = /^Plan:\s*`([^`]+)`/m.exec(text)?.[1];
  const cut = /^Branch:.*\(cut from `?([^`\s,)]+)`? at `?([0-9a-f]{7,40})`?/m.exec(text);
  return plan && cut ? { plan, base: cut[1], cutSha: cut[2] } : null;
}

/** Planned tasks: the task ids of the plan's LAST Dispatch Map (a plan may quote the heading earlier). */
export function dispatchMapTaskCount(planText) {
  const headings = [...planText.matchAll(/^## Dispatch Map\s*$/gm)];
  if (!headings.length) return 0;
  const map = parseDispatchMap(planText.slice(headings.at(-1).index));
  return map ? new Set([...map.values()].flat()).size : 0;
}

/**
 * The spec a plan was written against: the first specs path the plan names, else the newest spec
 * no later than the plan whose name is `<date>-<topic>-design.md` or `<date>-<topic>.md`.
 * @param {string} planRel e.g. docs/superpowers/plans/2026-10-30-devcycle-stop.md
 * @param {string} planText
 * @param {string[]} specNames basenames under docs/superpowers/specs
 * @returns {string|null} the spec's repo-relative path
 */
export function pairSpec(planRel, planText, specNames) {
  const named = /docs\/superpowers\/specs\/[\w.-]+\.md/.exec(planText)?.[0];
  if (named && specNames.includes(basename(named))) return named;
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(basename(planRel));
  if (!m) return null;
  const [, date, topic] = m;
  const match = specNames
    .filter((n) => { const s = /^(\d{4}-\d{2}-\d{2})-(.+?)(-design)?\.md$/.exec(n); return s && s[2] === topic && s[1] <= date; })
    .sort().at(-1);
  return match ? join(SPECS_DIR, match) : null;
}

/**
 * Every past cycle of `repoRoot` that can be replayed, and one pick per size.
 * @returns {{candidates: {id: string, size: string, tasks: number, baseSha: string, plan: string, specPath: string|null}[],
 *   picks: Record<string, string|null>, manifest: {entries: object[]}}}
 */
export function proposeCorpus({ repoRoot }) {
  const devcycleDir = join(repoRoot, ".devcycle");
  const ledgers = existsSync(devcycleDir)
    ? readdirSync(devcycleDir).filter((d) => d.startsWith("archive-")).sort().map((d) => join(devcycleDir, d, "ledger.md"))
    : [];
  const specNames = existsSync(join(repoRoot, SPECS_DIR)) ? readdirSync(join(repoRoot, SPECS_DIR)).filter((n) => n.endsWith(".md")) : [];
  const byPlan = new Map();
  for (const ledger of ledgers) {
    if (!existsSync(ledger)) continue;
    const head = parseLedgerHeader(readFileSync(ledger, "utf8"));
    if (!head || !existsSync(join(repoRoot, head.plan))) continue;
    const planText = readFileSync(join(repoRoot, head.plan), "utf8");
    const tasks = dispatchMapTaskCount(planText);
    if (tasks === 0) continue;
    // A later archive of the same plan (a resumed cycle's "-2" slot) wins: archives sort by date.
    byPlan.set(head.plan, {
      id: basename(head.plan, ".md").replace(/^\d{4}-\d{2}-\d{2}-/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      size: sizeOf(tasks), tasks, baseSha: head.cutSha, plan: head.plan, specPath: pairSpec(head.plan, planText, specNames),
    });
  }
  const candidates = [...byPlan.values()].sort((a, b) => a.tasks - b.tasks || a.plan.localeCompare(b.plan));
  const picks = {};
  for (const size of Object.keys(DEFAULT_TASKS)) {
    const pool = candidates.filter((c) => c.size === size && c.specPath);
    // Nearest the size's default task count; on a tie, the newest plan.
    pool.sort((a, b) => Math.abs(a.tasks - DEFAULT_TASKS[size]) - Math.abs(b.tasks - DEFAULT_TASKS[size]) || b.plan.localeCompare(a.plan));
    picks[size] = pool[0]?.id ?? null;
  }
  const entries = candidates.filter((c) => Object.values(picks).includes(c.id))
    .map((c) => ({ id: c.id, size: c.size, repoPath: repoRoot, baseSha: c.baseSha, specPath: c.specPath, tasks: c.tasks }));
  return { candidates, picks, manifest: { entries } };
}

const USAGE = "usage: plan-bench-corpus.mjs [--repo <dir>] [--out <path>]";

export function main(argv, cwd = process.cwd()) {
  let flags;
  try { ({ flags } = parseFlags(argv, { "--repo": "value", "--out": "value" })); } catch (err) {
    console.error(`plan-bench-corpus: ${err.message}\n${USAGE}`);
    return 1;
  }
  const repoRoot = resolve(requireValue(flags, "--repo") ?? gitToplevel(cwd));
  const out = resolve(requireValue(flags, "--out") ?? join(repoRoot, BENCH_DIR, "manifest.proposed.json"));
  if (out === join(repoRoot, BENCH_DIR, "manifest.json")) {
    console.error("plan-bench-corpus: refusing to write manifest.json — the user confirms a proposal and renames it");
    return 1;
  }
  const { candidates, picks, manifest } = proposeCorpus({ repoRoot });
  const { errors } = validateManifest(manifest);
  if (errors.length) {
    console.error(`plan-bench-corpus: the proposal does not validate:\n${errors.join("\n")}`);
    return 1;
  }
  console.log("| Id | Size | Tasks | Base | Spec | Pick |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const c of candidates)
    console.log(`| ${c.id} | ${c.size} | ${c.tasks} | ${c.baseSha} | ${c.specPath ?? "no spec found"} | ${Object.values(picks).includes(c.id) ? "yes" : ""} |`);
  for (const [size, id] of Object.entries(picks)) if (!id) console.log(`no ${size} candidate with a spec`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`proposed: ${out} (${manifest.entries.length} entries) — confirm it, then rename it to manifest.json`);
  return 0;
}

if (isMain(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
