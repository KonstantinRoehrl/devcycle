#!/usr/bin/env node
// The hygiene sweep's deterministic spine. `run` covers every registered sweep in one pass: it
// detects the repo's stacks, runs the registry's tools that apply (an executing-class mode only on
// this pass's consent) into scratch, normalizes their output through an adapter, runs the built-in
// scanners, and writes candidate clusters, coverage rows and the inputs of judgment-routed kinds.
// The verification dispatch, not this script, decides what is a finding. `finalize` folds that
// dispatch's verdicts (verification-routed kinds) and the judgment dispatch's judgments
// (judgment-routed kinds) into one section, entry list and count set per sweep.
// `references/hygiene-sweeps.json` owns every pin, invocation, kind and severity read here.
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./cli-flags.mjs";
import { kindIndex, loadRegistry, sourcedKinds } from "./hygiene-registry.mjs";
import { ADAPTERS } from "./hygiene-adapters.mjs";
import { SCANNERS } from "./hygiene-scanners.mjs";
import { readMaintenanceFindings } from "./maintenance-findings.mjs";
import { gitToplevel, recordPath, runsDirForRepo, writeLine } from "./run-record.mjs";

// The sweep an lcov report is evidence for: it shows which dead-code candidates no test reaches.
const LCOV_SWEEP = "dead-code";
const READ_CAP_BYTES = 1024 * 1024;
const HEAD_BYTES = 8 * 1024;
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

export function selectTools(registry, { stacks, files, consent, rootPackage = null }) {
  const declared = new Set([...Object.keys(rootPackage?.dependencies ?? {}), ...Object.keys(rootPackage?.devDependencies ?? {})]);
  return registry.tools.map((tool) => {
    const configs = tool.when?.anyFile ? files.filter((f) => tool.when.anyFile.includes(basename(f))) : null;
    const needed = tool.when?.packageDependency;
    const applies = tool.stacks.some((s) => stacks.includes(s)) && (!configs || configs.length > 0) &&
      (!needed || needed.some((name) => declared.has(name)));
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

// The one statement of the churn window: commits per file, and lines changed per file, are both counted inside it.
export const CHURN_WINDOW = ["--since=6 months ago", "-n", "500"];

export function churnByFile(repoRoot) {
  const r = git(repoRoot, ["log", ...CHURN_WINDOW, "--no-renames", "--numstat", "--format=%x1e"]);
  const churn = new Map(), lines = new Map();
  if (r.status !== 0) return { churn, lines, commits: [], error: firstLine(r.stderr) };
  const commits = [];
  for (const part of r.stdout.split("\x1e")) {
    const touched = [];
    for (const row of part.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
      if (!m) continue;
      const [, added, deleted, file] = m;
      churn.set(file, (churn.get(file) ?? 0) + 1);
      lines.set(file, (lines.get(file) ?? 0) + (added === "-" ? 0 : Number(added)) + (deleted === "-" ? 0 : Number(deleted)));
      touched.push(file);
    }
    if (touched.length) commits.push(touched);
  }
  return { churn, lines, commits, error: null };
}

const firstLine = (text) => (text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "no output";

// A candidate with a `clusterKey` joins the cluster of every candidate sharing it and names that cluster's anchor.
// A cluster weighs the sum of its members' numeric `score` when any member has one, else its file count.
export function clusterCandidates(candidates, churn, commits = []) {
  const byId = new Map();
  const scores = new Map();
  for (const c of candidates.filter((x) => !x.cleared)) {
    const keyed = c.clusterKey !== undefined;
    const anchor = keyed ? c.anchor : c.line !== null || c.symbol !== null ? c.file : dirname(c.file);
    const clusterId = `${c.kind}:${keyed ? c.clusterKey : anchor}`;
    const cl = byId.get(clusterId) ?? { clusterId, sweep: c.sweep, kind: c.kind, anchor, files: [], candidates: [], blastRadius: 0, coChange: 0 };
    if (!cl.files.includes(c.file)) cl.files.push(c.file);
    cl.candidates.push(c.id);
    if (typeof c.score === "number") scores.set(clusterId, (scores.get(clusterId) ?? 0) + c.score);
    byId.set(clusterId, cl);
  }
  const clusters = [...byId.values()];
  const commitSets = commits.map((list) => new Set(list));
  for (const cl of clusters) {
    cl.files.sort();
    cl.blastRadius = (scores.get(cl.clusterId) ?? cl.files.length) * (1 + cl.files.reduce((n, f) => n + (churn.get(f) ?? 0), 0));
    if (cl.files.length > 1) cl.coChange = commitSets.filter((set) => cl.files.filter((f) => set.has(f)).length >= 2).length;
  }
  return clusters.sort((a, b) => b.blastRadius - a.blastRadius || (a.clusterId < b.clusterId ? -1 : 1));
}

// Verification-routed clusters dealt one per sweep in turn, so a long sweep cannot starve the others
// of the verification budget; judgment-routed clusters follow, in incoming order. A watch-routed
// cluster is never verified or judged, so it is never returned.
export function orderForVerification(clusters, sweepOrder) {
  const verification = clusters.filter((c) => (c.route ?? "verification") === "verification");
  const order = [...new Set([...sweepOrder, ...verification.map((c) => c.sweep)])];
  const queues = order.map((sweep) => verification.filter((c) => c.sweep === sweep));
  const ordered = [];
  for (let round = 0; queues.some((q) => round < q.length); round += 1)
    for (const q of queues) if (round < q.length) ordered.push(q[round]);
  return [...ordered, ...clusters.filter((c) => c.route === "judgment")];
}

export function defaultRunTool({ argv, cwd, env }) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd, env, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"],
    timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? r.error.message : null };
}

// `read.scope` collects the text files a caller asked for that were over the read cap, so a scanner
// that could not see them is reported partial. `read.head(rel)` is the text a header-marker check
// needs: the whole file, or the first HEAD_BYTES of an oversize one; it never joins the scope.
// `read.oversize(rel)` says whether `read` withheld the file for its size.
function makeReader(repoRoot) {
  const cache = new Map();
  const load = (rel) => {
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
    return cache.get(rel);
  };
  const read = (rel) => {
    const hit = load(rel);
    if (hit.oversize) read.scope?.add(rel);
    return hit.text;
  };
  read.scope = null;
  read.oversize = (rel) => load(rel).oversize;
  read.head = (rel) => {
    const hit = load(rel);
    if (!hit.oversize) return hit.text;
    let fd;
    try {
      fd = openSync(join(repoRoot, rel), "r");
      const buffer = Buffer.alloc(HEAD_BYTES);
      const head = buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
      return head.includes("\u0000") ? null : head;
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  };
  return read;
}

function makeBlame(repoRoot, cap) {
  let used = 0;
  const blame = (rel) => {
    if (used >= cap) { blame.capped = true; blame.skipped += 1; return null; }
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

const CONFIG_KEYS = ["staleTodoDays", "hotCommits"];

// A key the repo's config file overrides with a positive integer wins; each key is judged on its own, and the source says
// whether the file was absent, wholly honoured or partly ignored.
function sweepConfig(repoRoot, registry) {
  const base = Object.fromEntries(CONFIG_KEYS.map((k) => [k, registry.config[k]]));
  const file = join(repoRoot, registry.config.configFile);
  if (!existsSync(file)) return { ...base, source: "registry" };
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { /* an unreadable override is ignored below, and the source says so */ }
  const given = CONFIG_KEYS.filter((k) => parsed !== null && typeof parsed === "object" && k in parsed);
  const valid = given.filter((k) => Number.isInteger(parsed[k]) && parsed[k] > 0);
  const supplied = { ...base, ...Object.fromEntries(valid.map((k) => [k, parsed[k]])) };
  const honoured = valid.length > 0 && valid.length === given.length;
  return { ...supplied, source: honoured ? registry.config.configFile : `registry (invalid ${registry.config.configFile} ignored)` };
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

function runOneTool({ tool, mode }, { repoRoot, outDir, files, read, dependenciesInstalled, runTool, onPath, anchorFiles, churn, lines, config, registry, stacks, adapters }) {
  const row = { source: tool.id, sweep: tool.sweep, kinds: tool.kinds, class: mode, method: tool.adapter === "raw" ? "tool-raw" : "tool",
    downloaded: false, version: tool.version, note: null };
  const resolved = resolveCommand(tool, { repoRoot, onPath });
  if (!resolved) {
    const forms = Object.keys(tool.command).filter((k) => k !== "versionArgs").join(", ");
    return { row: { ...row, status: "unavailable", note: `not found (tried ${forms})` }, candidates: [] };
  }
  row.downloaded = resolved.downloaded;
  const adapter = adapters[tool.adapter];
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
    result = adapter.normalize(runs, { tool, mode, repoRoot, files, read, dependenciesInstalled, scratch, anchorFiles, churn, lines, config, registry, stacks });
  } catch (err) {
    return { row: { ...row, status: "failed", note: `adapter error: ${err.message}` }, candidates: [] };
  }
  const missingDeps = tool.needsDependencies && !dependenciesInstalled;
  const rowNotes = [result.note, plan.note, ...plan.incomplete, missingDeps ? "dependencies not installed" : null].filter(Boolean);
  const candidates = result.candidates.map((c) => ({ ...c, source: tool.id, sweep: tool.sweep, noisy: Boolean(c.noisy || missingDeps) }));
  const status = !result.ok ? "failed" : plan.incomplete.length ? "partial" : "ran";
  return { row: { ...row, status, note: rowNotes.join("; ") || null }, candidates: result.ok ? candidates : [],
    notes: result.ok ? (result.coverage ?? []).map((entry) => `${tool.id}: ${entry}`) : [] };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What kept a scanner from seeing everything, or null when it saw it all.
function scannerGap(impl, blame, oversize, blameCap) {
  const gaps = [];
  if (oversize.size) gaps.push(`${plural(oversize.size, "file", "files")} over 1 MB not scanned (${[...oversize].slice(0, 3).join(", ")})`);
  const [one, many] = impl.blameUnit ?? ["file was", "files were"];
  if (blame.capped) gaps.push(`git blame capped at ${blameCap} files; ${plural(blame.skipped, one, many)} not aged`);
  if (blame.failed.length) gaps.push(`git blame failed for ${plural(blame.failed.length, "file", "files")}: ${blame.failed[0]}`);
  return gaps.length ? gaps.join("; ") : null;
}

// The files a hotspot-scoped scanner sees: the step 3 list when one was passed, else the most-churned files.
function pickHotspots({ list, files, churn, cap }) {
  const tracked = new Set(files);
  if (list) return { source: "list", files: [...new Set(list)].filter((f) => tracked.has(f)) };
  const ranked = [...churn].filter(([f, n]) => n > 0 && tracked.has(f)).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  return { source: "churn", files: ranked.slice(0, cap).map(([f]) => f) };
}

function runScanners(registry, stacks, ctx, { scanners, hotspots, blameCap }) {
  const rows = [], candidates = [], material = [];
  const blames = new Map(Object.keys(registry.sweeps).map((sweep) => [sweep, makeBlame(ctx.repoRoot, blameCap)]));
  const hotspotNote = hotspots.source === "list" ? `${hotspots.files.length} from the step 3 list`
    : `the ${hotspots.files.length} highest-churn files (no --hotspots list)`;
  for (const [id, def] of Object.entries(registry.scanners)) {
    const row = { source: id, sweep: def.sweep, kinds: def.kinds, class: "heuristic", method: "heuristic", downloaded: false, version: null, note: null,
      ...(def.scope ? { scope: def.scope } : {}) };
    if (def.stacks && !def.stacks.some((s) => stacks.includes(s))) { rows.push({ ...row, status: "not-applicable" }); continue; }
    const impl = scanners.find((s) => s.id === id);
    if (!impl) { rows.push({ ...row, status: "unavailable", note: "no implementation" }); continue; }
    const blame = blames.get(def.sweep);
    const scanCtx = { ...ctx, blame, files: def.scope === "hotspots" ? hotspots.files : ctx.files };
    try {
      ctx.read.scope = new Set();
      const blamed = { failed: blame.failed.length, skipped: blame.skipped };
      const found = impl.scan(scanCtx).map((c) => ({ ...c, source: id, sweep: def.sweep }));
      const handed = impl.material ? impl.material(scanCtx) : [];
      candidates.push(...found);
      material.push(...handed.map((m) => ({ id: `material:${id}:${m.key}`, type: "material", sweep: def.sweep, source: id, ...m })));
      const gap = scannerGap(impl, { capped: blame.capped && blame.skipped > blamed.skipped, skipped: blame.skipped - blamed.skipped,
        failed: blame.failed.slice(blamed.failed) }, ctx.read.scope, blameCap);
      const note = [def.scope === "hotspots" ? `hotspot files only: ${hotspotNote}` : null, gap].filter(Boolean).join("; ") || null;
      rows.push({ ...row, status: gap ? "partial" : "ran", note });
    } catch (err) {
      rows.push({ ...row, status: "failed", note: `scanner error: ${err.message}` });
    } finally {
      ctx.read.scope = null;
    }
  }
  return { rows, candidates, material };
}

function fullKinds(sweepKinds, rows, registry, dependenciesInstalled) {
  const tools = new Map(registry.tools.map((t) => [t.id, t]));
  return sweepKinds.filter((kind) => {
    const sources = rows.filter((r) => r.status !== "not-applicable" && r.kinds.includes(kind));
    return sources.length > 0 && sources.every((r) =>
      r.status === "ran" && !(tools.get(r.source)?.needsDependencies && !dependenciesInstalled));
  });
}

// The repo-root package.json a `when.packageDependency` tool is judged against; null when it is absent or not a JSON object.
function readRootPackage(repoRoot, files) {
  if (!files.includes("package.json")) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

const byIdAsc = (a, b) => (a.id < b.id ? -1 : 1);

// What judgment-routed kinds hand the judgment dispatch: their candidates, their scanners' material,
// and the open store records of those kinds. A store that cannot be read is reported and costs those kinds their completeness.
function judgmentInputs({ repoRoot, kinds, candidates, material, degraded }) {
  const judged = (kind) => kinds.get(kind)?.route === "judgment";
  const items = [
    ...candidates.filter((c) => judged(c.kind) && !c.cleared).map((c) => ({ id: `candidate:${c.id}`, type: "candidate", sweep: c.sweep,
      kinds: [c.kind], candidateId: c.id, file: c.file, line: c.line, symbol: c.symbol, detail: c.detail ?? null })),
    ...material,
  ];
  let storeReadable = true;
  if ([...kinds.keys()].some(judged)) {
    try {
      for (const r of readMaintenanceFindings(repoRoot).filter((x) => judged(x.culpritKind) && x.lifecycle !== "dismissed"))
        items.push({ id: `record:${r.findingId}`, type: "record", sweep: kinds.get(r.culpritKind).sweep, kinds: [r.culpritKind],
          findingId: r.findingId, title: r.title, affectedFiles: r.affectedFiles });
    } catch (err) {
      storeReadable = false;
      degraded.push(`findings store unreadable (${err.message}); open judgment records not re-examined`);
    }
  }
  return { items: items.sort(byIdAsc), storeReadable };
}

export function runSweep({ repoRoot, outDir, consent = { executing: false, coverage: false }, registry = loadRegistry(),
  runTool = defaultRunTool, files, churn, lines = new Map(), commits = [], now = Date.now(), onPath = onPathDefault, hotspots = null,
  scanners = SCANNERS, adapters = ADAPTERS, blameCap = BLAME_CAP_FILES }) {
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
    lines = measured.lines;
    commits = measured.commits;
    if (measured.error) degraded.push(`git log failed (${measured.error}); blast radius fell back to the file count`);
  }
  const stacks = detectStacks(files, registry);
  const dependenciesInstalled = existsSync(join(repoRoot, "node_modules"));
  const read = makeReader(repoRoot);
  const config = sweepConfig(repoRoot, registry);
  const rows = [];
  const raw = [];
  const selections = selectTools(registry, { stacks, files, consent, rootPackage: readRootPackage(repoRoot, files) });
  const toolNotes = new Map();
  const rowOf = (sel, status, note) => ({ source: sel.tool.id, sweep: sel.tool.sweep, kinds: sel.tool.kinds,
    class: sel.mode ?? Object.keys(sel.tool.modes)[0], status, method: sel.tool.adapter === "raw" ? "tool-raw" : "tool", downloaded: false,
    version: sel.tool.version, note });
  // A fallback tool is judged after every other selection, against the row its primary already earned.
  for (const sel of [...selections.filter((s) => !s.tool.fallbackFor), ...selections.filter((s) => s.tool.fallbackFor)]) {
    if (sel.status !== "run") {
      rows.push(rowOf(sel, sel.status, sel.status === "needs-consent" ? "executing class: needs this pass's consent" : sel.note ?? null));
      continue;
    }
    const primary = sel.tool.fallbackFor && rows.find((r) => r.source === sel.tool.fallbackFor);
    if (primary && (primary.status === "ran" || primary.status === "partial")) {
      rows.push(rowOf(sel, "not-applicable", `superseded by ${sel.tool.fallbackFor}`));
      continue;
    }
    const signals = new Set(sel.tool.stacks.flatMap((st) => registry.stacks[st].signals));
    const anchorFiles = files.filter((f) => signals.has(basename(f))).sort((a, b) => a.split("/").length - b.split("/").length);
    const { row, candidates, notes = [] } = runOneTool(sel, { repoRoot, outDir, files, read, dependenciesInstalled, runTool, onPath, anchorFiles,
      churn, lines, config, registry, stacks, adapters });
    rows.push(row);
    raw.push(...candidates);
    toolNotes.set(sel.tool.sweep, [...(toolNotes.get(sel.tool.sweep) ?? []), ...notes]);
  }
  const hotspotSet = pickHotspots({ list: hotspots, files, churn, cap: registry.config.hotspotCap });
  const scanned = runScanners(registry, stacks, { repoRoot, files, read, now, config }, { scanners, hotspots: hotspotSet, blameCap });
  rows.push(...scanned.rows);
  raw.push(...scanned.candidates);
  const seen = new Set();
  const candidates = [];
  for (const c of raw) {
    const cand = { line: null, symbol: null, noisy: false, cleared: null, ...c };
    cand.id = `${cand.source}:${cand.file}:${cand.line ?? 0}:${cand.symbol ?? ""}`;
    if (!seen.has(cand.id)) { seen.add(cand.id); candidates.push(cand); }
  }
  const kinds = kindIndex(registry);
  const clusters = clusterCandidates(candidates, churn, commits).map((cl) => ({ ...cl, route: kinds.get(cl.kind)?.route ?? "verification" }));
  const judgment = judgmentInputs({ repoRoot, kinds, candidates, material: scanned.material, degraded });
  const sweeps = {};
  for (const [id, def] of Object.entries(registry.sweeps)) {
    const sweepKinds = Object.keys(def.kinds);
    const applicable = new Set(selections.filter((s) => s.tool.sweep === id && s.status !== "not-applicable").flatMap((s) => s.tool.stacks));
    const complete = fullKinds(sweepKinds, rows.filter((r) => r.sweep === id), registry, dependenciesInstalled);
    sweeps[id] = { title: def.title, noun: def.noun, noToolStacks: stacks.filter((s) => !applicable.has(s)), notCovered: def.notCovered,
      sweepKinds, sourcedKinds: sourcedKinds(registry, id), notes: toolNotes.get(id) ?? [],
      fullKinds: judgment.storeReadable ? complete : complete.filter((k) => kinds.get(k).route !== "judgment") };
  }
  const union = (field) => Object.values(sweeps).flatMap((s) => s[field]);
  const coverage = { stacks, dependenciesInstalled, consent, config, hotspots: hotspotSet, degraded, rows, sweeps,
    sweepKinds: union("sweepKinds"), sourcedKinds: union("sourcedKinds"), fullKinds: union("fullKinds") };
  const churned = Object.fromEntries([...churn].filter(([, n]) => n > 0).sort(([a], [b]) => (a < b ? -1 : 1)));
  const ordered = orderForVerification(clusters, Object.keys(registry.sweeps));
  writeFileSync(join(outDir, "candidates.json"), JSON.stringify({ candidates, clusters: ordered, churn: churned }, null, 2) + "\n");
  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  writeFileSync(join(outDir, "judgment-inputs.json"), JSON.stringify({ items: judgment.items }, null, 2) + "\n");
  return { candidates, clusters: ordered, coverage };
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
export function latestEarlierCounts(repoRoot, runId, sweep) {
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

function appendCounts(repoRoot, runId, sweep, categories) {
  const toplevel = gitToplevel(repoRoot);
  if (readRows(recordPath(toplevel, runId)).some((r) => r.kind === "sweep-count" && r.sweep === sweep))
    return "already-recorded";
  for (const [category, c] of Object.entries(categories))
    writeLine(toplevel, runId, { kind: "sweep-count", runId, sweep, category, ...c });
  return "appended";
}

function lcovRow(lcovFiles, consent) {
  const base = { source: "coverage-run", sweep: LCOV_SWEEP, kinds: [], class: "executing", method: "tool", downloaded: false, version: "repo-toolchain" };
  if (lcovFiles) return { ...base, ...(lcovFiles.size
    ? { status: "ran", note: `lcov report covers ${lcovFiles.size} files` }
    : { status: "failed", note: "not an lcov report: no SF records" }) };
  return consent?.coverage
    ? { ...base, status: "unavailable", note: "no lcov report was passed" }
    : { ...base, status: "needs-consent", note: "the coverage run needs this pass's consent" };
}

// One sweep's coverage statement, from that sweep's rows and its own block of coverage.json.
function coverageStatement(coverage, sweep, kinds, registry) {
  const block = coverage.sweeps[sweep];
  const rows = coverage.rows.filter((r) => r.sweep === sweep);
  const ranBy = (kind, methods) => rows
    .filter((r) => (r.status === "ran" || r.status === "partial") && r.kinds.includes(kind) && methods.includes(r.method))
    .map((r) => (r.status === "partial" ? `${r.source} (partial)` : r.source));
  const lines = Object.keys(kinds).map((k) => {
    const tools = ranBy(k, ["tool", "tool-raw"]);
    const heuristics = ranBy(k, ["heuristic"]);
    const how = [tools.length ? `tool-checked by ${tools.join(", ")}` : null,
      heuristics.length ? `heuristic by ${heuristics.join(", ")}` : null].filter(Boolean).join("; ") || "not checked";
    return `- \`${k}\`: ${how}; ${block.fullKinds.includes(k) ? "complete" : "incomplete"}`;
  });
  for (const r of rows) if (r.status === "partial") lines.push(`- partial: ${r.source} (${r.note})`);
  for (const d of coverage.degraded ?? []) lines.push(`- degraded: ${d}`);
  for (const r of rows)
    if (r.status !== "ran" && r.status !== "partial" && r.status !== "not-applicable") lines.push(`- not run: ${r.source} (${r.status}${r.note ? `: ${r.note}` : ""})`);
  for (const r of rows) if (r.downloaded) lines.push(`- downloaded: ${r.source} ${r.version}`);
  for (const r of rows) if (r.scope === "hotspots" && (r.status === "ran" || r.status === "partial")) lines.push(`- hotspot-only: ${r.source} (${r.note})`);
  const scanned = Object.values(registry.scanners ?? {}).some((sc) => sc.sweep === sweep);
  for (const s of block.noToolStacks)
    lines.push(`- ${s}: no ${block.noun} tool for this stack; ${scanned ? "heuristic scan only" : "not measured"}`);
  for (const note of block.notes ?? []) lines.push(`- ${note}`);
  lines.push(`- not covered: ${block.notCovered.join("; ")}`);
  return lines.join("\n");
}

const capSeverity = (severity, max) => (max && SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(max) ? max : severity);

// A kind's default severity, raised by the verdict, then held at the kind's cap unless the verdict names a reason the cap lets through.
function severityOf(kind, v) {
  const raised = v?.severity ? higher(kind.severity, v.severity) : kind.severity;
  return kind.raiseBeyondCapWhen.includes(v?.raiseReason) ? raised : capSeverity(raised, kind.maxSeverity);
}

function outcomeOf(c, v, kind) {
  const severity = severityOf(kind, v);
  if (c.cleared) return { outcome: "cleared", note: c.cleared, severity };
  if (kind.route === "watch") return { outcome: "suspected", note: "watch: complex but stable", severity };
  if (!v) return { outcome: "suspected", note: kind.route === "judgment" ? "not judged: budget" : "not verified: budget", severity };
  if (v.outcome === "verified" && c.noisy) return { outcome: "suspected", note: `${v.note ?? ""} (known-noisy class)`.trim(), severity };
  return { outcome: v.outcome, note: v.note ?? "", severity };
}

// Both answer lists get one set of checks; `route` is the route the list may answer and `noun` names it in errors.
function indexAnswers(list, { byId, kinds, route, noun }) {
  const answered = new Map();
  for (const v of list) {
    const id = v?.candidateId;
    if (!byId.has(id)) throw new Error(`${noun} for unknown candidate "${id}"`);
    const actual = kinds.get(byId.get(id).kind)?.route;
    if (actual !== route) throw new Error(`${noun} for "${id}", which routes to ${actual}`);
    if (answered.has(id)) throw new Error(`two ${noun}s for "${id}"`);
    checkAnswer(v, id);
    answered.set(id, v);
  }
  return answered;
}

function checkAnswer(v, id) {
  if (!OUTCOMES.has(v.outcome)) throw new Error(`invalid outcome "${v.outcome}" for "${id}"`);
  if (v.severity !== undefined && !SEVERITY_ORDER.includes(v.severity)) throw new Error(`invalid severity "${v.severity}" for "${id}"`);
  if (v.raiseReason !== undefined && (typeof v.raiseReason !== "string" || !v.raiseReason.trim())) throw new Error(`invalid raiseReason for "${id}"`);
  if (v.outcome === "cleared" && !String(v.note ?? "").trim()) throw new Error(`cleared "${id}" needs its reason as the note`);
}

const hasText = (x) => typeof x === "string" && x.trim() !== "";

// What the judgment dispatch added beyond the candidates the scan produced, as candidates plus the answers that came with them.
function addedCandidates(added, kinds) {
  const candidates = [], answers = [];
  for (const a of added) {
    const kind = kinds.get(a?.kind);
    if (!kind || kind.sweep !== a.sweep || kind.route !== "judgment")
      throw new Error(`added judgment kind "${a?.kind}" is not a judgment-routed kind of ${a?.sweep}`);
    if (!hasText(a.file) || !hasText(a.clusterKey) || !hasText(a.anchor)) throw new Error("added judgment needs file, clusterKey and anchor");
    const id = `judgment:${a.file}:${a.line ?? 0}:${a.symbol ?? ""}`;
    checkAnswer(a, id);
    if (candidates.some((c) => c.id === id)) throw new Error(`two added judgments for "${id}"`);
    candidates.push({ id, sweep: a.sweep, kind: a.kind, source: "judgment", file: a.file, line: a.line ?? null, symbol: a.symbol ?? null,
      detail: a.detail ?? "", noisy: false, cleared: null, clusterKey: a.clusterKey, anchor: a.anchor });
    const unnamed = a.outcome === "verified" && !String(a.note ?? "").trim();
    answers.push({ candidateId: id, outcome: unnamed ? "suspected" : a.outcome, note: unnamed ? "judgment named no comparison" : a.note,
      severity: a.severity, raiseReason: a.raiseReason });
  }
  return { candidates, answers };
}

// Clusters of the added candidates, joined to a scanned cluster that shares their id; co-change stays the scanned cluster's.
function withAddedClusters(clusters, candidates, added, churn) {
  const fresh = new Map(clusterCandidates(added, new Map(Object.entries(churn))).map((cl) => [cl.clusterId, cl]));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const hit of clusters.filter((cl) => fresh.has(cl.clusterId))) {
    const members = [...hit.candidates.map((id) => byId.get(id)), ...added.filter((c) => `${c.kind}:${c.clusterKey}` === hit.clusterId)];
    fresh.set(hit.clusterId, { ...clusterCandidates(members, new Map(Object.entries(churn)))[0], coChange: hit.coChange });
  }
  return [...clusters.filter((cl) => !fresh.has(cl.clusterId)), ...fresh.values()];
}

const HISTORY_SHAPE = "history must be { files: [{ file, commits, fixCommits }] } with non-negative integer counts";

// The history inspector's table, as a file -> { commits, fixCommits } lookup.
export function historyIndex(history) {
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (!Array.isArray(history?.files) || !history.files.every((f) => hasText(f?.file) && count(f.commits) && count(f.fixCommits)))
    throw new Error(HISTORY_SHAPE);
  return new Map(history.files.map((f) => [f.file, { commits: f.commits, fixCommits: f.fixCommits }]));
}

// A history kind's candidate in a file with fix commits is raised one level, held at the kind's cap unless the kind lets `fix-commits` through.
function raisedByFixCommits(o, kind, fixCommits) {
  const next = SEVERITY_ORDER[Math.min(SEVERITY_ORDER.indexOf(o.severity) + 1, SEVERITY_ORDER.length - 1)];
  const severity = kind.raiseBeyondCapWhen.includes("fix-commits") ? next : capSeverity(next, kind.maxSeverity);
  return { ...o, severity, note: [o.note, `fix commits: ${fixCommits}`].filter(Boolean).join("; ") };
}

const DEPTHS = ["lean", "standard", "thorough"];
const ascending = (a, b) => (a < b ? -1 : 1);

export function finalizeSweep({ outDir, verdicts, judgments = null, depth = "standard", lcov = null, runId = null, repoRoot,
  registry = loadRegistry(), previousCounts, history = null }) {
  if (!DEPTHS.includes(depth)) throw new Error("--depth must be lean, standard or thorough");
  const historyByFile = history === null ? null : historyIndex(history);
  const byHistory = depth === "thorough" ? historyByFile : null;
  const found = readJson(join(outDir, "candidates.json"));
  const coverage = readJson(join(outDir, "coverage.json"));
  const inputs = readJson(join(outDir, "judgment-inputs.json")).items;
  const inputIds = new Set(inputs.map((i) => i.id));
  const kinds = kindIndex(registry);
  const reached = new Set(judgments?.reached ?? []);
  for (const id of reached) if (!inputIds.has(id)) throw new Error(`judgment reached unknown input "${id}"`);
  for (const sweep of Object.keys(registry.sweeps))
    if (!coverage.sweeps?.[sweep]) throw new Error(`coverage.json has no block for sweep "${sweep}"`);

  const added = addedCandidates(judgments?.added ?? [], kinds);
  const candidates = [...found.candidates, ...added.candidates];
  for (const c of candidates) if (!kinds.has(c.kind)) throw new Error(`candidate kind "${c.kind}" is not a registered kind`);
  const clusters = withAddedClusters(found.clusters, found.candidates, added.candidates, found.churn ?? {})
    .map((cl) => ({ ...cl, route: kinds.get(cl.kind).route }));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const verdictById = indexAnswers(verdicts, { byId, kinds, route: "verification", noun: "verdict" });
  const judgedById = indexAnswers([...(judgments?.verdicts ?? []), ...added.answers], { byId, kinds, route: "judgment", noun: "judgment" });
  const lcovFiles = lcov === null ? null : parseLcov(lcov, repoRoot);
  const anchorOf = new Map(clusters.flatMap((cl) => cl.candidates.map((id) => [id, cl.anchor])));
  const historyRank = (cl) => !byHistory || !kinds.get(cl.kind).history ? 0
    : cl.candidates.reduce((n, id) => n + (byId.get(id).score ?? 0), 0) * (1 + (byHistory.get(cl.anchor)?.commits ?? 0));
  const outcomes = new Map();
  for (const c of candidates) {
    const kind = kinds.get(c.kind);
    const o = outcomeOf(c, kind.route === "judgment" ? judgedById.get(c.id) : verdictById.get(c.id), kind);
    const fixCommits = byHistory && kind.history && o.outcome !== "cleared" ? byHistory.get(anchorOf.get(c.id))?.fixCommits ?? 0 : 0;
    outcomes.set(c.id, { ...(fixCommits > 0 ? raisedByFixCommits(o, kind, fixCommits) : o), uncovered: lcovFiles !== null && isUncovered(lcovFiles, c) });
  }
  coverage.rows = [...coverage.rows.filter((r) => r.source !== "coverage-run"), lcovRow(lcovFiles, coverage.consent)];

  const counts = { sweeps: {} }, sections = {}, trending = {}, ratchet = {};
  const entries = [];
  for (const [sweep, def] of Object.entries(registry.sweeps)) {
    const block = coverage.sweeps[sweep];
    // A judgment-routed kind is complete only when the judgment reached every input that concerns it.
    block.fullKinds = block.fullKinds.filter((k) => kinds.get(k)?.route !== "judgment" ||
      (judgments !== null && inputs.filter((i) => i.kinds.includes(k)).every((i) => reached.has(i.id))));
    const categories = Object.fromEntries(Object.keys(def.kinds).map((k) =>
      [k, { verified: 0, suspected: 0, cleared: 0, complete: block.fullKinds.includes(k) }]));
    for (const c of candidates.filter((x) => kinds.get(x.kind).sweep === sweep)) categories[c.kind][outcomes.get(c.id).outcome] += 1;
    counts.sweeps[sweep] = { categories };
    const ranked = clusters.filter((cl) => kinds.get(cl.kind).sweep === sweep).sort((a, b) =>
      historyRank(b) - historyRank(a) || (depth === "thorough" ? b.coChange - a.coChange : 0) || b.blastRadius - a.blastRadius ||
      ascending(a.clusterId, b.clusterId));
    const blocks = [], own = [];
    for (const cl of ranked) {
      if (kinds.get(cl.kind).route === "watch") continue;
      const live = cl.candidates.map((id) => byId.get(id)).filter((c) => outcomes.get(c.id).outcome !== "cleared");
      if (!live.length) continue;
      const severity = live.map((c) => outcomes.get(c.id).severity).reduce(higher);
      const confidence = live.some((c) => outcomes.get(c.id).outcome === "verified") ? "verified" : "suspected";
      const title = `${live.length} ${cl.kind} ${live.length === 1 ? "item" : "items"} in ${cl.anchor}`;
      own.push({ culpritKind: cl.kind, canonicalLocation: cl.anchor, title, severity, confidence,
        affectedFiles: [...new Set(live.map((c) => c.file))].sort() });
      blocks.push(`### ${title}\n\n${severity}, ${confidence}; blast radius ${cl.blastRadius}\n\n` + live.map((c) => {
        const o = outcomes.get(c.id);
        const where = `\`${c.file}${c.line === null ? "" : `:${c.line}`}\`${c.symbol === null ? "" : ` \`${c.symbol}\``}`;
        return [`- ${where}: ${o.outcome}${o.note ? ` (${o.note})` : ""}${o.uncovered ? ", uncovered" : ""}`,
          ...(c.evidence ?? []).map((line) => `  - ${line}`)].join("\n");
      }).join("\n"));
    }
    entries.push(...own);
    const reasons = new Map();
    for (const c of candidates.filter((x) => kinds.get(x.kind).sweep === sweep)) {
      const o = outcomes.get(c.id);
      if (o.outcome === "cleared") reasons.set(o.note, (reasons.get(o.note) ?? 0) + 1);
    }
    const cleared = [...reasons].sort(([a], [b]) => ascending(a, b)).map(([r, n]) => `${r} ${n}`).join(", ") || "none";
    const earlier = previousCounts === undefined ? latestEarlierCounts(repoRoot, runId, sweep) : previousCounts?.[sweep] ?? null;
    trending[sweep] = earlier
      ? Object.entries(categories).map(([k, c]) => {
        const before = earlier[k] ?? { count: 0, complete: false };
        if (!before.complete) return `${k}: not comparable: earlier pass was incomplete`;
        if (!c.complete) return `${k}: not comparable: this pass was incomplete`;
        return `${k} ${before.count} → ${c.verified + c.suspected}`;
      })
      : ["no earlier counted pass on this machine"];
    const ranksHistory = byHistory !== null && Object.keys(def.kinds).some((k) => kinds.get(k).history);
    const order = `${ranksHistory ? "history then " : ""}${depth === "thorough" ? "co-change then blast-radius order" : "blast-radius order"}`;
    const watch = candidates.filter((c) => kinds.get(c.kind).sweep === sweep && kinds.get(c.kind).route === "watch" && outcomes.get(c.id).outcome !== "cleared")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || ascending(a.anchor ?? a.file, b.anchor ?? b.file))
      .map((c) => `- \`${c.anchor ?? c.file}\`: score ${c.score ?? 0}, ${found.churn?.[c.file] ?? 0} commits`);
    sections[sweep] = [`## ${block.title}`, `Findings: ${own.length}, in ${order}. Cleared: ${cleared}.`, ...blocks,
      ...(watch.length ? ["### Watch", watch.join("\n")] : []),
      "### Coverage", coverageStatement(coverage, sweep, def.kinds, registry), "### Trending", trending[sweep].map((t) => `- ${t}`).join("\n")].join("\n\n") + "\n";
  }
  coverage.fullKinds = Object.values(coverage.sweeps).flatMap((b) => b.fullKinds);

  writeFileSync(join(outDir, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
  writeFileSync(join(outDir, "entries.json"), JSON.stringify(entries, null, 2) + "\n");
  writeFileSync(join(outDir, "counts.json"), JSON.stringify(counts, null, 2) + "\n");
  for (const [sweep, section] of Object.entries(sections)) writeFileSync(join(outDir, `section-${sweep}.md`), section);
  for (const [sweep, { categories }] of Object.entries(counts.sweeps))
    ratchet[sweep] = runId === null ? "skipped" : appendCounts(repoRoot, runId, sweep, categories);
  return { entries, counts, sections, trending, ratchet };
}

const USAGE = "usage: hygiene-sweep.mjs run --out <dir> [--repo <root>] [--consent-executing] [--consent-coverage] [--hotspots <file>]\n" +
  "       hygiene-sweep.mjs finalize --dir <dir> --verdicts <file> [--judgments <file>] [--depth lean|standard|thorough] [--lcov <file>] [--history <file>] [--run <runId>] [--repo <root>]";

function mainFinalize(rest) {
  const { flags } = parseFlags(rest, { "--dir": "value", "--verdicts": "value", "--judgments": "value", "--depth": "value", "--lcov": "value", "--history": "value",
    "--run": "value", "--repo": "value" }, { requireValues: "nonEmpty" });
  for (const f of ["--dir", "--verdicts"]) if (!flags[f]) throw new Error(`${f} is required; ${USAGE}`);
  const verdicts = readJson(flags["--verdicts"]);
  if (!Array.isArray(verdicts)) throw new Error(`${flags["--verdicts"]} must hold a JSON array of verdicts`);
  let judgments = null;
  if (flags["--judgments"]) {
    judgments = readJson(flags["--judgments"]);
    if (judgments === null || typeof judgments !== "object" || Array.isArray(judgments))
      throw new Error(`${flags["--judgments"]} must hold a JSON object of judgments`);
  }
  let lcov = null;
  if (flags["--lcov"]) {
    try { lcov = readFileSync(flags["--lcov"], "utf8"); }
    catch (err) { throw new Error(`cannot read ${flags["--lcov"]}: ${err.message}`); }
  }
  let history = null;
  if (flags["--history"]) {
    history = readJson(flags["--history"]);
    try { historyIndex(history); }
    catch (err) { throw new Error(`${flags["--history"]}: ${err.message}`); }
  }
  const { entries, counts, ratchet } = finalizeSweep({ outDir: flags["--dir"], verdicts, judgments, depth: flags["--depth"] ?? "standard", lcov, history,
    runId: flags["--run"] ?? null, repoRoot: resolve(flags["--repo"] ?? process.cwd()) });
  const total = (o) => Object.values(counts.sweeps).flatMap((s) => Object.values(s.categories)).reduce((n, c) => n + c[o], 0);
  process.stdout.write(JSON.stringify({ dir: resolve(flags["--dir"]), entries: entries.length,
    verified: total("verified"), suspected: total("suspected"), cleared: total("cleared"), ratchet }) + "\n");
}

function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "finalize") return mainFinalize(rest);
  if (sub !== "run") throw new Error(USAGE);
  const { flags } = parseFlags(rest, { "--out": "value", "--repo": "value", "--consent-executing": "none", "--consent-coverage": "none", "--hotspots": "value" },
    { requireValues: "nonEmpty" });
  if (!flags["--out"]) throw new Error(`--out is required; ${USAGE}`);
  const repoRoot = resolve(flags["--repo"] ?? process.cwd());
  const consent = { executing: Boolean(flags["--consent-executing"]), coverage: Boolean(flags["--consent-coverage"]) };
  let hotspots = null;
  if (flags["--hotspots"]) {
    try { hotspots = readFileSync(flags["--hotspots"], "utf8").split("\n").map((l) => l.trim()).filter(Boolean); }
    catch (err) { throw new Error(`cannot read ${flags["--hotspots"]}: ${err.message}`); }
  }
  const { candidates, clusters, coverage } = runSweep({ repoRoot, outDir: flags["--out"], consent, hotspots });
  const count = (s) => coverage.rows.filter((r) => r.status === s).length;
  process.stdout.write(JSON.stringify({ out: resolve(flags["--out"]), candidates: candidates.length, clusters: clusters.length,
    ran: count("ran"), partial: count("partial"), failed: count("failed"), unavailable: count("unavailable"), needsConsent: count("needs-consent"),
    fullKinds: coverage.fullKinds }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (err) { process.stderr.write(`hygiene-sweep: ${err.message}\n`); process.exit(1); }
}
