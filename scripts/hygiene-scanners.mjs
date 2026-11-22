// The hygiene sweep's built-in scanners: grep-level heuristics for what no registry tool covers.
// Each returns candidates for verification to judge, never findings. Ids, kinds and the stacks a
// scanner applies to are `references/hygiene-sweeps.json`'s `scanners`; this file owns only the
// detection rules.
import { basename, extname } from "node:path";

const SLASH_COMMENT_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".cs", ".java"]);
const HASH_COMMENT_EXTS = new Set([".py", ".rb", ".sh"]);
const CODE_EXTS = new Set([...SLASH_COMMENT_EXTS, ...HASH_COMMENT_EXTS]);
const CODE_START = /^(const|let|var|return|if|for|while|import|export|function|def|class)\b/;
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const DAY_MS = 86_400_000;

const looksLikeCode = (body) => /[;{}]$/.test(body) || CODE_START.test(body);

function commentBody(line, ext) {
  const m = SLASH_COMMENT_EXTS.has(ext) ? /^\s*\/\/\s?(.*)$/.exec(line) : /^\s*#(?!!)\s?(.*)$/.exec(line);
  return m ? m[1].trim() : null;
}

export const commentedOutCode = {
  id: "commented-out-code",
  scan({ files, read }) {
    const out = [];
    for (const file of files.filter((f) => CODE_EXTS.has(extname(f)))) {
      const lines = (read(file) ?? "").split("\n");
      let start = -1;
      const flush = (end) => {
        if (start >= 0 && end - start >= 3)
          out.push({ kind: "commented-out-code", file, line: start + 1, symbol: null, detail: `${end - start} commented-out lines` });
        start = -1;
      };
      lines.forEach((line, i) => {
        const body = commentBody(line, extname(file));
        if (body !== null && looksLikeCode(body)) { if (start < 0) start = i; }
        else flush(i);
      });
      flush(lines.length);
    }
    return out;
  },
};

export const staleTodo = {
  id: "stale-todo",
  scan({ files, read, blame, now, config }) {
    const out = [];
    for (const file of files.filter((f) => CODE_EXTS.has(extname(f)))) {
      const lines = (read(file) ?? "").split("\n");
      const hits = lines.flatMap((l, i) => (/\b(TODO|FIXME)\b/.test(l) ? [i + 1] : []));
      if (!hits.length) continue;
      const times = blame(file);
      if (!times) continue;
      for (const line of hits) {
        const time = times.find((b) => b.line === line)?.time;
        if (time === undefined || now - time <= config.staleTodoDays * DAY_MS) continue;
        out.push({ kind: "stale-todo", file, line, symbol: null,
          detail: `${lines[line - 1].trim().slice(0, 120)} (last changed ${new Date(time).toISOString().slice(0, 10)})` });
      }
    }
    return out;
  },
};

export const unusedEnvVar = {
  id: "unused-env-var",
  scan({ files, read }) {
    const declared = [];
    for (const file of files.filter((f) => ENV_TEMPLATES.has(basename(f)))) {
      (read(file) ?? "").split("\n").forEach((l, i) => {
        const m = /^([A-Z][A-Z0-9_]*)=/.exec(l);
        if (m) declared.push({ file, line: i + 1, key: m[1] });
      });
    }
    if (!declared.length) return [];
    const unread = new Set(declared.map((d) => d.key));
    for (const file of files.filter((f) => !ENV_TEMPLATES.has(basename(f)))) {
      const text = read(file);
      if (!text) continue;
      for (const key of unread) if (new RegExp(`\\b${key}\\b`).test(text)) unread.delete(key);
      if (!unread.size) break;
    }
    return declared.filter((d) => unread.has(d.key)).map((d) => ({
      kind: "unused-env-var", file: d.file, line: d.line, symbol: d.key, detail: `${d.key} is declared in ${d.file} and read nowhere`,
    }));
  },
};

export const SCANNERS = [commentedOutCode, staleTodo, unusedEnvVar];
