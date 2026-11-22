#!/usr/bin/env node
// The hygiene sweep's deterministic spine. `run` detects the repo's stacks, runs the registry's
// tools that apply (an executing-class mode only on this pass's consent) into scratch, normalizes
// their output through an adapter, runs the built-in scanners, and writes candidate clusters and
// coverage rows. The verification dispatch, not this script, decides what is a finding.
// `references/hygiene-sweeps.json` owns every pin, invocation, kind and severity read here.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.mjs";
import { loadRegistry } from "./hygiene-registry.mjs";
import { ADAPTERS } from "./hygiene-adapters.mjs";
import { SCANNERS } from "./hygiene-scanners.mjs";

const SWEEP = "dead-code";
const READ_CAP_BYTES = 1024 * 1024;
const BLAME_CAP_FILES = 200;
const git = (repoRoot, args) =>
  spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });

export function detectStacks(files, registry) {
  const matches = (signal, file) =>
    signal.startsWith("*.") ? extname(file) === signal.slice(1) : basename(file) === signal;
  return Object.entries(registry.stacks)
    .filter(([, s]) => files.some((f) => s.signals.some((sig) => matches(sig, f))))
    .map(([id]) => id);
}

export function selectTools(registry, { stacks, files, consent }) {
  const tracked = new Set(files);
  return registry.tools.filter((t) => t.sweep === SWEEP).map((tool) => {
    const applies = tool.stacks.some((s) => stacks.includes(s)) &&
      (!tool.when?.anyFile || tool.when.anyFile.some((f) => tracked.has(f)));
    if (!applies) return { tool, mode: null, status: "not-applicable" };
    if (consent.executing && tool.modes.executing) return { tool, mode: "executing", status: "run" };
    if (tool.modes.static) return { tool, mode: "static", status: "run" };
    return { tool, mode: "executing", status: "needs-consent" };
  });
}

function onPathDefault(name) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir) return false;
    try { accessSync(join(dir, name), constants.X_OK); return statSync(join(dir, name)).isFile(); }
    catch { return false; }
  });
}

export function resolveCommand(tool, { repoRoot, onPath = onPathDefault }) {
  const { local, path, fetch } = tool.command;
  if (local && existsSync(join(repoRoot, local))) return { argv: [join(repoRoot, local)], downloaded: false };
  if (path && onPath(path)) return { argv: [path], downloaded: false };
  if (fetch && onPath(fetch[0])) return { argv: [...fetch], downloaded: true };
  return null;
}

export function churnByFile(repoRoot) {
  const r = git(repoRoot, ["log", "--since=6 months ago", "-n", "500", "--name-only", "--format="]);
  const churn = new Map();
  if (r.status !== 0) return churn;
  for (const f of r.stdout.split("\n").filter(Boolean)) churn.set(f, (churn.get(f) ?? 0) + 1);
  return churn;
}

export function clusterCandidates(candidates, churn) {
  const byId = new Map();
  for (const c of candidates.filter((x) => !x.cleared)) {
    const anchor = c.line !== null || c.symbol !== null ? c.file : dirname(c.file);
    const clusterId = `${c.kind}:${anchor}`;
    const cl = byId.get(clusterId) ?? { clusterId, kind: c.kind, anchor, files: [], candidates: [], blastRadius: 0 };
    if (!cl.files.includes(c.file)) cl.files.push(c.file);
    cl.candidates.push(c.id);
    byId.set(clusterId, cl);
  }
  const clusters = [...byId.values()];
  for (const cl of clusters) {
    cl.files.sort();
    cl.blastRadius = cl.files.length * (1 + cl.files.reduce((n, f) => n + (churn.get(f) ?? 0), 0));
  }
  return clusters.sort((a, b) => b.blastRadius - a.blastRadius || (a.clusterId < b.clusterId ? -1 : 1));
}

export function defaultRunTool({ argv, cwd, env }) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? r.error.message : null };
}

function makeReader(repoRoot) {
  const cache = new Map();
  return (rel) => {
    if (!cache.has(rel)) {
      let text = null;
      try {
        const p = join(repoRoot, rel);
        if (statSync(p).size <= READ_CAP_BYTES) text = readFileSync(p, "utf8");
        if (text?.includes("\u0000")) text = null;
      } catch { text = null; }
      cache.set(rel, text);
    }
    return cache.get(rel);
  };
}

function makeBlame(repoRoot) {
  let used = 0;
  const blame = (rel) => {
    if (used >= BLAME_CAP_FILES) { blame.capped = true; return null; }
    used += 1;
    const r = git(repoRoot, ["blame", "--line-porcelain", "--", rel]);
    if (r.status !== 0) return [];
    const out = [];
    let line = null;
    for (const l of r.stdout.split("\n")) {
      const head = /^[0-9a-f]{40} \d+ (\d+)/.exec(l);
      if (head) line = Number(head[1]);
      const t = /^committer-time (\d+)$/.exec(l);
      if (t && line !== null) out.push({ line, time: Number(t[1]) * 1000 });
    }
    return out;
  };
  return blame;
}

function sweepConfig(repoRoot, registry) {
  const fallback = { staleTodoDays: registry.config.staleTodoDays, source: "registry" };
  const file = join(repoRoot, registry.config.configFile);
  if (!existsSync(file)) return fallback;
  try {
    const days = JSON.parse(readFileSync(file, "utf8")).staleTodoDays;
    if (Number.isInteger(days) && days > 0) return { staleTodoDays: days, source: registry.config.configFile };
  } catch { /* an unreadable override falls back below, and the source says so */ }
  return { ...fallback, source: `registry (invalid ${registry.config.configFile} ignored)` };
}

const substitute = (text, scratch) => text.replaceAll("{scratch}", scratch);

function runOneTool({ tool, mode }, { repoRoot, outDir, files, read, dependenciesInstalled, runTool, onPath }) {
  const row = { source: tool.id, kinds: tool.kinds, class: mode, method: tool.adapter === "raw" ? "tool-raw" : "tool",
    downloaded: false, version: tool.version, note: null };
  const resolved = resolveCommand(tool, { repoRoot, onPath });
  if (!resolved) {
    const forms = Object.keys(tool.command).filter((k) => k !== "versionArgs").join(", ");
    return { row: { ...row, status: "unavailable", note: `not found (tried ${forms})` }, candidates: [] };
  }
  row.downloaded = resolved.downloaded;
  const adapter = ADAPTERS[tool.adapter];
  if (!adapter) return { row: { ...row, status: "failed", note: `no adapter "${tool.adapter}"` }, candidates: [] };
  const scratch = join(outDir, "tools", tool.id);
  mkdirSync(scratch, { recursive: true });
  const spec = tool.modes[mode];
  for (const [name, value] of Object.entries(spec.files ?? {}))
    writeFileSync(join(scratch, name), substitute(typeof value === "string" ? value : JSON.stringify(value, null, 2), scratch));
  const env = { ...process.env, ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, substitute(v, scratch)])) };
  if (!resolved.downloaded && tool.command.versionArgs) {
    const v = runTool({ argv: [...resolved.argv, ...tool.command.versionArgs], cwd: repoRoot, env });
    const first = v.status === 0 ? v.stdout.split("\n").find((l) => l.trim()) : null;
    if (first) row.version = first.trim();
  }
  const runs = spec.invocations.map((inv) => {
    const r = runTool({ argv: [...resolved.argv, ...inv.args.map((a) => substitute(a, scratch))], cwd: repoRoot, env });
    writeFileSync(join(scratch, `${inv.id}.stdout`), r.stdout ?? "");
    writeFileSync(join(scratch, `${inv.id}.stderr`), r.stderr ?? "");
    return { invocationId: inv.id, ...r };
  });
  const bad = runs.find((r) => r.error || (tool.okExit && !tool.okExit.includes(r.status)));
  if (bad) {
    const why = bad.error ?? `exit ${bad.status}: ${(bad.stderr ?? "").split("\n").find((l) => l.trim()) ?? "no stderr"}`;
    return { row: { ...row, status: "failed", note: `${bad.invocationId}: ${why}` }, candidates: [] };
  }
  let result;
  try {
    result = adapter.normalize(runs, { tool, mode, repoRoot, files, read, dependenciesInstalled, scratch });
  } catch (err) {
    return { row: { ...row, status: "failed", note: `adapter error: ${err.message}` }, candidates: [] };
  }
  const missingDeps = tool.needsDependencies && !dependenciesInstalled;
  const notes = [result.note, missingDeps ? "dependencies not installed" : null].filter(Boolean);
  const candidates = result.candidates.map((c) => ({ ...c, source: tool.id, noisy: Boolean(c.noisy || missingDeps) }));
  return { row: { ...row, status: result.ok ? "ran" : "failed", note: notes.join("; ") || null }, candidates: result.ok ? candidates : [] };
}

function runScanners(registry, stacks, ctx) {
  const rows = [], candidates = [];
  for (const [id, def] of Object.entries(registry.scanners).filter(([, d]) => d.sweep === SWEEP)) {
    const row = { source: id, kinds: def.kinds, class: "heuristic", method: "heuristic", downloaded: false, version: null, note: null };
    if (def.stacks && !def.stacks.some((s) => stacks.includes(s))) { rows.push({ ...row, status: "not-applicable" }); continue; }
    const impl = SCANNERS.find((s) => s.id === id);
    if (!impl) { rows.push({ ...row, status: "unavailable", note: "no implementation" }); continue; }
    try {
      const found = impl.scan(ctx).map((c) => ({ ...c, source: id }));
      candidates.push(...found);
      rows.push({ ...row, status: "ran", note: id === "stale-todo" && ctx.blame.capped ? `git blame capped at ${BLAME_CAP_FILES} files` : null });
    } catch (err) {
      rows.push({ ...row, status: "failed", note: `scanner error: ${err.message}` });
    }
  }
  return { rows, candidates };
}

function fullKinds(sweepKinds, rows, registry, dependenciesInstalled) {
  const tools = new Map(registry.tools.map((t) => [t.id, t]));
  return sweepKinds.filter((kind) => {
    const sources = rows.filter((r) => r.status !== "not-applicable" && r.kinds.includes(kind));
    return sources.length > 0 && sources.every((r) =>
      r.status === "ran" && !(tools.get(r.source)?.needsDependencies && !dependenciesInstalled));
  });
}

export function runSweep({ repoRoot, outDir, consent = { executing: false, coverage: false }, registry = loadRegistry(),
  runTool = defaultRunTool, files, churn, now = Date.now(), onPath = onPathDefault }) {
  outDir = resolve(outDir);
  mkdirSync(outDir, { recursive: true });
  files ??= git(repoRoot, ["ls-files", "-z"]).stdout?.split("\0").filter(Boolean) ?? [];
  churn ??= churnByFile(repoRoot);
  const stacks = detectStacks(files, registry);
  const dependenciesInstalled = existsSync(join(repoRoot, "node_modules"));
  const read = makeReader(repoRoot);
  const config = sweepConfig(repoRoot, registry);
  const rows = [];
  const raw = [];
  for (const sel of selectTools(registry, { stacks, files, consent })) {
    if (sel.status !== "run") {
      rows.push({ source: sel.tool.id, kinds: sel.tool.kinds, class: sel.mode ?? Object.keys(sel.tool.modes)[0],
        status: sel.status, method: sel.tool.adapter === "raw" ? "tool-raw" : "tool", downloaded: false,
        version: sel.tool.version, note: sel.status === "needs-consent" ? "executing class: needs this pass's consent" : null });
      continue;
    }
    const { row, candidates } = runOneTool(sel, { repoRoot, outDir, files, read, dependenciesInstalled, runTool, onPath });
    rows.push(row);
    raw.push(...candidates);
  }
  const scanned = runScanners(registry, stacks, { repoRoot, files, read, blame: makeBlame(repoRoot), now, config });
  rows.push(...scanned.rows);
  raw.push(...scanned.candidates);
  const seen = new Set();
  const candidates = [];
  for (const c of raw) {
    const cand = { sweep: SWEEP, line: null, symbol: null, noisy: false, cleared: null, ...c };
    cand.id = `${cand.source}:${cand.file}:${cand.line ?? 0}:${cand.symbol ?? ""}`;
    if (!seen.has(cand.id)) { seen.add(cand.id); candidates.push(cand); }
  }
  const clusters = clusterCandidates(candidates, churn);
  const sweepKinds = Object.keys(registry.sweeps[SWEEP].kinds);
  const toolStacks = new Set(registry.tools.filter((t) => t.sweep === SWEEP).flatMap((t) => t.stacks));
  const coverage = {
    sweep: SWEEP, stacks, dependenciesInstalled, consent, config, rows,
    noToolStacks: stacks.filter((s) => !toolStacks.has(s)),
    notCovered: registry.sweeps[SWEEP].notCovered, sweepKinds,
    fullKinds: fullKinds(sweepKinds, rows, registry, dependenciesInstalled),
  };
  writeFileSync(join(outDir, "candidates.json"), JSON.stringify({ sweep: SWEEP, candidates, clusters }, null, 2) + "\n");
  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  return { candidates, clusters, coverage };
}

const USAGE = "usage: hygiene-sweep.mjs run --out <dir> [--repo <root>] [--consent-executing] [--consent-coverage]";

function main(argv) {
  const [sub, ...rest] = argv;
  if (sub !== "run") throw new Error(USAGE);
  const { flags } = parseFlags(rest, { "--out": "value", "--repo": "value", "--consent-executing": "none", "--consent-coverage": "none" },
    { requireValues: "nonEmpty" });
  if (!flags["--out"]) throw new Error(`--out is required; ${USAGE}`);
  const repoRoot = resolve(flags["--repo"] ?? process.cwd());
  const consent = { executing: Boolean(flags["--consent-executing"]), coverage: Boolean(flags["--consent-coverage"]) };
  const { candidates, clusters, coverage } = runSweep({ repoRoot, outDir: flags["--out"], consent });
  const count = (s) => coverage.rows.filter((r) => r.status === s).length;
  process.stdout.write(JSON.stringify({ out: resolve(flags["--out"]), candidates: candidates.length, clusters: clusters.length,
    ran: count("ran"), failed: count("failed"), unavailable: count("unavailable"), needsConsent: count("needs-consent"),
    fullKinds: coverage.fullKinds }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (err) { process.stderr.write(`hygiene-sweep: ${err.message}\n`); process.exit(1); }
}
