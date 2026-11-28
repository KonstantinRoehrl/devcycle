// The hygiene sweep's built-in scanners: grep-level heuristics for what no registry tool covers.
// Each returns candidates for verification to judge, never findings. Ids, kinds and the stacks a
// scanner applies to are `references/hygiene-sweeps.json`'s `scanners`; this file owns only the
// detection rules.
import { basename, extname } from "node:path";
import { duplicateConstants, scatteredEnvReads } from "./hygiene-scanners-duplication.mjs";

const SLASH_COMMENT_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".go", ".rs", ".cs", ".java"]);
const HASH_COMMENT_EXTS = new Set([".py", ".rb", ".sh"]);
const CODE_EXTS = new Set([...SLASH_COMMENT_EXTS, ...HASH_COMMENT_EXTS]);
const CODE_START = /^(const|let|var|return|if|for|while|import|export|function|def|class)\b/;
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const DAY_MS = 86_400_000;
const STYLE_EXTS = new Set([".css", ".scss", ".less"]);
const ASSET_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".ogg", ".wav", ".mov", ".pdf",
]);
const ASSET_DIR = /(?:^|\/)(?:public|static|assets)\//;
const BROWSER_FETCHED = /^(?:favicon|apple-touch-icon|android-chrome|mstile)/;

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
  blameUnit: ["file with a TODO was", "files with a TODO were"],
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


const blank = (match) => match.replace(/[^\n]/g, " ");
const isStyle = (file) => STYLE_EXTS.has(extname(file));
const byFileThenLine = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0));

// Blanks block comments and whole-line `//` comments in a style file, keeping every newline so line numbers hold.
const stripStyleComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);

function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Style files with comments blanked, and the set of `[\w-]+` tokens every non-style file holds.
function readWeb(files, read, tokenPattern = /[\w-]+/g) {
  const styles = [], tokens = new Set(), code = [];
  for (const file of files) {
    const raw = read(file) ?? "";
    if (isStyle(file)) styles.push({ file, text: stripStyleComments(raw) });
    else { code.push({ file, text: raw }); for (const t of raw.match(tokenPattern) ?? []) tokens.add(t); }
  }
  return { styles, tokens, code };
}

export const cssCustomProperties = {
  id: "css-custom-properties",
  scan({ files, read }) {
    const { styles, tokens, code } = readWeb(files, read);
    const readNames = new Set();
    for (const { text } of [...styles, ...code]) for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) readNames.add(m[1]);
    const out = [];
    for (const { file, text } of styles) {
      const lineOf = lineIndex(text);
      for (const m of text.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)) {
        const name = m[1];
        if (readNames.has(name) || tokens.has(name)) continue;
        out.push({ kind: "dead-code", file, line: lineOf(m.index + m[0].indexOf(name)), symbol: name,
          detail: `${name} is declared in ${file} and read by no var() or code file` });
      }
    }
    return out.sort(byFileThenLine);
  },
};

export const cssClassesKeyframes = {
  id: "css-classes-keyframes",
  scan({ files, read }) {
    const { styles, tokens, code } = readWeb(files, read);
    const prefixes = new Set();
    for (const { text } of code) for (const m of text.matchAll(/([a-zA-Z][\w-]*-)\$\{/g)) prefixes.add(m[1]);
    const animated = new Set();
    for (const { text } of styles)
      for (const m of text.matchAll(/animation(?:-name)?\s*:([^;}]*)/g)) for (const t of m[1].match(/[\w-]+/g) ?? []) animated.add(t);
    const out = [];
    for (const { file, text } of styles) {
      const lineOf = lineIndex(text);
      const seen = new Set();
      for (const m of text.matchAll(/([^{};]*)\{/g)) {
        const prelude = m[1].replace(/"[^"\n]*"|'[^'\n]*'/g, blank);
        const at = prelude.search(/\S/);
        if (at < 0) continue;
        const frames = /^@(?:-webkit-)?keyframes\s+([\w-]+)/.exec(prelude.slice(at));
        if (frames) {
          const name = frames[1];
          if (animated.has(name) || tokens.has(name)) continue;
          out.push({ kind: "dead-code", file, line: lineOf(m.index + at), symbol: `@keyframes ${name}`,
            detail: `@keyframes ${name} in ${file} is named by no animation value or code file` });
          continue;
        }
        if (prelude[at] === "@") continue;
        for (const c of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
          const name = c[1];
          if (seen.has(name)) continue;
          seen.add(name);
          if (tokens.has(name)) continue;
          const dynamic = [...prefixes].some((p) => name.startsWith(p));
          out.push({ kind: "dead-code", file, line: lineOf(m.index + c.index), symbol: `.${name}`,
            detail: `.${name} is declared in ${file} and named by no code file`,
            ...(dynamic ? { cleared: "dynamic prefix" } : {}) });
        }
      }
    }
    return out.sort(byFileThenLine);
  },
};

const DECLARATION_MODIFIERS = "(?:(?:public|protected|private|readonly|static|override|declare|get|set)\\s+)*";
const INPUT_DECORATOR = new RegExp(
  `@(Input|Output)\\(((?:[^()]|\\([^()]*\\))*)\\)\\s*${DECLARATION_MODIFIERS}([\\w$]+)`, "g");
const SIGNAL_MEMBER = new RegExp(
  `^[ \\t]*${DECLARATION_MODIFIERS}([\\w$]+)\\s*=\\s*(?:input|output|model)(?:\\.required)?\\s*(?:<[^\\n]*?>)?\\s*\\(`, "gm");
const ALIAS = /alias\s*:\s*['"]([^'"]+)['"]/;

function templateNames(files, read) {
  const names = new Set();
  const addFrom = (text) => {
    for (const re of [/\[\(?([\w-]+)\)?\]/g, /\(([\w-]+)\)/g, /\s([\w-]+)=/g]) for (const m of text.matchAll(re)) names.add(m[1]);
  };
  for (const file of files) {
    const text = read(file) ?? "";
    if (extname(file) === ".html") addFrom(text);
    else if (extname(file) === ".ts") for (const m of text.matchAll(/template\s*:\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g)) addFrom(m[1]);
  }
  return names;
}

function routedComponents(tsTexts) {
  const names = new Set();
  for (const text of tsTexts) {
    for (const m of text.matchAll(/\bcomponent\s*:\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of text.matchAll(/loadComponent\s*:[^\n]*?=>[^\n]*?\bm\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  }
  return names;
}

export const angularIo = {
  id: "angular-io",
  scan({ files, read }) {
    const tsFiles = files.filter((f) => extname(f) === ".ts");
    const texts = tsFiles.map((file) => ({ file, text: read(file) ?? "" }));
    const bound = templateNames(files, read);
    const routed = routedComponents(texts.map((t) => t.text));
    const out = [];
    for (const { file, text } of texts) {
      const lineOf = lineIndex(text);
      const classes = [...text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)].map((m) => ({ at: m.index, name: m[1] }));
      const declared = [];
      for (const m of text.matchAll(INPUT_DECORATOR)) {
        const alias = /^\s*['"]([^'"]+)['"]/.exec(m[2])?.[1] ?? ALIAS.exec(m[2])?.[1];
        declared.push({ at: m.index + m[0].length - m[3].length, prop: m[3], name: alias ?? m[3], decorator: m[1] });
      }
      for (const m of text.matchAll(SIGNAL_MEMBER)) {
        const eol = text.indexOf("\n", m.index);
        const rest = text.slice(m.index, eol < 0 ? text.length : eol);
        const prop = m[1];
        declared.push({ at: m.index + m[0].indexOf(prop), prop, name: ALIAS.exec(rest)?.[1] ?? prop, decorator: "signal" });
      }
      for (const d of declared) {
        if (bound.has(d.name)) continue;
        const owner = classes.filter((c) => c.at < d.at).pop()?.name ?? null;
        out.push({ kind: "dead-code", file, line: lineOf(d.at), symbol: d.prop,
          detail: `${d.prop} is an ${d.decorator === "Output" ? "output" : "input"} of ${owner ?? "a class"} that no template binds`,
          ...(owner && routed.has(owner) ? { cleared: "routed component" } : {}) });
      }
    }
    return out.sort(byFileThenLine);
  },
};

export const staticAssets = {
  id: "static-assets",
  scan({ files, read }) {
    const assets = files.filter((f) => ASSET_DIR.test(f) && ASSET_EXTS.has(extname(f).toLowerCase()));
    if (!assets.length) return [];
    const wanted = new Set(assets.map((f) => basename(f)));
    const named = new Set();
    for (const file of files) {
      for (const t of read(file)?.match(/[\w.@+-]+/g) ?? []) if (wanted.has(t)) named.add(t);
    }
    return assets.filter((f) => !named.has(basename(f))).map((file) => ({
      kind: "dead-code", file, line: null, symbol: null, detail: `${file} is named by no tracked file`,
      ...(BROWSER_FETCHED.test(basename(file)) ? { cleared: "browser-fetched by convention" } : {}),
    })).sort(byFileThenLine);
  },
};

export const SCANNERS = [commentedOutCode, staleTodo, unusedEnvVar, cssCustomProperties, cssClassesKeyframes, angularIo, staticAssets, duplicateConstants, scatteredEnvReads];
