// The hygiene sweep's output adapters, one per registry `adapter` value. Each turns a tool's runs
// into candidates. The spine has already failed a tool whose run errored or exited outside its
// `okExit`, so an adapter judges only its own output. `raw` serves every tool without its own
// parser: it keeps the lines that name a tracked file and a line number, parses the two outputs
// that carry none (`outputFormat`), and surfaces every other line the tool's filter lets through as
// a candidate on the file it names, so non-empty output is never read as a clean run. The full
// output stays in the tool's scratch directory for verification to read. The jscpd adapter reads
// the report file the tool wrote under its scratch directory, not the run's output.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const LOCATION = /^(.+?)[:(](\d+)/;
const PATH_TOKEN = /[^\s"'`()[\]<>:,;]+/g;
const MACHETE_HEADER = /^(\S.*?) -- (.+):$/;
const DETAIL_CAP = 500;

function relativize(path, repoRoot) {
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return rel.replace(/^\.\//, "");
}

const firstLine = (text) => (text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "no output";

function failedExit(run, what) {
  return { ok: false, candidates: [], note: `${run.invocationId}: exit ${run.status} reported ${what}, but its output held none: ${firstLine(run.stderr || run.stdout)}` };
}

// cargo-machete lists `<crate> -- <manifest>:` and then one indented dependency name per line.
function macheteFindings(run, ctx) {
  const found = [];
  let manifest = null;
  for (const line of run.stdout.split("\n")) {
    const header = MACHETE_HEADER.exec(line);
    if (header) { manifest = relativize(header[2], ctx.repoRoot); continue; }
    if (manifest && /^\s+\S+\s*$/.test(line)) found.push({ file: manifest, symbol: line.trim(), detail: `unused dependency: ${line.trim()}` });
    else manifest = null;
  }
  return { found };
}

// `purgecss --rejected` prints a JSON array of { css, file, rejected: [selector] }.
function purgecssFindings(run, ctx) {
  let parsed;
  try { parsed = JSON.parse(run.stdout); } catch { parsed = null; }
  if (!Array.isArray(parsed)) return { error: `${run.invocationId}: unparseable purgecss JSON` };
  const found = parsed.flatMap((entry) => (Array.isArray(entry?.rejected) ? entry.rejected : []).map((selector) =>
    ({ file: relativize(String(entry.file ?? ""), ctx.repoRoot), symbol: String(selector), detail: `purgecss rejected selector: ${selector}` })));
  return { found };
}

const FORMATS = { "cargo-machete": macheteFindings, "purgecss-json": purgecssFindings };

function locatedLines(run, ctx, tracked, candidates, unlocated) {
  const filter = ctx.tool.lineFilter ? new RegExp(ctx.tool.lineFilter) : null;
  let recognised = 0;
  for (const [stream, text] of [["stdout", run.stdout], ["stderr", run.stderr]]) {
    if (stream === "stderr" && !filter) continue;
    for (const line of text.split("\n").map((l) => l.trim())) {
      if (!line || (filter && !filter.test(line))) continue;
      recognised += 1;
      const m = LOCATION.exec(line);
      if (m) {
        const file = relativize(m[1], ctx.repoRoot);
        if (tracked.has(file)) candidates.push({ kind: ctx.tool.kinds[0], file, line: Number(m[2]), symbol: null, detail: line, noisy: true });
        continue;
      }
      const named = [...line.matchAll(PATH_TOKEN)].map((t) => relativize(t[0], ctx.repoRoot)).find((f) => tracked.has(f));
      unlocated.push({ file: named ?? null, line });
    }
  }
  return recognised;
}

export const raw = {
  normalize(runs, ctx) {
    const tracked = new Set(ctx.files);
    const kind = ctx.tool.kinds[0];
    const candidates = [];
    const unlocated = [];
    const format = FORMATS[ctx.tool.outputFormat];
    for (const run of runs) {
      let recognised;
      if (format) {
        const { found, error } = format(run, ctx);
        if (error) return { ok: false, candidates: [], note: error };
        recognised = found.length;
        for (const f of found) if (tracked.has(f.file)) candidates.push({ kind, file: f.file, line: null, symbol: f.symbol, detail: f.detail, noisy: true });
      } else {
        recognised = locatedLines(run, ctx, tracked, candidates, unlocated);
      }
      if (run.status !== 0 && run.status !== null && recognised === 0) return failedExit(run, "findings");
    }
    const anchor = ctx.anchorFiles?.[0] ?? ctx.files[0] ?? null;
    const byFile = new Map();
    for (const u of unlocated) byFile.set(u.file ?? anchor, [...(byFile.get(u.file ?? anchor) ?? []), u.line]);
    if (byFile.has(null)) return { ok: false, candidates: [], note: "output names no tracked file and the repo has none to anchor it on" };
    for (const [file, lines] of byFile)
      candidates.push({ kind, file, line: null, symbol: null, detail: lines.join(" | ").slice(0, DETAIL_CAP), noisy: true });
    return { ok: true, candidates, note: `tool-run, heuristic-normalized; full output in ${relative(ctx.repoRoot, ctx.scratch)}` };
  },
};

const KNIP_MANIFEST = ["dependencies", "devDependencies"];
const KNIP_MEMBERS = ["enumMembers", "namespaceMembers"];
const KNIP_EXPORTS = ["exports", "types", "nsExports", "nsTypes"];
const KNIP_MAPPED = new Set(["files", ...KNIP_MANIFEST, ...KNIP_MEMBERS, ...KNIP_EXPORTS, "file"]);
const STATIC_NOTE = "static mode: knip plugins off, so unused files and dependencies are noisy";
const UNUSED_SYMBOL_CODES = new Set(["TS6133", "TS6138", "TS6192", "TS6196", "TS6198", "TS7027"]);
const TSC_DIAGNOSTIC = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

function parseKnip(run) {
  try {
    const parsed = JSON.parse(run.stdout);
    return Array.isArray(parsed?.issues) ? parsed.issues : null;
  } catch {
    return null;
  }
}

function occursElsewhere(name, line, source) {
  if (source == null) return false;
  const word = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  return source.split("\n").some((text, i) => i + 1 !== line && word.test(text));
}

function knipFindings(issues, ctx, tracked) {
  const findings = [];
  const ignored = new Map();
  for (const issue of issues) {
    const file = relativize(issue.file ?? "", ctx.repoRoot);
    const items = (type) => (Array.isArray(issue[type]) ? issue[type] : []);
    for (const type of Object.keys(issue)) {
      if (!KNIP_MAPPED.has(type) && items(type).length) ignored.set(type, (ignored.get(type) ?? 0) + items(type).length);
    }
    if (!tracked.has(file)) continue;
    const base = (type, item, rest) => findings.push({ type, file, line: item.line ?? null, ...rest });
    for (const item of items("files")) base("files", item, { kind: "dead-code", symbol: null, noisy: ctx.mode === "static" });
    for (const type of KNIP_MANIFEST) {
      for (const item of items(type)) {
        base(type, item, { kind: "dead-code", symbol: item.name, noisy: ctx.mode === "static" || !ctx.dependenciesInstalled });
      }
    }
    for (const type of KNIP_MEMBERS) {
      for (const item of items(type)) base(type, item, { kind: "dead-code", symbol: `${item.namespace}.${item.name}`, noisy: false });
    }
    const source = ctx.read(file);
    for (const type of KNIP_EXPORTS) {
      for (const item of items(type)) {
        const kind = occursElsewhere(item.name, item.line, source) ? "over-exported" : "dead-code";
        base(type, item, { kind, symbol: item.name, noisy: false });
      }
    }
  }
  return { findings, ignored };
}

export const knip = {
  normalize(runs, ctx) {
    const parsed = new Map();
    for (const run of runs.filter((r) => r.invocationId === "default" || r.invocationId === "production")) {
      const issues = parseKnip(run);
      if (!issues) return { ok: false, candidates: [], note: `${run.invocationId}: unparseable knip JSON` };
      parsed.set(run.invocationId, issues);
    }
    const tracked = new Set(ctx.files);
    const kindOf = (kind) => {
      if (!ctx.tool.kinds.includes(kind)) throw new Error(`registry row lacks kind "${kind}"`);
      return kind;
    };
    const key = (f) => `${f.type}|${f.file}|${f.symbol}`;
    const defaults = knipFindings(parsed.get("default") ?? [], ctx, tracked);
    const known = new Set(defaults.findings.map(key));
    const testOnly = knipFindings(parsed.get("production") ?? [], ctx, tracked).findings
      .filter((f) => !known.has(key(f))).map((f) => ({ ...f, kind: "test-only-code" }));
    const candidates = [...defaults.findings, ...testOnly].map((f) => (
      { kind: kindOf(f.kind), file: f.file, line: f.line, symbol: f.symbol, detail: `knip ${f.type}${f.symbol ? `: ${f.symbol}` : ""}`, noisy: f.noisy }));
    const ignored = [...defaults.ignored].sort(([a], [b]) => (a < b ? -1 : 1)).map(([type, n]) => `${n} ${type}`);
    const notes = [ignored.length ? `not dead-code issues, ignored: ${ignored.join(", ")}` : null, ctx.mode === "static" ? STATIC_NOTE : null];
    return { ok: true, candidates, note: notes.filter(Boolean).join("; ") || null };
  },
};

export const tsc = {
  normalize(runs, ctx) {
    const tracked = new Set(ctx.files);
    const candidates = [];
    let others = 0;
    for (const run of runs) {
      let diagnostics = 0;
      for (const line of run.stdout.split("\n")) {
        const m = TSC_DIAGNOSTIC.exec(line.trim());
        if (!m) continue;
        diagnostics += 1;
        const [, path, row, , code, message] = m;
        if (!UNUSED_SYMBOL_CODES.has(code)) { others += 1; continue; }
        const file = relativize(path, ctx.repoRoot);
        if (!tracked.has(file)) continue;
        candidates.push({ kind: ctx.tool.kinds[0], file, line: Number(row), symbol: /'([^']+)'/.exec(message)?.[1] ?? null,
          detail: `${code}: ${message}`, noisy: false });
      }
      if (run.status !== 0 && run.status !== null && diagnostics === 0) return failedExit(run, "diagnostics");
    }
    return { ok: true, candidates, note: others ? `${others} other diagnostics ignored` : null };
  },
};

// jscpd reports clone pairs, so a clone in three files arrives as two or more pairs. Joining the two
// instances of every pair makes a family the connected set, and the family's key is a hash of its
// smallest normalized fragment, so the same clone keeps one key across passes while lines move.
function readJscpdReport(scratch) {
  try {
    const report = JSON.parse(readFileSync(join(scratch, "report", "jscpd-report.json"), "utf8"));
    if (!Array.isArray(report?.duplicates)) return { error: "no duplicates array" };
    return { duplicates: report.duplicates };
  } catch (err) {
    return { error: err.message };
  }
}

function jscpdIgnores(ctx) {
  const args = ctx.tool.modes?.[ctx.mode]?.invocations?.[0]?.args ?? [];
  const globs = args.flatMap((arg, i) => (args[i - 1] === "--ignore" ? arg.split(",") : []));
  return globs.length ? `excludes ${globs.join(", ")}` : null;
}

export const jscpd = {
  normalize(runs, ctx) {
    const { duplicates, error } = readJscpdReport(ctx.scratch);
    if (error) return { ok: false, candidates: [], note: `jscpd report missing or unreadable: ${error}` };
    const tracked = new Set(ctx.files);
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
      return x;
    };
    const instances = new Map();
    const pairs = [];
    for (const dup of duplicates) {
      const ends = [dup.firstFile, dup.secondFile].map((side) => {
        const file = relativize(String(side?.name ?? ""), ctx.repoRoot);
        const key = `${file}:${side?.start}:${side?.end}`;
        if (!instances.has(key)) instances.set(key, { key, file, line: side?.start, lines: dup.lines, tokens: dup.tokens, format: dup.format });
        if (!parent.has(key)) parent.set(key, key);
        return key;
      });
      parent.set(find(ends[0]), find(ends[1]));
      pairs.push({ root: ends[0], fragment: String(dup.fragment ?? "").replace(/\s+/g, " ") });
    }
    const fragments = new Map();
    for (const { root, fragment } of pairs) {
      const family = find(root);
      const smallest = fragments.get(family);
      if (smallest === undefined || fragment < smallest) fragments.set(family, fragment);
    }
    const kept = new Map();
    for (const inst of instances.values()) {
      if (!tracked.has(inst.file)) continue;
      const family = find(inst.key);
      kept.set(family, [...(kept.get(family) ?? []), inst]);
    }
    const candidates = [];
    for (const [family, members] of kept) {
      if (members.length < 2) continue;
      const clusterKey = `clone ${createHash("sha256").update(fragments.get(family)).digest("hex").slice(0, 12)}`;
      for (const m of members) {
        candidates.push({ kind: ctx.tool.kinds[0], file: m.file, line: m.line, symbol: null,
          detail: `${m.lines} lines, ${m.tokens} tokens (${m.format})`, clusterKey, anchor: clusterKey, noisy: false });
      }
    }
    candidates.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { ok: true, candidates, note: jscpdIgnores(ctx) };
  },
};

export const ADAPTERS = { raw, knip, tsc, jscpd };
