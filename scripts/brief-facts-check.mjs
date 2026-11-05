#!/usr/bin/env node
// Plan gate leg `briefFacts` (#334): what a task brief cites about the repo holds before anything is
// dispatched. Every cited path resolves and every cited line is within its file, or a
// `- Citation override:` line says why not; a call-shaped span nothing defines is a note.
// See playbooks/planning-waves.md item 8.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { taskBlocks, filesFieldValue, extractFiles, createdFiles, testFiles, lineFences } from "./task-files.mjs";
import { LINE_REF_RE } from "./authored-claims-check.mjs";
import { GRAMMAR_DIRS, PLUGIN_ROOT_PATH } from "./citation-grammar.mjs";
import { isMain } from "./is-main.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPAN_RE = /(?<!`)`([^`\n]+)`(?!`)/g;
// Path characters only, at least one `/`, a final `.ext`: a placeholder, glob, URL, `$` expression,
// `~` or absolute path never reads as one. `./` and `../` start an import specifier, which resolves
// against its source file, not the repo root.
const PATH_SPAN_RE = /^(?!\.\.?\/)([\w.[\]-]+(?:\/[\w.[\]-]+)+\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?$/;
const CALL_SPAN_RE = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\([^()]*\)$/;
const OVERRIDE_START = /^\s*-\s*Citation override:/;
const OVERRIDE_RE = /^\s*-\s*Citation override:\s*`?([^\s`]+)`?\s*—\s*(.*\S)\s*$/;

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const who = (task) => (task === null ? "Plan" : `Task ${task}`);
const escapeRe = (s) => s.replace(/[$]/g, "\\$&");
const definedIn = (fencedText, name) =>
  new RegExp(String.raw`(?:\b(?:function\*?|class|const|let|var|def|fn|func)\s+${escapeRe(name)}\b|^\s*(?:async\s+)?${escapeRe(name)}\s*\([^)]*\)\s*\{)`, "m").test(fencedText);

// The task whose own brief holds each plan line, or null outside every task.
function taskOfLine(planText) {
  const owners = planText.split("\n").map(() => null);
  let from = 0;
  for (const { num, text } of taskBlocks(planText, { stopAtPlanSection: true })) {
    const start = planText.indexOf(text, from);
    const first = planText.slice(0, start).split("\n").length - 1;
    for (let i = first; i < first + lineCount(text); i++) owners[i] = num;
    from = start + 1;
  }
  return owners;
}

// One spawn per plan. Outside a work tree check-ignore exits 128, and nothing counts as ignored.
function ignoredPaths(paths, repoRoot) {
  if (paths.length === 0) return new Set();
  const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], { cwd: repoRoot, input: paths.join("\0"), encoding: "utf8" });
  return r.status === 0 ? new Set(r.stdout.split("\0").filter(Boolean)) : new Set();
}

// The names some working-tree file other than the plan holds as a whole word, in one spawn; null
// when git cannot answer, which silences every note.
function namesInTree(names, { repoRoot, planPath }) {
  if (names.length === 0) return new Set();
  const plan = relative(repoRoot, resolve(planPath));
  const exclude = plan.startsWith("..") ? [] : [`:(exclude)${plan}`];
  const r = spawnSync("git", ["grep", "--untracked", "-I", "-h", "-o", "-w", "-F", ...names.flatMap((n) => ["-e", n]), "--", ".", ...exclude],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 1) return new Set();
  return r.status === 0 ? new Set(r.stdout.split("\n").filter(Boolean)) : null;
}

export function briefFactsLeg(planText, { planPath, repoRoot = process.cwd() }) {
  const lines = planText.split("\n");
  const fences = lineFences(planText);
  const taskOf = taskOfLine(planText);
  const blocks = taskBlocks(planText);
  // A Test path counts as created: a new test file is listed under Test:, not Create:.
  const created = new Set(blocks.flatMap(({ text }) => {
    const files = filesFieldValue(text) ?? "";
    return [...createdFiles(files), ...testFiles(files)];
  }));
  const findings = [];
  const notes = [];

  // (task, path) → how it was cited. A Files-block path never falls back to the plugin root: a host
  // plan's `scripts/build.mjs` is a host edit, and the plugin ships its own scripts/.
  const cited = new Map();
  const cite = (task, path, { files = false, plugin = false }) => {
    const prior = cited.get(`${task}\0${path}`);
    cited.set(`${task}\0${path}`, { task, path, files: files || Boolean(prior?.files), plugin: plugin || Boolean(prior?.plugin) });
  };
  for (const { num, text } of blocks) for (const path of extractFiles(filesFieldValue(text) ?? "")) cite(num, path, { files: true });

  const overrides = new Map();
  const bounds = [];
  const calls = new Map();
  lines.forEach((line, i) => {
    if (fences[i]) return;
    if (OVERRIDE_START.test(line)) {
      const m = line.match(OVERRIDE_RE);
      if (m) overrides.set(m[1], m[2]);
      else findings.push(`malformed Citation override (needs "<path> — <reason>"): ${line.trim()}`);
      return;
    }
    for (const [, span] of line.matchAll(SPAN_RE)) {
      const prefixed = span.match(PLUGIN_ROOT_PATH);
      const path = (prefixed ? prefixed[2] : span).match(PATH_SPAN_RE)?.[1];
      if (path) cite(taskOf[i], path, { plugin: Boolean(prefixed) || GRAMMAR_DIRS.includes(path.split("/")[0]) });
      const call = span.match(CALL_SPAN_RE)?.[1];
      if (call && !calls.has(call)) calls.set(call, taskOf[i]);
    }
    for (const m of line.matchAll(LINE_REF_RE)) bounds.push({ task: taskOf[i], path: m[1], last: Number(m[0].match(/(\d+)$/)[1]) });
  });

  const report = (token, text) => {
    const reason = overrides.get(token) ?? overrides.get(token.replace(/:\d+$/, ""));
    if (reason) notes.push(`override -- ${token} cleared: ${reason}`);
    else findings.push(text);
  };
  const exists = (root, path) => existsSync(join(root, path));
  const unresolved = [...cited.values()].filter(({ path, files, plugin }) =>
    !exists(repoRoot, path) && !(plugin && !files && exists(PLUGIN_ROOT, path)) && !created.has(path));
  const ignored = ignoredPaths([...new Set(unresolved.map(({ path }) => path))], repoRoot);
  for (const { task, path } of unresolved)
    if (!ignored.has(path)) report(path, `${who(task)}: cites ${path} — not in the working tree and no task creates it`);

  const reported = new Set();
  for (const { task, path, last } of bounds) {
    const file = join(repoRoot, path);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const count = lineCount(readFileSync(file, "utf8"));
    const key = `${task}\0${path}:${last}`;
    if (last <= count || reported.has(key)) continue;
    reported.add(key);
    report(`${path}:${last}`, `${who(task)}: cites ${path}:${last} — the file has ${count} lines`);
  }

  const fencedText = lines.filter((_, i) => fences[i]).join("\n");
  const undefinedCalls = [...calls.keys()].filter((name) => !definedIn(fencedText, name));
  const inTree = namesInTree(undefinedCalls, { repoRoot, planPath });
  for (const name of inTree ? undefinedCalls.filter((n) => !inTree.has(n)) : [])
    notes.push(`${who(calls.get(name))}: names ${name}() — no working-tree file mentions it and no fenced block in the plan defines it`);

  return { findings, ok: `ok — every path and line ${planPath} cites resolves`, notes };
}

function main() {
  const [, , planPath, repoRoot = process.cwd()] = process.argv;
  if (!planPath) {
    console.error("usage: node scripts/brief-facts-check.mjs <plan-path> [repo-root]");
    process.exit(1);
  }
  if (!existsSync(planPath)) {
    console.error(`brief-facts-check: plan file not found: ${planPath}`);
    process.exit(1);
  }
  const { findings, ok, notes } = briefFactsLeg(readFileSync(planPath, "utf8"), { planPath, repoRoot });
  for (const n of notes) console.error(`brief-facts-check: note: ${n}`);
  for (const f of findings) console.error(`brief-facts-check: ${f}`);
  if (findings.length > 0) process.exit(1);
  console.log(`brief-facts-check: ${ok}`);
}

if (isMain(import.meta.url, process.argv[1])) main();
