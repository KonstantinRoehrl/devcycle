#!/usr/bin/env node
// Fits the planning cost model's per-dispatch parameters (spec §7) from `agent-cost` run-record rows:
// F the startup floor (shared context folded in), t turns, r unique reads, o output tokens, per role.
// The model says every token is written to the cache once and each turn re-reads the context so far,
// growing linearly, so for one dispatch
//   X = inputTokens + cacheWriteTokens = F + r + o
//   Y = cacheReadTokens / turns        = F + (r + o) / 2
// which solves to F = 2Y - X and r = 2(X - Y) - o. A row whose solve goes negative contradicts the
// linear-growth assumption and is counted as a misfit, never clamped into the medians.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "./is-main.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { eachRecord } from "./jsonl.mjs";
import { median } from "./doctor.mjs";

/**
 * One row's parameters, or null when it cannot be fitted: a continuation (its counts are a delta of
 * an agent already fitted), no turns, or a negative solve.
 * @param {{inputTokens: number, cacheWriteTokens: number, cacheReadTokens: number, outputTokens: number, turns: number, continuationOf: number}} row
 * @returns {{F: number, t: number, r: number, o: number}|null}
 */
export function fitRow(row) {
  if (row.continuationOf !== 0 || !(row.turns > 0)) return null;
  const X = row.inputTokens + row.cacheWriteTokens;
  const Y = row.cacheReadTokens / row.turns;
  const F = 2 * Y - X;
  const r = 2 * (X - Y) - row.outputTokens;
  if (F < 0 || r < 0) return null;
  return { F: Math.round(F), t: row.turns, r: Math.round(r), o: row.outputTokens };
}

/** The key a row is fitted under: its planning role, else its agent type. */
export const roleKey = (row) => row.role ?? `agent:${row.agentType}`;

/**
 * Per-role medians over every first-stop `agent-cost` row.
 * @returns {Record<string, {n: number, misfit: number, F: number|null, t: number|null, r: number|null, o: number|null}>}
 */
export function fitRoles(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.kind !== "agent-cost" || row.continuationOf !== 0) continue;
    const g = groups.get(roleKey(row)) ?? { fits: [], misfit: 0 };
    const fit = fitRow(row);
    if (fit) g.fits.push(fit);
    else g.misfit += 1;
    groups.set(roleKey(row), g);
  }
  const out = {};
  for (const [key, { fits, misfit }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const med = (k) => (fits.length ? median(fits.map((f) => f[k])) : null);
    out[key] = { n: fits.length, misfit, F: med("F"), t: med("t"), r: med("r"), o: med("o") };
  }
  return out;
}

/** Every `*.jsonl` record under dir, recursively. */
export function readRows(dir) {
  const rows = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) rows.push(...readRows(p));
    else if (name.endsWith(".jsonl")) eachRecord(p, (r) => { rows.push(r); });
  }
  return rows;
}

const USAGE = "usage: cost-model-fit.mjs --runs <dir> [--json]";

export function main(argv) {
  let flags;
  try { ({ flags } = parseFlags(argv, { "--runs": "value", "--json": "none" })); } catch (err) {
    console.error(`cost-model-fit: ${err.message}\n${USAGE}`);
    return 1;
  }
  const dir = requireValue(flags, "--runs");
  if (!dir) {
    console.error(USAGE);
    return 1;
  }
  let rows;
  try { rows = readRows(dir); } catch (err) {
    console.error(`cost-model-fit: cannot read ${dir}: ${err.message}`);
    return 1;
  }
  const fit = fitRoles(rows);
  if ("--json" in flags) {
    console.log(JSON.stringify(fit));
    return 0;
  }
  const show = (v) => (v === null ? "—" : String(v));
  console.log("| Role | n | Misfit | F | t | r | o |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const [role, f] of Object.entries(fit)) console.log(`| ${role} | ${f.n} | ${f.misfit} | ${show(f.F)} | ${show(f.t)} | ${show(f.r)} | ${show(f.o)} |`);
  if (!Object.keys(fit).length) console.log("no agent-cost rows under " + dir);
  return 0;
}

if (isMain(import.meta.url, process.argv[1])) process.exit(main(process.argv.slice(2)));
