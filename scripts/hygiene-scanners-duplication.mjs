// The duplication sweep's built-in scanners: constants declared or restated across files, and
// environment variables read directly from many files. Each returns candidates for verification
// to judge, never findings. Ids, kinds and stacks are `references/hygiene-sweeps.json`'s
// `scanners`; this file owns only the detection rules and the extensions each scanner `reads`.
import { extname } from "node:path";

const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const CSS_EXTS = new Set([".css", ".scss", ".less"]);
const DECLARING_EXTS = new Set([...JS_EXTS, ".py", ".go", ".rs", ".cs", ...CSS_EXTS]);
const RESTATING_EXTS = new Set([...JS_EXTS, ".py", ".go", ".rs", ".cs", ".html", ".vue", ".svelte"]);
const ENV_READING_EXTS = new Set([...JS_EXTS, ".py", ".go", ".rs", ".cs"]);

const HEX = "#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b";
const NUMBER = "-?\\d[\\d_]*(?:\\.\\d+)?";
const DQ = "\"(?:[^\"\\\\\\n]|\\\\.)*\"";
const SQ = "'(?:[^'\\\\\\n]|\\\\.)*'";
const TQ = "`(?:(?!\\$\\{)[^`\\\\])*`";
const LENGTH = `(${NUMBER})(rem|em|ms|px|vh|vw|%|s)`;
const WHOLE_HEX = new RegExp(`^${HEX}$`);
const WHOLE_LENGTH = new RegExp(`^${LENGTH}$`);
const WHOLE_LITERAL = new RegExp(`^(?:${LENGTH}|(${NUMBER})|(${DQ}|${SQ}|${TQ})|(${HEX}))\\s*[;,]?\\s*(?:(?:\\/\\/|#|\\/\\*).*)?$`);
const tokenizer = (comment) => new RegExp(`(${DQ}|${SQ}|${TQ})|${comment}|(${HEX})|((?<![\\w.$-])${NUMBER}(?![\\w.]))`, "g");
const SLASH_TOKENS = tokenizer("\\/\\/.*|\\/\\*.*?\\*\\/");
const HASH_TOKENS = tokenizer("#.*");
const COMMENT_START = /^\s*(?:\/\/|#|\/\*|\*|<!--)/;
const COMMENT_TEXT = /(?:\/\/|\/\*|<!--|#|^\s*\*)(.*)$/;
const DELIBERATE_COPY = [/\b(deliberate(ly)?|intentional(ly)?)\b.{0,40}\b(cop(y|ied)|duplicat(e|ed|ion))\b/i, /\bkeep in sync\b/i];
const COMMENT_LOOKBACK = 3;
const CLEARED = "documented deliberate copy";
const TRIVIAL_INTEGER_MAX = 10;
const TRIVIAL_STRING_MIN = 4;
const TRIVIAL_LENGTH_MAX = 10;
const RESTATED_INTEGER_BELOW = 100;
const RESTATED_STRING_MIN = 8;
const MIN_FILES = 2;
const MIN_ENV_READ_FILES = 3;

const ENV_READ = new RegExp(
  "(?:process\\.env\\.|process\\.env\\[\\s*[\"']|os\\.environ\\[\\s*[\"']|os\\.environ\\.get\\(\\s*[\"']|os\\.getenv\\(\\s*[\"']"
  + "|os\\.Getenv\\(\\s*[\"']|std::env::var\\(\\s*[\"']|Environment\\.GetEnvironmentVariable\\(\\s*[\"'])([A-Za-z_]\\w*)", "g");

const TYPE_ANNOTATION = "(?::\\s*[^=]+?)?";
const JS_DECL = new RegExp(`^(export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*${TYPE_ANNOTATION}\\s*=\\s*(.+)$`);
const JS_ENUM_OPEN = /\benum\s+([A-Za-z_$][\w$]*)\s*\{(.*)$/;
const ENUM_MEMBER = /([A-Za-z_$][\w$]*)\s*=\s*([^,}]+)/g;
const PY_DECL = new RegExp(`^([A-Z][A-Z0-9_]*)\\s*${TYPE_ANNOTATION}\\s*=\\s*(.+)$`);
const GO_CONST = /^const\s+([A-Za-z_]\w*)(?:\s+[\w.*[\]]+)?\s*=\s*(.+)$/;
const GO_BLOCK_OPEN = /^const\s*\(\s*$/;
const GO_BLOCK_LINE = /^\s+([A-Za-z_]\w*)(?:\s+[\w.*[\]]+)?\s*=\s*(.+)$/;
const RUST_DECL = /^\s*(pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z][A-Z0-9_]*)\s*:\s*[^=]+?=\s*([^;]+);/;
const CS_DECL = /\b((?:(?:public|private|protected|internal|static|readonly|new)\s+)*)const\s+[\w<>[\]?.]+\s+(\w+)\s*=\s*([^;]+);/g;
const CSS_PROPERTY = /(--[\w-]+)\s*:\s*([^;}]+)/g;

const isTrivial = ({ type, value }, restated = false) => {
  if (type === "hex") return false;
  if (type === "length") return Math.abs(parseFloat(value)) <= TRIVIAL_LENGTH_MAX;
  if (type === "number") {
    const n = Math.abs(Number(value));
    return (Number.isInteger(n) && n < (restated ? RESTATED_INTEGER_BELOW : TRIVIAL_INTEGER_MAX + 1)) || value === "0.5";
  }
  const text = value.trim();
  return text.length < (restated ? RESTATED_STRING_MIN : TRIVIAL_STRING_MIN) || ["true", "false", "null"].includes(value)
    || (restated && /^[a-z]+$/.test(text));
};

const lengthValue = (number, unit) => `${Number(number.replaceAll("_", ""))}${unit}`;

function normalize(type, text) {
  if (type === "number") return String(Number(text.replaceAll("_", "")));
  if (type === "hex") return text.toLowerCase();
  const content = text.slice(1, -1);
  return WHOLE_HEX.test(content) ? content.toLowerCase() : content;
}

const literalOf = (type, text) => {
  const value = normalize(type, text);
  if (type !== "string") return { type, value };
  const length = WHOLE_LENGTH.exec(value);
  if (length) return { type: "length", value: lengthValue(length[1], length[2]) };
  return WHOLE_HEX.test(value) ? { type: "hex", value } : { type, value };
};

function parseLiteral(rhs) {
  const m = WHOLE_LITERAL.exec(rhs.trim());
  if (!m) return null;
  if (m[1] !== undefined) return { type: "length", value: lengthValue(m[1], m[2]) };
  const type = m[3] !== undefined ? "number" : m[4] !== undefined ? "string" : "hex";
  return literalOf(type, m[3] ?? m[4] ?? m[5]);
}

function declarationsIn(file, lines) {
  const ext = extname(file);
  const out = [];
  const add = (line, name, rhs, exported) => {
    const literal = parseLiteral(rhs);
    if (literal) out.push({ file, line, name, ...literal, exported });
  };
  let goBlock = false;
  let enumName = null;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (JS_EXTS.has(ext)) {
      const decl = JS_DECL.exec(text);
      if (decl) add(line, decl[2], decl[3], Boolean(decl[1]));
      let body = null;
      const open = JS_ENUM_OPEN.exec(text);
      if (open) { enumName = open[1]; body = open[2]; }
      else if (enumName) body = text;
      if (body !== null) {
        for (const m of body.matchAll(ENUM_MEMBER)) add(line, `${enumName}.${m[1]}`, m[2], false);
        if (body.includes("}")) enumName = null;
      }
    } else if (ext === ".py") {
      const decl = PY_DECL.exec(text);
      if (decl) add(line, decl[1], decl[2], true);
    } else if (ext === ".go") {
      if (goBlock && /^\)/.test(text)) goBlock = false;
      const single = GO_CONST.exec(text);
      const inBlock = goBlock ? GO_BLOCK_LINE.exec(text) : null;
      const decl = single ?? inBlock;
      if (decl) add(line, decl[1], decl[2], /^[A-Z]/.test(decl[1]));
      if (GO_BLOCK_OPEN.test(text)) goBlock = true;
    } else if (ext === ".rs") {
      const decl = RUST_DECL.exec(text);
      if (decl) add(line, decl[2], decl[3], Boolean(decl[1]));
    } else if (ext === ".cs") {
      for (const m of text.matchAll(CS_DECL)) add(line, m[2], m[3], /\bpublic\b/.test(m[1]));
    } else if (CSS_EXTS.has(ext)) {
      for (const m of text.matchAll(CSS_PROPERTY)) add(line, m[1], m[2], true);
    }
  });
  return out;
}

const hasDeliberateCopyNote = (lines, line) => lines.slice(Math.max(0, line - 1 - COMMENT_LOOKBACK), line).some((text) => {
  const comment = COMMENT_TEXT.exec(text)?.[1];
  return comment !== undefined && DELIBERATE_COPY.some((re) => re.test(comment));
});

const wordTokens = (name) => new Set(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .split(/[^A-Za-z]+/).map((t) => t.toLowerCase()).filter((t) => t.length >= 3));
const sharesToken = (a, b) => [...wordTokens(a)].some((t) => wordTokens(b).has(t));

const byLocation = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
  || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);

function groupCandidates(kind, decls, clusterKey, detail) {
  const members = decls.map((d) => ({ kind, file: d.file, line: d.line, symbol: d.name, detail: detail(d), clusterKey, anchor: clusterKey, cleared: d.cleared }));
  const clearAll = members.filter((m) => !m.cleared).length < MIN_FILES;
  return members.map(({ cleared, ...m }) => (cleared || clearAll ? { ...m, cleared: CLEARED } : m));
}

export const duplicateConstants = {
  id: "duplicate-constants",
  reads: [...new Set([...DECLARING_EXTS, ...RESTATING_EXTS])],
  scan({ files, read }) {
    const decls = [];
    const restatingLines = [];
    for (const file of [...files].sort()) {
      const ext = extname(file);
      if (!DECLARING_EXTS.has(ext) && !RESTATING_EXTS.has(ext)) continue;
      const lines = (read(file) ?? "").split("\n");
      const found = DECLARING_EXTS.has(ext) ? declarationsIn(file, lines) : [];
      for (const d of found) d.cleared = hasDeliberateCopyNote(lines, d.line);
      decls.push(...found);
      if (RESTATING_EXTS.has(ext)) restatingLines.push({ file, lines, declared: new Set(found.map((d) => d.line)) });
    }
    const distinctive = decls.filter((d) => !isTrivial(d));
    const out = [];

    const byNameValue = Map.groupBy(distinctive, (d) => `${d.name}=${d.value}`);
    for (const [key, group] of byNameValue) {
      if (new Set(group.map((d) => d.file)).size < MIN_FILES) continue;
      out.push(...groupCandidates("duplicate-constant", group, `constant ${key}`, () => `${key} declared in ${new Set(group.map((d) => d.file)).size} files`));
    }

    const byValue = Map.groupBy(distinctive, (d) => d.value);
    for (const [value, group] of byValue) {
      const owners = group.filter((d) => group.some((o) => o.name !== d.name && sharesToken(d.name, o.name)));
      if (!owners.length) continue;
      const names = [...new Set(group.map((d) => d.name))].sort().join(", ");
      out.push(...groupCandidates("missing-owner", owners, `value ${value}`, () => `${value} declared as ${names} with no shared owner`));
    }

    const ownersByValue = Map.groupBy(distinctive.filter((d) => d.exported && !isTrivial(d, true)), (d) => d.value);
    for (const group of ownersByValue.values()) group.sort((a, b) => (`${a.file}#${a.name}` < `${b.file}#${b.name}` ? -1 : 1));
    for (const { file, lines, declared } of restatingLines) {
      lines.forEach((text, i) => {
        if (declared.has(i + 1) || COMMENT_START.test(text)) return;
        for (const m of text.matchAll(extname(file) === ".py" ? HASH_TOKENS : SLASH_TOKENS)) {
          if (m[1] === undefined && m[2] === undefined && m[3] === undefined) continue;
          const type = m[1] !== undefined ? "string" : m[2] !== undefined ? "hex" : "number";
          const literal = literalOf(type, m[0]);
          if (isTrivial(literal, true)) continue;
          const owner = ownersByValue.get(literal.value)?.find((o) => o.file !== file);
          if (!owner) continue;
          const key = `${owner.file}#${owner.name}`;
          out.push({ kind: "restated-literal", file, line: i + 1, symbol: owner.name, detail: `${m[0]} restates ${key}`, clusterKey: key, anchor: key });
        }
      });
    }
    return out.sort(byLocation);
  },
};

export const scatteredEnvReads = {
  id: "scattered-env-reads",
  reads: [...ENV_READING_EXTS],
  scan({ files, read }) {
    const reads = [];
    for (const file of [...files].sort()) {
      if (!ENV_READING_EXTS.has(extname(file))) continue;
      (read(file) ?? "").split("\n").forEach((text, i) => {
        if (COMMENT_START.test(text)) return;
        for (const m of text.matchAll(ENV_READ)) reads.push({ file, line: i + 1, name: m[1] });
      });
    }
    const filesByName = new Map();
    for (const r of reads) filesByName.set(r.name, new Set(filesByName.get(r.name)).add(r.file));
    return reads
      .filter((r) => filesByName.get(r.name).size >= MIN_ENV_READ_FILES)
      .map((r) => ({ kind: "scattered-env-read", file: r.file, line: r.line, symbol: r.name,
        detail: `${r.name} read directly in ${filesByName.get(r.name).size} files`, clusterKey: `env ${r.name}`, anchor: `env ${r.name}` }))
      .sort(byLocation);
  },
};
