#!/usr/bin/env node
// Pre-flight check for a devcycle plan: for each non-test file a task modifies, find repo code
// files that reference it (by module basename) but appear in no task's Files block. Any such
// referencer -- test or non-test -- is a hard failure (it almost certainly needs updating), cleared
// only by adding it to a Files block or recording an override. The gate walks only JS/TS/Python
// files (CODE_EXT) and matches the changed file's basename with its extension, so a referencer in
// any other language, or one that imports `./foo` without the extension, is never seen. `--scan`
// is the planner's wider, advisory pass over the same walk. See playbooks/planning-waves.md.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, relative, resolve, isAbsolute, sep, posix } from "node:path";
import { taskBlocks, taskFileMap, TEST_FILE_SUFFIXES, normalizeFileToken, isTestPath } from "./task-files.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";

const TEST_SUFFIXES = [...TEST_FILE_SUFFIXES, ".test.jsx", ".test.tsx", ".spec.ts", ".spec.js"];
const CODE_EXT = new Set([".mjs", ".js", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".py"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".devcycle", ".worktrees"]);

const isTestFile = (p) => TEST_SUFFIXES.some((s) => p.endsWith(s));

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// The resolution planning-waves.md documents: a planner acknowledges a referencer (test or
// non-test) that does not need updating, with a reason, and the gate clears rather than being
// walked around in prose.
//   - Blast-radius override: <changed-file> [→ <referencer>] — <reason>
// File-only clears every referencer of that file; "→ <referencer>" clears just that pair. A
// missing reason is an error — an unexplained override is exactly the silent walk-around this
// gate prevents.
const OVERRIDE_START = /^\s*-\s*Blast-radius override:/;
const OVERRIDE_RE = /^\s*-\s*Blast-radius override:\s*(\S+?)(?:\s*→\s*(\S+))?\s*—\s*(.*\S)\s*$/;

const failed = (finding) => ({ findings: [finding], ok: "", notes: [] });

// A finding opens with the task(s) whose Files block declares the changed file, so a delegated
// merge can route it back to the drafter that wrote that block.
export const owningTasks = (filesByTask, file) =>
  [...filesByTask].filter(([, files]) => files.has(file)).map(([num]) => num);
export const taskLabel = (nums) => (nums.length === 1 ? `Task ${nums[0]}` : `Tasks ${nums.join("+")}`);

export function blastRadiusLeg(planText, { planPath, repoRoot }) {
  const blocks = taskBlocks(planText);
  // A plan that yields no tasks is a parse failure, not a plan with no blast radius: without this
  // the walk below has nothing to match and reports ok against an empty list.
  if (blocks.length === 0) return failed(`no "### Task N" blocks found in ${planPath}`);
  const filesByTask = taskFileMap(planText);
  const declared = new Set([...filesByTask.values()].flatMap((files) => [...files]));
  // The walk below reasons over `declared`, not over the blocks: a plan whose tasks name no files
  // at all matches nothing and would report ok against an empty list just as a heading-less one would.
  if (declared.size === 0) {
    // The same split, from the same map, as wave-disjointness-check's -- and deliberately the same
    // sentence. Both gates read one taskFileMap, so a plan whose blocks say "none" that made one
    // gate report the blocks missing and the other report them empty sent the author to two repairs
    // for one plan.
    return failed(
      filesByTask.size === 0
        ? `no "**Files:**" blocks found in ${planPath}`
        : `no task in ${planPath} declares a file -- its "**Files:**" blocks are present but empty`
    );
  }
  const changed = [...declared].filter((f) => !isTestFile(f));

  const codeFiles = walk(repoRoot)
    .map((p) => relative(repoRoot, p).split(sep).join("/"))
    .filter((p) => CODE_EXT.has(extname(p)));

  const overrides = [];
  for (const { text: blockText } of blocks) {
    for (const line of blockText.split("\n")) {
      if (!OVERRIDE_START.test(line)) continue;
      const m = line.match(OVERRIDE_RE);
      // Normalize both captures through the same normalizeFileToken the declaration side ran
      // every "**Files:**" token through, so an override written with backticks or trailing
      // punctuation -- exactly how planners write paths elsewhere -- still matches `chg` below.
      const file = m ? normalizeFileToken(m[1]) : null;
      const test = m && m[2] !== undefined ? normalizeFileToken(m[2]) : null;
      // A present "→ <referencer>" whose token does not normalize to a path is malformed just as a
      // bad changed-file token is; otherwise it would silently widen the override from the single
      // pair to every referencer of the changed file.
      if (!m || file === null || (m[2] !== undefined && test === null)) {
        return failed(`malformed override (needs "<changed-file> [→ <referencer>] — <reason>"): ${line.trim()}`);
      }
      overrides.push({ file, test, reason: m[3] });
    }
  }

  const findings = [];
  const notes = [];
  for (const chg of changed) {
    const base = basename(chg); // keep the extension: `config.md`, not `config`
    const tokenRe = new RegExp(`[/.'"\`]${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const cand of codeFiles) {
      if (cand === chg || declared.has(cand)) continue;
      let content;
      try {
        content = readFileSync(join(repoRoot, cand), "utf8");
      } catch {
        continue;
      }
      if (!tokenRe.test(content)) continue;
      const ov = overrides.find((o) => o.file === chg && (o.test === null || o.test === cand));
      if (ov) {
        notes.push(`override -- ${cand} references ${chg}, cleared: ${ov.reason}`);
      } else {
        const kind = isTestFile(cand) ? "test" : "non-test";
        findings.push(
          `${taskLabel(owningTasks(filesByTask, chg))}: ${cand} (${kind}) references ${chg} but is in no task's Files block -- add it or record an override`
        );
      }
    }
  }

  return {
    findings,
    ok: "ok -- every JS/TS/Python referencer of a changed file is in a Files block or overridden",
    notes,
  };
}

// --scan: the planner's pass while deriving a task's Files block (playbooks/planning-waves.md task
// template). Wider than the gate on purpose -- any text code file, declared symbols as well as the
// basename -- and advisory: it exits 0 whatever it finds, and the gate stays the authority at merge.
export const SCAN_CODE_EXT = new Set([
  ...CODE_EXT, ".cjs", ".cs", ".java", ".kt", ".kts", ".go", ".rs", ".rb", ".php", ".swift", ".scala",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm", ".dart", ".vue", ".svelte", ".fs", ".ex", ".exs", ".lua",
]);

// An auto-extracted name this short or this common matches half of any repo, so it is listed as
// skipped instead of searched. An explicit --symbol is never skipped.
export const SCAN_MIN_SYMBOL = 4;
export const SCAN_STOPLIST = new Set([
  "main", "Main", "init", "test", "Test", "Tests", "self", "this", "that", "class", "type", "enum",
  "value", "name", "data", "item", "index", "default", "constructor", "toString", "equals", "hashCode",
  "setup", "teardown", "start", "stop", "close", "open", "load", "save", "parse", "apply", "call",
  "render", "update", "handle", "string", "number", "boolean", "object", "void",
]);
export const isStoplisted = (name) => name.length < SCAN_MIN_SYMBOL || SCAN_STOPLIST.has(name);

// Line-anchored, so a keyword in a comment or in prose ("// a class that ...") declares nothing.
// Modifiers cover the languages SCAN_CODE_EXT names; a name these miss is passed with --symbol.
const IDENT = "[A-Za-z_$][\\w$]*";
const MODIFIERS =
  "(?:(?:export|default|declare|public|private|protected|internal|abstract|sealed|static|final|open|data|" +
  "inline|async|partial|readonly|unsafe|override|virtual|extern|const|pub(?:\\([^)]*\\))?)\\s+)*";
const DECLARATION_RES = [
  new RegExp(`^[ \\t]*${MODIFIERS}(?:class|interface|struct|enum|record|trait|type|protocol|object|module)\\s+(${IDENT})`, "gm"),
  new RegExp(`^[ \\t]*${MODIFIERS}(?:def|fun|fn|sub|function\\*?|func(?:\\s*\\([^)]*\\))?)\\s+(${IDENT})`, "gm"),
  new RegExp(`^[ \\t]*export\\s+(?:default\\s+)?(?:const|let|var)\\s+(${IDENT})`, "gm"),
  new RegExp(
    `^[ \\t]*(?:\\w+\\s+)*?public\\s+(?:(?:static|final|abstract|virtual|override|async|readonly|sealed|partial|const|new|required)\\s+)*` +
      `(?:[\\w$.<>\\[\\],?]+\\s+)?(${IDENT})\\s*[({=;]`,
    "gm"
  ),
];

// In an ES module only what it exports -- on the declaration or in an `export { a, b as c }` list --
// can be referenced from another file; its other declarations are file-local and would match every
// unrelated file with a helper of the same name.
const ES_EXPORT_RE = /^[ \t]*export\s/m;
const EXPORT_LIST_RE = /^[ \t]*export\s*\{([^}]*)\}/gm;

export function extractSymbols(text) {
  const esModule = ES_EXPORT_RE.test(text);
  const listed = new Set(
    [...text.matchAll(EXPORT_LIST_RE)].flatMap((m) => m[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/)[0]))
  );
  const names = new Set();
  for (const re of DECLARATION_RES)
    for (const m of text.matchAll(re)) if (!esModule || ES_EXPORT_RE.test(m[0]) || listed.has(m[1])) names.add(m[1]);
  return [...names];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const symbolRe = (name) => new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`);
// An inheritance marker right after a declared type's name -- `extends`/`implements`/`inherits`, a
// C#/Kotlin/Swift/C++ `:`, a Python `(` or a Ruby `<` -- with the name before the body opens, so a
// `Print(Shape s)` parameter or an `x: Shape` annotation is a consumer, not a subclass.
const inheritsRe = (name) =>
  new RegExp(
    `\\b(?:class|struct|interface|record|object|protocol|trait|enum)\\s+[\\w$]+(?:\\s*<[^>\\n]*>)?\\s*` +
      `(?:\\(|:|<|\\bextends\\b|\\binherits\\b|\\bimplements\\b)[^{\\n]*?(?<![\\w$])${escapeRe(name)}(?![\\w$])`,
    "m"
  );

function classify(path, content, inherits) {
  if (isTestPath(path)) return "test";
  if (inherits?.test(content)) return "subclass";
  return "consumer";
}

// One entry per changed file, in argument order: whether it is on disk and whether symbols could be
// extracted from its type, the names searched, the auto-extracted names skipped, and per name or
// basename the referencers that matched it, each tagged test, subclass or consumer. A changed file
// that does not exist yet (a task creates it) is matched by name only.
export function scanReferencers({ changed, symbols = [], repoRoot }) {
  const codeFiles = walk(repoRoot)
    .map((p) => relative(repoRoot, p).split(sep).join("/"))
    .filter((p) => SCAN_CODE_EXT.has(extname(p)))
    .sort();
  const contents = new Map();
  const read = (path) => {
    if (!contents.has(path)) {
      let text = null;
      try {
        text = readFileSync(join(repoRoot, path), "utf8");
      } catch {}
      contents.set(path, text);
    }
    return contents.get(path);
  };
  return changed.map((file) => {
    const onDisk = existsSync(join(repoRoot, file));
    const parsed = SCAN_CODE_EXT.has(extname(file));
    const own = parsed && onDisk ? extractSymbols(read(file) ?? "") : [];
    const skipped = own.filter(isStoplisted);
    const names = [...new Set([...own.filter((n) => !isStoplisted(n)), ...symbols])];
    const base = basename(file);
    const stem = base.slice(0, base.length - extname(base).length);
    const matchers = names.map((name) => ({ match: name, re: symbolRe(name), inherits: inheritsRe(name) }));
    // The gate's basename match, plus the stem as the last segment of a quoted path: `from './foo'`
    // names foo.ts. Being path-shaped, the stem skips only the stoplist, not the length rule.
    matchers.push({ match: base, re: new RegExp(`[/.'"\`]${escapeRe(base)}\\b`), inherits: null });
    if (stem && stem !== base) {
      if (SCAN_STOPLIST.has(stem)) skipped.push(stem);
      else matchers.push({ match: stem, re: new RegExp(`/${escapeRe(stem)}['"\`]`), inherits: null });
    }
    const groups = [];
    for (const { match, re, inherits } of matchers) {
      const referencers = [];
      for (const path of codeFiles) {
        if (path === file) continue;
        const content = read(path);
        if (content !== null && re.test(content)) referencers.push({ path, kind: classify(path, content, inherits) });
      }
      if (referencers.length) groups.push({ match, referencers });
    }
    return { file, onDisk, parsed, symbols: names, skipped, groups };
  });
}

export function formatScan(results) {
  const lines = [
    "blast-radius-check: scan (advisory) -- put every referencer below in the task's Files block, or record a Blast-radius override with a reason",
    `referencers are searched only in files ending ${[...SCAN_CODE_EXT].sort().join(", ")}; files of any other type are never read`,
  ];
  for (const { file, onDisk, parsed, symbols, skipped, groups } of results) {
    lines.push(file);
    if (!onDisk) lines.push("  not on disk -- matched by name only");
    else if (!parsed) {
      const ext = extname(file);
      lines.push(`  no symbols extracted from ${ext ? `a ${ext} file` : "a file with no extension"} -- referencers matched by file name only`);
    }
    lines.push(`  symbols: ${symbols.join(", ") || "(none)"}${skipped.length ? ` (skipped: ${skipped.join(", ")})` : ""}`);
    if (groups.length === 0) lines.push("  no referencers found");
    for (const { match, referencers } of groups) {
      lines.push(`  ${match}`);
      for (const { path, kind } of referencers) lines.push(`    ${path} (${kind})`);
    }
  }
  return lines.join("\n");
}

const SCAN_FLAGS = { "--scan": "none", "--symbol": "repeat", "--root": "value" };
const SCAN_USAGE = "usage: node scripts/blast-radius-check.mjs --scan <changed-file>... [--symbol <name>]... [--root <repo-root>]";

// A changed-file argument as a repo-relative POSIX path, or null when it points outside `repoRoot`.
export function normalizeScanPath(raw, repoRoot) {
  const folded = raw.replaceAll("\\", "/");
  const relativePath = isAbsolute(folded) ? relative(resolve(repoRoot), folded).split(sep).join("/") : posix.normalize(folded);
  return relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath) ? null : relativePath;
}

function scanMain(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, SCAN_FLAGS, { allowPositionals: true, requireValues: "nonEmpty" });
  } catch (e) {
    console.error(`blast-radius-check: ${e.message}\n${SCAN_USAGE}`);
    process.exit(1);
  }
  const { flags, positionals } = parsed;
  if (positionals.length === 0) {
    console.error(`blast-radius-check: --scan needs at least one changed file\n${SCAN_USAGE}`);
    process.exit(1);
  }
  const repoRoot = flags["--root"] ?? process.cwd();
  const changed = [];
  for (const raw of positionals) {
    const file = normalizeScanPath(raw, repoRoot);
    if (file === null) {
      console.error(`blast-radius-check: ${raw} is outside the repo root ${repoRoot}`);
      process.exit(1);
    }
    changed.push(file);
  }
  const results = scanReferencers({ changed, symbols: flags["--symbol"] ?? [], repoRoot });
  console.log(formatScan(results));
  process.exit(0);
}

function main() {
  if (process.argv.includes("--scan")) scanMain(process.argv.slice(2));
  const [, , planPath, repoRootArg] = process.argv;
  if (!planPath) {
    console.error(`usage: node scripts/blast-radius-check.mjs <plan-file> [repo-root]\n${SCAN_USAGE}`);
    process.exit(1);
  }
  if (!existsSync(planPath)) {
    console.error(`blast-radius-check: plan file not found: ${planPath}`);
    process.exit(1);
  }
  const repoRoot = repoRootArg || process.cwd();

  const { findings, ok, notes } = blastRadiusLeg(readFileSync(planPath, "utf8"), { planPath, repoRoot });
  for (const n of notes) console.error(`blast-radius-check: ${n}`);
  if (findings.length > 0) {
    for (const f of findings) console.error(`blast-radius-check: ${f}`);
    process.exit(1);
  }
  console.log(`blast-radius-check: ${ok}`);
  process.exit(0);
}

if (isMain(import.meta.url, process.argv[1])) main();
