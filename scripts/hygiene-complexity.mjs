// Owns reading a repo's complexity thresholds from its linter config and scoring files from
// per-function metric rows. references/hygiene-sweeps.json owns every value (defaults, config-key
// maps, hot-commit count); scripts/generated-paths.mjs owns which paths are excluded. Imports no
// registry module: scripts/hygiene-registry.mjs imports the adapters, which import this.
import { basename } from "node:path";
import { HEAD_LINES, exclusionCategory, linguistAttributes } from "./generated-paths.mjs";

export const HOT_KIND = "complexity-hotspot";
export const WATCH_KIND = "complexity-watch";

const FUNCTION_METRICS = ["ccn", "cognitive", "nesting", "params", "nloc"];
const EXCLUSION_ORDER = ["lockfile", "generated", "vendored", "test-fixture"];
const STACK_BY_EXTENSION = {
  js: "js-ts", mjs: "js-ts", cjs: "js-ts", jsx: "js-ts", ts: "js-ts", tsx: "js-ts", mts: "js-ts", cts: "js-ts", vue: "js-ts",
  py: "python", go: "go", rs: "rust", cs: "dotnet", fs: "dotnet",
};
const KEY_BOUNDARY = String.raw`(?<![\w/@.-])`;

export function stackOf(file) {
  const extension = basename(file).split(".").slice(1).pop();
  return STACK_BY_EXTENSION[extension] ?? "other";
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripQuotes = (token) => token.replace(/^["']|["']$/g, "");

// ESLint configs, JSON and flat alike: `<key>: [<severity>, <n>]` or `[<severity>, { max: <n> }]`.
function eslintSetting(text, key) {
  const name = `${KEY_BOUNDARY}["']?${escapeRegExp(key)}["']?\\s*:`;
  const array = new RegExp(`${name}\\s*\\[\\s*("[^"]*"|'[^']*'|\\w+)\\s*,\\s*(?:(\\d+)\\b|\\{[^}]*?\\bmax\\s*:\\s*(\\d+)\\b)`).exec(text);
  if (array) {
    const severity = stripQuotes(array[1]);
    return severity === "off" || severity === "0" ? { off: true } : { value: Number(array[2] ?? array[3]) };
  }
  if (new RegExp(`${name}\\s*(?:"off"|'off'|0(?![\\d.]))`).test(text)) return { off: true };
  return new RegExp(name).test(text) ? { unreadable: true } : null;
}

// Python tool configs: a line `<key> = <n>`, `<key>=<n>` or `<key>: <n>`.
function lineSetting(text, key) {
  const name = `^\\s*["']?${escapeRegExp(key)}["']?\\s*[=:]`;
  const integer = new RegExp(`${name}\\s*(\\d+)\\s*(?:[#;].*)?$`, "m").exec(text);
  if (integer) return { value: Number(integer[1]) };
  return new RegExp(name, "m").test(text) ? { unreadable: true } : null;
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlockEnd = (line, indent) => line.trim() !== "" && !line.trim().startsWith("#") && indentOf(line) <= indent;

// .golangci.yml: `<linter>.<setting>` is a `<linter>:` line followed by a deeper-indented `<setting>: <n>` line.
function yamlSetting(text, key) {
  const [linter, setting] = key.split(".");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*${escapeRegExp(linter)}:\\s*(?:#.*)?$`).test(l));
  if (start < 0) return null;
  const indent = indentOf(lines[start]);
  const settingLine = new RegExp(`^\\s+${escapeRegExp(setting)}:(.*)$`);
  for (const line of lines.slice(start + 1)) {
    if (isBlockEnd(line, indent)) break;
    const found = settingLine.exec(line);
    if (found) {
      const value = /^\s*(\d+)\s*(?:#.*)?$/.exec(found[1]);
      return value ? { value: Number(value[1]) } : { unreadable: true };
    }
  }
  return null;
}

const isYaml = (file) => /\.ya?ml$/.test(file);
const settingReader = (family, key) => (family.files === "eslint-row" ? eslintSetting : key.includes(".") ? yamlSetting : lineSetting);

function configFileNames(family, registry) {
  if (family.files !== "eslint-row") return family.files;
  return registry.tools.find((t) => t.id === "eslint")?.when?.anyFile ?? [];
}

export function readThresholds({ files, read, registry, stacks }) {
  const { defaults, configKeys = {} } = registry.complexity;
  const byStack = {};
  for (const stack of [...stacks.filter((s) => s !== "other" && defaults[s]), "other"]) {
    byStack[stack] = Object.fromEntries(Object.entries(defaults[stack]).map(([metric, d]) => [metric, { value: d.value, source: d.source }]));
  }
  const notes = [];
  const note = (text) => { if (!notes.includes(text)) notes.push(text); };
  for (const family of Object.values(configKeys)) {
    if (!byStack[family.stack]) continue;
    const names = configFileNames(family, registry);
    for (const path of files) if (path.includes("/") && names.includes(basename(path))) note(`${path}: not read (root only)`);
    const unresolved = new Set(Object.keys(family.keys));
    for (const file of names.filter((n) => files.includes(n))) {
      const text = read(file);
      if (text === null || text === undefined) continue;
      for (const [key, metric] of Object.entries(family.keys)) {
        if (key.includes(".") && !isYaml(file)) {
          const [linter, setting] = key.split(".");
          if (text.includes(linter) && text.includes(setting)) note(`${file}: not read statically (yaml only); defaults kept`);
          continue;
        }
        if (!unresolved.has(key)) continue;
        const found = settingReader(family, key)(text, key);
        if (!found) continue;
        unresolved.delete(key);
        if (found.value !== undefined) byStack[family.stack][metric] = { value: found.value, source: `${file} ${key}` };
        else note(`${file} ${key}: ${found.off ? "off" : "not read statically"}; default kept`);
      }
    }
  }
  return { byStack, notes };
}

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function overMetrics(row, limits) {
  return FUNCTION_METRICS.filter((m) => row[m] != null && limits[m] && row[m] > limits[m].value)
    .map((m) => `${m} ${row[m]} > ${limits[m].value} (${limits[m].source})`);
}

export function scoreFiles(rows, { thresholds, churn, lines, hotCommits, files, read, attributes, stackOf: stackFor }) {
  const known = new Set(files);
  const excluded = Object.fromEntries(EXCLUSION_ORDER.map((c) => [c, 0]));
  const byFile = new Map();
  for (const row of rows.filter((r) => known.has(r.file))) byFile.set(row.file, [...(byFile.get(row.file) ?? []), row]);
  const candidates = [];
  for (const [file, fileRows] of [...byFile].sort(([a], [b]) => byText(a, b))) {
    const text = read(file) ?? "";
    const category = exclusionCategory(file, { head: text.split("\n").slice(0, HEAD_LINES).join("\n"), attributes });
    if (category) { excluded[category] += 1; continue; }
    const limits = thresholds.byStack[stackFor(file)] ?? thresholds.byStack.other;
    const total = lineCount(text);
    const over = fileRows.map((row) => ({ row, hits: overMetrics(row, limits) })).filter((o) => o.hits.length)
      .sort((a, b) => a.row.line - b.row.line);
    const excess = Math.max(0, total - (limits.fileLines?.value ?? Infinity));
    if (!over.length && !excess) continue;
    const score = over.reduce((sum, o) => sum + (o.row.cognitive ?? o.row.ccn), 0) + excess;
    const commits = churn.get(file) ?? 0;
    const evidence = over.map((o) => `\`${o.row.name}\` L${o.row.line}: ${o.hits.join(", ")}`);
    if (excess) evidence.push(`file: fileLines ${total} > ${limits.fileLines.value} (${limits.fileLines.source})`);
    evidence.push(`churn: ${commits} commits, ${lines.get(file) ?? 0} lines`);
    candidates.push({ kind: commits >= hotCommits ? HOT_KIND : WATCH_KIND, file, line: null, symbol: null, clusterKey: file, anchor: file, score,
      detail: `${over.length} of ${fileRows.length} functions over threshold, ${total} lines; score ${score}`, evidence, noisy: false });
  }
  return { candidates, excluded };
}

export function complexityResult(rows, ctx, { notes = [] } = {}) {
  const attributes = ctx.files.includes(".gitattributes") ? linguistAttributes(ctx.read(".gitattributes") ?? "") : [];
  const thresholds = readThresholds({ files: ctx.files, read: ctx.read, registry: ctx.registry, stacks: ctx.stacks });
  const { candidates, excluded } = scoreFiles(rows, { thresholds, churn: ctx.churn ?? new Map(), lines: ctx.lines ?? new Map(),
    hotCommits: ctx.config.hotCommits, files: ctx.files, read: ctx.read, attributes, stackOf });
  const dropped = EXCLUSION_ORDER.filter((c) => excluded[c]).map((c) => `${c} ${excluded[c]}`);
  const coverage = [...thresholds.notes, ...(dropped.length ? [`excluded before measurement: ${dropped.join(", ")}`] : []), ...notes];
  return { ok: true, candidates, note: null, coverage };
}
