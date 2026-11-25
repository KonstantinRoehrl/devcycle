#!/usr/bin/env node
// The hygiene sweep's deterministic spine. `run` detects the repo's stacks, runs the registry's
// tools that apply (an executing-class mode only on this pass's consent) into scratch, normalizes
// their output through an adapter, runs the built-in scanners, and writes candidate clusters and
// coverage rows. The verification dispatch, not this script, decides what is a finding.
// `references/hygiene-sweeps.json` owns every pin, invocation, kind and severity read here.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.mjs";
import { loadRegistry, sourcedKinds } from "./hygiene-registry.mjs";
import { ADAPTERS } from "./hygiene-adapters.mjs";
import { SCANNERS } from "./hygiene-scanners.mjs";
import { gitToplevel, recordPath, runsDirForRepo, writeLine } from "./run-record.mjs";

const SWEEP = "dead-code";
const READ_CAP_BYTES = 1024 * 1024;
const BLAME_CAP_FILES = 200;
// A binary file cannot name anything textually, so skipping it for size is not a gap in a scan.
const BINARY_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf",
  ".eot", ".mp3", ".mp4", ".webm", ".ogg", ".wav", ".mov", ".pdf", ".zip", ".gz", ".wasm"]);
const git = (repoRoot, args) =>
  spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });

export function detectStacks(files, registry) {
  // A manifest under .github/ declares CI tooling (such as the Claude Code versions Dependabot bumps), not a stack the project is written in.
  const matches = (signal, file) =>
    signal.startsWith("*.") ? extname(file) === signal.slice(1) : basename(file) === signal && !file.startsWith(".github/");
  return Object.entries(registry.stacks)
    .filter(([, s]) => files.some((f) => s.signals.some((sig) => matches(sig, f))))
    .map(([id]) => id);
}

export function selectTools(registry, { stacks, files, consent }) {
  const tracked = new Set(files);
  return registry.tools.filter((t) => t.sweep === SWEEP).map((tool) => {
    const configs = tool.when?.anyFile ? files.filter((f) => tool.when.anyFile.includes(basename(f))) : null;
    const applies = tool.stacks.some((s) => stacks.includes(s)) && (!configs || configs.length > 0);
    if (!applies) return { tool, mode: null, status: "not-applicable" };
    if (configs && !configs.some((f) => !f.includes("/")))
      return { tool, mode: null, status: "unavailable",
        note: `config only at ${configs.slice(0, 3).join(", ")}, not at the repo root; the tool runs from the root only` };
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
  if (r.status !== 0) return { churn, error: firstLine(r.stderr) };
  for (const f of r.stdout.split("\n").filter(Boolean)) churn.set(f, (churn.get(f) ?? 0) + 1);
  return { churn, error: null };
}

const firstLine = (text) => (text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "no output";

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

// `read.scope` collects the text files a caller asked for that were over the read cap, so a scanner
// that could not see them is reported partial.
function makeReader(repoRoot) {
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      let text = null, oversize = false;
      try {
        const p = join(repoRoot, rel);
        if (statSync(p).size <= READ_CAP_BYTES) text = readFileSync(p, "utf8");
        else oversize = !BINARY_EXTS.has(extname(rel).toLowerCase());
        if (text?.includes("\u0000")) text = null;
      } catch { text = null; }
      cache.set(rel, { text, oversize });
    }
    const hit = cache.get(rel);
    if (hit.oversize) read.scope?.add(rel);
    return hit.text;
  };
  read.scope = null;
  return read;
}

function makeBlame(repoRoot) {
  let used = 0;
  const blame = (rel) => {
    if (used >= BLAME_CAP_FILES) { blame.capped = true; blame.skipped += 1; return null; }
    used += 1;
    const r = git(repoRoot, ["blame", "--line-porcelain", "--", rel]);
    if (r.status !== 0) { blame.failed.push(firstLine(r.stderr)); return null; }
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
  blame.skipped = 0;
  blame.failed = [];
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

const substitute = (text, scratch, project = null) => {
  const withScratch = text.replaceAll("{scratch}", scratch);
  return project === null ? withScratch
    : withScratch.replaceAll("{projectSlug}", project.replace(/[^A-Za-z0-9]+/g, "-")).replaceAll("{project}", project);
};

// tsconfig allows comments and trailing commas; both are dropped outside strings before JSON.parse.
function parseJsonc(text) {
  const strip = (src, onToken) => {
    let out = "", i = 0, inString = false;
    while (i < src.length) {
      const ch = src[i];
      if (inString) {
        out += ch;
        if (ch === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
        if (ch === '"') inString = false;
        i += 1; continue;
      }
      const next = onToken(src, i);
      if (next) { out += next.text; i = next.at; continue; }
      if (ch === '"') inString = true;
      out += ch; i += 1;
    }
    return out;
  };
  const noComments = strip(text.replace(/^\uFEFF/, ""), (src, i) => {
    if (src[i] === "/" && src[i + 1] === "/") { const eol = src.indexOf("\n", i); return { text: "", at: eol < 0 ? src.length : eol }; }
    if (src[i] === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); return { text: " ", at: end < 0 ? src.length : end + 2 }; }
    return null;
  });
  return JSON.parse(strip(noComments, (src, i) => (src[i] === "," && /^\s*[}\]]/.test(src.slice(i + 1, i + 200)) ? { text: "", at: i + 1 } : null)));
}

// A solution-style tsconfig (`files: []` plus `references`) checks nothing itself, so each referenced
// project is the thing to check. Returns the projects to run and why the list may be incomplete.
function expandProjects(tool, repoRoot) {
  const { config, cap } = tool.projects;
  const incomplete = [];
  const leaves = [];
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let parsed;
    try { parsed = parseJsonc(readFileSync(join(repoRoot, rel), "utf8")); } catch { parsed = null; }
    const refs = Array.isArray(parsed?.references) ? parsed.references : [];
    const solution = refs.length > 0 && Array.isArray(parsed.files) && parsed.files.length === 0 &&
      !(Array.isArray(parsed.include) && parsed.include.length > 0);
    if (!solution) { leaves.push(rel); return; }
    for (const ref of refs) {
      const target = normalize(join(dirname(rel), String(ref?.path ?? "")));
      const projectFile = target.endsWith(".json") ? target : join(target, "tsconfig.json");
      if (projectFile.startsWith("..") || !existsSync(join(repoRoot, projectFile))) incomplete.push(`${ref?.path}: not found in the repo`);
      else visit(projectFile);
    }
  };
  visit(config);
  const over = Math.max(0, leaves.length - cap);
  if (over) incomplete.push(`${over} referenced projects over the cap of ${cap} not checked`);
  const solutionRoot = seen.size > 1 || leaves[0] !== config;
  return { projects: leaves.slice(0, cap), incomplete, note: solutionRoot ? `solution ${config}: ${Math.min(leaves.length, cap)} referenced projects` : null };
}

function runOneTool({ tool, mode }, { repoRoot, outDir, files, read, dependenciesInstalled, runTool, onPath, anchorFiles }) {
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
  const plan = tool.projects ? expandProjects(tool, repoRoot) : { projects: [null], incomplete: [], note: null };
  if (!plan.projects.length)
    return { row: { ...row, status: "failed", note: [plan.note, ...plan.incomplete].filter(Boolean).join("; ") || "no project to check" }, candidates: [] };
  const runs = plan.projects.flatMap((project) => spec.invocations.map((inv) => {
    const id = project === null ? inv.id : `${inv.id}:${project}`;
    const r = runTool({ argv: [...resolved.argv, ...inv.args.map((a) => substitute(a, scratch, project))], cwd: repoRoot, env });
    const stem = id.replace(/[^A-Za-z0-9.-]+/g, "-");
    writeFileSync(join(scratch, `${stem}.stdout`), r.stdout ?? "");
    writeFileSync(join(scratch, `${stem}.stderr`), r.stderr ?? "");
    return { invocationId: id, ...r };
  }));
  const bad = runs.find((r) => r.error || (tool.okExit && !tool.okExit.includes(r.status)));
  if (bad) {
    const why = bad.error ?? `exit ${bad.status}: ${(bad.stderr ?? "").split("\n").find((l) => l.trim()) ?? "no stderr"}`;
    return { row: { ...row, status: "failed", note: `${bad.invocationId}: ${why}` }, candidates: [] };
  }
  let result;
  try {
    result = adapter.normalize(runs, { tool, mode, repoRoot, files, read, dependenciesInstalled, scratch, anchorFiles });
  } catch (err) {
    return { row: { ...row, status: "failed", note: `adapter error: ${err.message}` }, candidates: [] };
  }
  const missingDeps = tool.needsDependencies && !dependenciesInstalled;
  const notes = [result.note, plan.note, ...plan.incomplete, missingDeps ? "dependencies not installed" : null].filter(Boolean);
  const candidates = result.candidates.map((c) => ({ ...c, source: tool.id, noisy: Boolean(c.noisy || missingDeps) }));
  const status = !result.ok ? "failed" : plan.incomplete.length ? "partial" : "ran";
  return { row: { ...row, status, note: notes.join("; ") || null }, candidates: result.ok ? candidates : [] };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What kept a scanner from seeing everything, or null when it saw it all.
function scannerGap(id, ctx, oversize) {
  const gaps = [];
  if (oversize.size) gaps.push(`${plural(oversize.size, "file", "files")} over 1 MB not scanned (${[...oversize].slice(0, 3).join(", ")})`);
  if (id === "stale-todo") {
    if (ctx.blame.capped) gaps.push(`git blame capped at ${BLAME_CAP_FILES} files; ${plural(ctx.blame.skipped, "file with a TODO was", "files with a TODO were")} not aged`);
    if (ctx.blame.failed.length) gaps.push(`git blame failed for ${plural(ctx.blame.failed.length, "file", "files")}: ${ctx.blame.failed[0]}`);
  }
  return gaps.length ? gaps.join("; ") : null;
}

function runScanners(registry, stacks, ctx) {
  const rows = [], candidates = [];
  for (const [id, def] of Object.entries(registry.scanners).filter(([, d]) => d.sweep === SWEEP)) {
    const row = { source: id, kinds: def.kinds, class: "heuristic", method: "heuristic", downloaded: false, version: null, note: null };
    if (def.stacks && !def.stacks.some((s) => stacks.includes(s))) { rows.push({ ...row, status: "not-applicable" }); continue; }
    const impl = SCANNERS.find((s) => s.id === id);
    if (!impl) { rows.push({ ...row, status: "unavailable", note: "no implementation" }); continue; }
    try {
      ctx.read.scope = new Set();
      const blamed = { failed: ctx.blame.failed.length, skipped: ctx.blame.skipped };
      const found = impl.scan(ctx).map((c) => ({ ...c, source: id }));
      candidates.push(...found);
      const gap = scannerGap(id, { blame: { capped: ctx.blame.capped && ctx.blame.skipped > blamed.skipped, skipped: ctx.blame.skipped - blamed.skipped,
        failed: ctx.blame.failed.slice(blamed.failed) } }, ctx.read.scope);
      rows.push({ ...row, status: gap ? "partial" : "ran", note: gap });
    } catch (err) {
      rows.push({ ...row, status: "failed", note: `scanner error: ${err.message}` });
    } finally {
      ctx.read.scope = null;
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
  if (!files) {
    const listed = git(repoRoot, ["ls-files", "-z"]);
    if (listed.status !== 0) throw new Error(`git ls-files failed in ${repoRoot}: ${listed.error?.message ?? firstLine(listed.stderr)}`);
    files = listed.stdout.split("\0").filter(Boolean);
  }
  const degraded = [];
  if (!churn) {
    const measured = churnByFile(repoRoot);
    churn = measured.churn;
    if (measured.error) degraded.push(`git log failed (${measured.error}); blast radius fell back to the file count`);
  }
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
        version: sel.tool.version, note: sel.status === "needs-consent" ? "executing class: needs this pass's consent" : sel.note ?? null });
      continue;
    }
    const signals = new Set(sel.tool.stacks.flatMap((st) => registry.stacks[st].signals));
    const anchorFiles = files.filter((f) => signals.has(basename(f))).sort((a, b) => a.split("/").length - b.split("/").length);
    const { row, candidates } = runOneTool(sel, { repoRoot, outDir, files, read, dependenciesInstalled, runTool, onPath, anchorFiles });
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
    notCovered: registry.sweeps[SWEEP].notCovered, sweepKinds, sourcedKinds: sourcedKinds(registry, SWEEP), degraded,
    fullKinds: fullKinds(sweepKinds, rows, registry, dependenciesInstalled),
  };
  writeFileSync(join(outDir, "candidates.json"), JSON.stringify({ sweep: SWEEP, candidates, clusters }, null, 2) + "\n");
  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  return { candidates, clusters, coverage };
}

const SEVERITY_ORDER = ["low", "medium", "high", "critical"];
const OUTCOMES = new Set(["verified", "suspected", "cleared"]);
const higher = (a, b) => (SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (err) { throw new Error(`cannot read ${path}: ${err.message}`); }
}

function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

// lcov: `SF:<path>` opens a file record, `DA:<line>,<hits>` counts a line, `end_of_record` closes it.
export function parseLcov(text, repoRoot) {
  const files = new Map();
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      let path = line.slice(3);
      if (path.startsWith(`${repoRoot}/`)) path = path.slice(repoRoot.length + 1);
      current = new Map();
      files.set(path.replace(/^\.\//, ""), current);
    } else if (line.startsWith("DA:") && current) {
      const [ln, hits] = line.slice(3).split(",").map(Number);
      if (Number.isInteger(ln)) current.set(ln, (current.get(ln) ?? 0) + (hits || 0));
    } else if (line === "end_of_record") current = null;
  }
  return files;
}

function isUncovered(lcovFiles, c) {
  const lines = lcovFiles.get(c.file);
  if (!lines || lines.size === 0) return false;
  return c.line === null ? [...lines.values()].every((h) => h === 0) : lines.get(c.line) === 0;
}

// The latest counted pass on this machine that started strictly before `runId`'s: a run file other
// than its own, holding sweep-count rows for `sweep`, ordered by its `run` line's startedAt, then
// file name. Each category maps to its count and whether that pass swept it completely.
export function latestEarlierCounts(repoRoot, runId, sweep = SWEEP) {
  const dir = runsDirForRepo(gitToplevel(repoRoot));
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl") && n !== `${runId}.jsonl`); }
  catch { return null; }
  let best = null;
  const own = readRows(join(dir, `${runId}.jsonl`)).find((r) => r.kind === "run")?.startedAt ?? null;
  for (const name of names) {
    const rows = readRows(join(dir, name));
    const counts = rows.filter((r) => r.kind === "sweep-count" && r.sweep === sweep);
    if (!counts.length) continue;
    const startedAt = rows.find((r) => r.kind === "run")?.startedAt ?? "";
    if (own && startedAt >= own) continue;
    const key = `${startedAt} ${name}`;
    if (!best || key > best.key) best = { key, counts };
  }
  return best && Object.fromEntries(best.counts.map((r) => [r.category, { count: r.verified + r.suspected, complete: r.complete === true }]));
}

function appendCounts(repoRoot, runId, counts) {
  const toplevel = gitToplevel(repoRoot);
  if (readRows(recordPath(toplevel, runId)).some((r) => r.kind === "sweep-count" && r.sweep === counts.sweep))
    return "already-recorded";
  for (const [category, c] of Object.entries(counts.categories))
    writeLine(toplevel, runId, { kind: "sweep-count", runId, sweep: counts.sweep, category, ...c });
  return "appended";
}

function lcovRow(lcovFiles, consent) {
  const base = { source: "coverage-run", kinds: [], class: "executing", method: "tool", downloaded: false, version: "repo-toolchain" };
  if (lcovFiles) return { ...base, ...(lcovFiles.size
    ? { status: "ran", note: `lcov report covers ${lcovFiles.size} files` }
    : { status: "failed", note: "not an lcov report: no SF records" }) };
  return consent?.coverage
    ? { ...base, status: "unavailable", note: "no lcov report was passed" }
    : { ...base, status: "needs-consent", note: "the coverage run needs this pass's consent" };
}

function coverageStatement(coverage, kinds) {
  const ranBy = (kind, methods) => coverage.rows
    .filter((r) => (r.status === "ran" || r.status === "partial") && r.kinds.includes(kind) && methods.includes(r.method))
    .map((r) => (r.status === "partial" ? `${r.source} (partial)` : r.source));
  const lines = Object.keys(kinds).map((k) => {
    const tools = ranBy(k, ["tool", "tool-raw"]);
    const heuristics = ranBy(k, ["heuristic"]);
    const how = [tools.length ? `tool-checked by ${tools.join(", ")}` : null,
      heuristics.length ? `heuristic by ${heuristics.join(", ")}` : null].filter(Boolean).join("; ") || "not checked";
    return `- \`${k}\`: ${how}; ${coverage.fullKinds.includes(k) ? "complete" : "incomplete"}`;
  });
  for (const r of coverage.rows) if (r.status === "partial") lines.push(`- partial: ${r.source} (${r.note})`);
  for (const d of coverage.degraded ?? []) lines.push(`- degraded: ${d}`);
  for (const r of coverage.rows)
    if (r.status !== "ran" && r.status !== "partial" && r.status !== "not-applicable") lines.push(`- not run: ${r.source} (${r.status}${r.note ? `: ${r.note}` : ""})`);
  for (const r of coverage.rows) if (r.downloaded) lines.push(`- downloaded: ${r.source} ${r.version}`);
  for (const s of coverage.noToolStacks) lines.push(`- ${s}: no dead-code tool for this stack; heuristic scan only`);
  lines.push(`- not covered: ${coverage.notCovered.join("; ")}`);
  return lines.join("\n");
}

function outcomeOf(c, v, kindSeverity) {
  const severity = v?.severity ? higher(kindSeverity, v.severity) : kindSeverity;
  if (c.cleared) return { outcome: "cleared", note: c.cleared, severity };
  if (!v) return { outcome: "suspected", note: "not verified: budget", severity };
  if (v.outcome === "verified" && c.noisy) return { outcome: "suspected", note: `${v.note ?? ""} (known-noisy class)`.trim(), severity };
  return { outcome: v.outcome, note: v.note ?? "", severity };
}

export function finalizeSweep({ outDir, verdicts, lcov = null, runId = null, repoRoot, registry = loadRegistry(),
  previousCounts = latestEarlierCounts(repoRoot, runId) }) {
  const { candidates, clusters } = readJson(join(outDir, "candidates.json"));
  const coverage = readJson(join(outDir, "coverage.json"));
  const kinds = registry.sweeps[SWEEP].kinds;
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const verdictById = new Map();
  for (const v of verdicts) {
    const id = v?.candidateId;
    if (!byId.has(id)) throw new Error(`verdict for unknown candidate "${id}"`);
    if (verdictById.has(id)) throw new Error(`two verdicts for "${id}"`);
    if (!OUTCOMES.has(v.outcome)) throw new Error(`invalid outcome "${v.outcome}" for "${id}"`);
    if (v.severity !== undefined && !SEVERITY_ORDER.includes(v.severity)) throw new Error(`invalid severity "${v.severity}" for "${id}"`);
    if (v.outcome === "cleared" && !String(v.note ?? "").trim()) throw new Error(`cleared "${id}" needs its reason as the note`);
    verdictById.set(id, v);
  }
  const lcovFiles = lcov === null ? null : parseLcov(lcov, repoRoot);
  const outcomes = new Map();
  for (const c of candidates) {
    if (!kinds[c.kind]) throw new Error(`candidate kind "${c.kind}" is not a ${SWEEP} kind`);
    const o = outcomeOf(c, verdictById.get(c.id), kinds[c.kind].severity);
    outcomes.set(c.id, { ...o, uncovered: lcovFiles !== null && isUncovered(lcovFiles, c) });
  }

  const categories = Object.fromEntries(Object.keys(kinds).map((k) =>
    [k, { verified: 0, suspected: 0, cleared: 0, complete: coverage.fullKinds.includes(k) }]));
  for (const c of candidates) categories[c.kind][outcomes.get(c.id).outcome] += 1;
  const counts = { sweep: SWEEP, categories };

  const entries = [];
  const blocks = [];
  for (const cl of clusters) {
    const live = cl.candidates.map((id) => byId.get(id)).filter((c) => outcomes.get(c.id).outcome !== "cleared");
    if (!live.length) continue;
    const severity = live.map((c) => outcomes.get(c.id).severity).reduce(higher);
    const confidence = live.some((c) => outcomes.get(c.id).outcome === "verified") ? "verified" : "suspected";
    const title = `${live.length} ${cl.kind} ${live.length === 1 ? "item" : "items"} in ${cl.anchor}`;
    entries.push({ culpritKind: cl.kind, canonicalLocation: cl.anchor, title, severity, confidence,
      affectedFiles: [...new Set(live.map((c) => c.file))].sort() });
    blocks.push(`### ${title}\n\n${severity}, ${confidence}; blast radius ${cl.blastRadius}\n\n` + live.map((c) => {
      const o = outcomes.get(c.id);
      const where = `\`${c.file}${c.line === null ? "" : `:${c.line}`}\`${c.symbol === null ? "" : ` \`${c.symbol}\``}`;
      return `- ${where}: ${o.outcome}${o.note ? ` (${o.note})` : ""}${o.uncovered ? ", uncovered" : ""}`;
    }).join("\n"));
  }

  const reasons = new Map();
  for (const c of candidates) {
    const o = outcomes.get(c.id);
    if (o.outcome === "cleared") reasons.set(o.note, (reasons.get(o.note) ?? 0) + 1);
  }
  const cleared = [...reasons].sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, n]) => `${r} ${n}`).join(", ") || "none";
  coverage.rows = [...coverage.rows.filter((r) => r.source !== "coverage-run"), lcovRow(lcovFiles, coverage.consent)];
  const trending = previousCounts
    ? Object.entries(categories).map(([k, c]) => {
      const before = previousCounts[k] ?? { count: 0, complete: false };
      if (!before.complete) return `${k}: not comparable: earlier pass was incomplete`;
      if (!c.complete) return `${k}: not comparable: this pass was incomplete`;
      return `${k} ${before.count} → ${c.verified + c.suspected}`;
    })
    : ["no earlier counted pass on this machine"];
  const section = ["## Dead code", `Findings: ${entries.length}, in blast-radius order. Cleared: ${cleared}.`, ...blocks,
    "### Coverage", coverageStatement(coverage, kinds), "### Trending", trending.map((t) => `- ${t}`).join("\n")].join("\n\n") + "\n";

  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  writeFileSync(join(outDir, "entries.json"), JSON.stringify(entries, null, 2) + "\n");
  writeFileSync(join(outDir, "counts.json"), JSON.stringify(counts, null, 2) + "\n");
  writeFileSync(join(outDir, "section.md"), section);
  const ratchet = runId === null ? "skipped" : appendCounts(repoRoot, runId, counts);
  return { entries, counts, section, trending, ratchet };
}

const USAGE = "usage: hygiene-sweep.mjs run --out <dir> [--repo <root>] [--consent-executing] [--consent-coverage]\n" +
  "       hygiene-sweep.mjs finalize --dir <dir> --verdicts <file> [--lcov <file>] [--run <runId>] [--repo <root>]";

function mainFinalize(rest) {
  const { flags } = parseFlags(rest, { "--dir": "value", "--verdicts": "value", "--lcov": "value", "--run": "value", "--repo": "value" },
    { requireValues: "nonEmpty" });
  for (const f of ["--dir", "--verdicts"]) if (!flags[f]) throw new Error(`${f} is required; ${USAGE}`);
  const verdicts = readJson(flags["--verdicts"]);
  if (!Array.isArray(verdicts)) throw new Error(`${flags["--verdicts"]} must hold a JSON array of verdicts`);
  let lcov = null;
  if (flags["--lcov"]) {
    try { lcov = readFileSync(flags["--lcov"], "utf8"); }
    catch (err) { throw new Error(`cannot read ${flags["--lcov"]}: ${err.message}`); }
  }
  const { entries, counts, ratchet } = finalizeSweep({ outDir: flags["--dir"], verdicts, lcov, runId: flags["--run"] ?? null,
    repoRoot: resolve(flags["--repo"] ?? process.cwd()) });
  const total = (o) => Object.values(counts.categories).reduce((n, c) => n + c[o], 0);
  process.stdout.write(JSON.stringify({ dir: resolve(flags["--dir"]), entries: entries.length,
    verified: total("verified"), suspected: total("suspected"), cleared: total("cleared"), ratchet }) + "\n");
}

function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "finalize") return mainFinalize(rest);
  if (sub !== "run") throw new Error(USAGE);
  const { flags } = parseFlags(rest, { "--out": "value", "--repo": "value", "--consent-executing": "none", "--consent-coverage": "none" },
    { requireValues: "nonEmpty" });
  if (!flags["--out"]) throw new Error(`--out is required; ${USAGE}`);
  const repoRoot = resolve(flags["--repo"] ?? process.cwd());
  const consent = { executing: Boolean(flags["--consent-executing"]), coverage: Boolean(flags["--consent-coverage"]) };
  const { candidates, clusters, coverage } = runSweep({ repoRoot, outDir: flags["--out"], consent });
  const count = (s) => coverage.rows.filter((r) => r.status === s).length;
  process.stdout.write(JSON.stringify({ out: resolve(flags["--out"]), candidates: candidates.length, clusters: clusters.length,
    ran: count("ran"), partial: count("partial"), failed: count("failed"), unavailable: count("unavailable"), needsConsent: count("needs-consent"),
    fullKinds: coverage.fullKinds }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (err) { process.stderr.write(`hygiene-sweep: ${err.message}\n`); process.exit(1); }
}
