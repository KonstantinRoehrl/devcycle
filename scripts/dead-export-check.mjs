#!/usr/bin/env node
// Reports exported symbols under scripts/ and workflows/ that NO non-test module imports —
// the "production-dead, maybe still tested" signal the maintain pre-pass's dead-code
// criterion needs. Tests do not count as use, by design: an export whose only importer is a
// test file is reported.
//
// ADVISORY, NOT A GATE. Findings print to stdout and the script exits 0; a non-zero exit is
// reserved for abort() (corpus unreadable), so the maintain pre-pass can tell a produced fact
// from an unreachable tool (playbooks/maintaining-the-repo.md step 4). Do NOT change this to
// exit 1 on findings to match duplication-check.mjs — that script is a gate; this one is a
// fact-gatherer.
//
// We flag exported SYMBOLS, never whole modules, so a CLI entry point invoked as
// `node scripts/x.mjs` (never imported) is never itself flagged; only its individual exports
// unused by production code are reported. Orphan-file detection is out of scope.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const EXPORT_DIRS = ["scripts", "workflows"];
const args = process.argv.slice(2);
const KNOWN_FLAGS = { "--dir": "value" };
const root = process.cwd();

let explicitDir = null;
try {
  const { flags } = parseFlags(args, KNOWN_FLAGS);
  explicitDir = requireValue(flags, "--dir") ?? null;
} catch (err) {
  console.error(`dead-export-check: ${err.message}`);
  process.exit(1);
}
const scanRoot = explicitDir ? resolve(explicitDir) : root;

const abort = (m) => {
  console.error(`dead-export-check: ${m}`);
  process.exit(1);
};

// Sorted recursive walk of *.mjs / *.js under dir; a dir that cannot be listed aborts.
function collectSources(dir) {
  const out = [];
  let names;
  try {
    names = [...readdirSync(dir)].sort();
  } catch (e) {
    abort(`cannot read ${dir}: ${e.message}`);
  }
  for (const name of names) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectSources(p));
    else if (p.endsWith(".mjs") || p.endsWith(".js")) out.push(p);
  }
  return out;
}

const isTest = (absPath) =>
  relative(scanRoot, absPath).split(sep).includes("tests") ||
  /\.test\.(mjs|js)$/.test(absPath);

// Exported names (regex-based; no AST). Handles export function/const/let/var/class NAME,
// export { A, B as C } (exported name — C), and export default.
function parseExports(src) {
  const names = new Set();
  const decl = /^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(decl)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s+\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)/.exec(t);
      names.add(as ? as[1] : t.split(/\s+/)[0]);
    }
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add("default");
  return names;
}

// Import statements (static + dynamic). Returns [{ spec, names, namespace, dynamic }].
// A named import contributes the target's export names; a default import contributes "default";
// a namespace import or a static-string dynamic import sets namespace:true (all exports used);
// a non-static dynamic import sets spec:null, dynamic:true (attributes nothing).
function parseImports(src) {
  const out = [];
  for (const m of src.matchAll(/import\s+([^;'"]*?)\s+from\s*["']([^"']+)["']/g)) {
    const clause = m[1];
    const spec = m[2];
    const names = [];
    const namespace = /\*\s*as\s+[\w$]+/.test(clause);
    const braced = /\{([^}]*)\}/.exec(clause);
    if (braced) {
      for (const part of braced[1].split(",")) {
        const t = part.trim();
        if (t) names.push(t.split(/\s+/)[0]); // imported (target export) name, before `as`
      }
    }
    const trimmed = clause.trimStart();
    const lead = /^([\w$]+)\s*(?:,|$)/.exec(trimmed);
    if (lead && !trimmed.startsWith("{") && !trimmed.startsWith("*")) names.push("default");
    out.push({ spec, names, namespace, dynamic: false });
  }
  for (const m of src.matchAll(/import\s*\(\s*(?:["']([^"']+)["']|([^)]*))\)/g)) {
    if (m[1] !== undefined) out.push({ spec: m[1], names: [], namespace: true, dynamic: false });
    else out.push({ spec: null, names: [], namespace: false, dynamic: true });
  }
  return out;
}

const resolveSpec = (fromDir, spec) =>
  spec && spec.startsWith(".") ? resolve(fromDir, spec) : null; // relative specs only

// Collect non-test sources under scripts/ + workflows/ — both the export sites and the
// (production) use sites. Tests live under tests/ and are never scanned, which is what makes
// "tests do not count as use" true by construction.
const sources = [];
for (const dirName of [...EXPORT_DIRS].sort()) {
  const abs = join(scanRoot, dirName);
  if (!existsSync(abs)) continue;
  for (const file of collectSources(abs)) if (!isTest(file)) sources.push(file);
}
if (sources.length === 0)
  abort(`no exporting modules under ${EXPORT_DIRS.map((d) => join(scanRoot, d)).join(", ")}`);

const modules = new Map(); // absPath -> { names, namespaceUsed, usedNames }
for (const file of sources)
  modules.set(file, { names: parseExports(readFileSync(file, "utf8")), namespaceUsed: false, usedNames: new Set() });

const notes = [];
for (const file of sources) {
  for (const imp of parseImports(readFileSync(file, "utf8"))) {
    if (imp.dynamic) {
      notes.push(`${relative(root, file)}: unresolved dynamic import`);
      continue;
    }
    const target = resolveSpec(dirname(file), imp.spec);
    if (!target || !modules.has(target)) continue;
    const mod = modules.get(target);
    if (imp.namespace) mod.namespaceUsed = true;
    else for (const n of imp.names) mod.usedNames.add(n);
  }
}

const dead = [];
for (const [file, mod] of [...modules].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (mod.namespaceUsed) continue;
  for (const name of [...mod.names].sort())
    if (!mod.usedNames.has(name)) dead.push(`${relative(root, file)}:${name}`);
}

const moduleCount = modules.size;
const exportCount = [...modules.values()].reduce((n, m) => n + m.names.size, 0);
if (dead.length) {
  console.log(`dead-export-check: ${dead.length} export(s) with no non-test importer`);
  for (const d of dead) console.log(`  - ${d}`);
} else {
  console.log(`dead-export-check: ok (${exportCount} export(s) across ${moduleCount} module(s); 0 dead)`);
}
for (const n of [...new Set(notes)].sort()) console.log(`  - ${n}`);
process.exit(0);
