#!/usr/bin/env node
// The context-depth probe: one transcript's last usage record measured against the observed model's
// window. The depth gate calls this file directly so it no longer loads doctor's import closure;
// `doctor.mjs --depth` stays as an adapter over the same functions.
import { existsSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { claudeConfigHome, resolveEffort } from "./claude-settings.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { eachRecord } from "./jsonl.mjs";
import { isMain } from "./is-main.mjs";
import { ASSUMED_WINDOW, budgetBand, contextDepth, windowFor } from "./depth-bands.mjs";

export { ASSUMED_WINDOW, budgetBand, contextDepth, windowFor };

// Records Claude Code writes for its own placeholders (session-limit notices and the like).
// Every counter on them is zero, so they are skipped outright rather than reported unpriced.
export const SYNTHETIC_MODEL = "<synthetic>";

// Where Claude Code keeps its session transcripts: <config home>/projects.
export function claudeProjectsDir(env = process.env) {
  return join(claudeConfigHome(env), "projects");
}

// Recursively collects .jsonl transcript files under dir. Returns null when dir is simply
// not there (missing, or a path that is not a directory).
export function findTranscriptFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // An absent path is "nothing here", but a permissions or I/O failure is a real fault and
    // must not read as a directory holding no transcripts.
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") throw err;
    return null;
  }
  const files = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...(findTranscriptFiles(p) ?? []));
    else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(p);
  }
  return files;
}

const lastUsageOf = (r) => (r.message?.usage && r.message.model && r.message.model !== SYNTHETIC_MODEL ? r.message : null);

export function transcriptStats(file) {
  let last = null;
  let toolUses = 0;
  let first = null;
  let end = null;
  eachRecord(file, (r) => {
    const t = Date.parse(r.timestamp ?? "");
    if (Number.isFinite(t)) {
      first ??= t;
      end = t;
    }
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) if (c?.type === "tool_use") toolUses += 1;
    last = lastUsageOf(r) ?? last;
  });
  if (!last) return null;
  return {
    depth: contextDepth(last.usage), model: last.model, toolUses,
    durationMs: first !== null && end !== null ? end - first : 0,
  };
}

// Bash calls that print a file into the transcript: `cat`, `head`, `tail`, and `sed` only with `-n`.
const PRINTERS = new Set(["cat", "head", "tail", "sed"]);

// The coordinator's own work files (context pack, plan header, drafts) live under this prefix. A print
// of one is still counted in `reads` (its tokens are in the context) but is not a source print.
const WORK_FILES_PREFIX = ".devcycle/";

// Characters a backslash escapes inside double quotes; before any other it is kept literally.
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);

// Splits a shell command into segments of arguments. Quotes, backslash escapes and heredoc bodies are
// honoured, redirections (and their targets) are dropped, and `;`, `|`, `||`, `&&`, `&` and newlines
// separate segments only outside quotes. A command with an unterminated quote yields no segments.
function shellSegments(command) {
  const segments = [];
  const heredocs = [];
  let args = [];
  let word = null;
  let skipTarget = false;
  const endWord = () => {
    if (word !== null && skipTarget) skipTarget = false;
    else if (word !== null) args.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (args.length) segments.push(args);
    args = [];
  };
  // The index past the line break at i and the body lines of every pending heredoc, each up to its own tag.
  const skipHeredocBodies = (i) => {
    let pos = i + 1;
    for (const { tag, strip } of heredocs.splice(0)) {
      while (pos < command.length) {
        const end = command.indexOf("\n", pos);
        const line = command.slice(pos, end < 0 ? command.length : end);
        pos = end < 0 ? command.length : end + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === tag) break;
      }
    }
    return pos;
  };
  const readHeredocTag = (from) => {
    let i = from;
    let tag = "";
    for (let quote = null; i < command.length; i += 1) {
      const c = command[i];
      if (quote) {
        if (c === quote) quote = null;
        else tag += c;
      } else if (c === "'" || c === '"') quote = c;
      else if (/[\s;|&<>()]/.test(c)) break;
      else tag += c;
    }
    return { tag, end: i };
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return [];
      word = (word ?? "") + command.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      let text = "";
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && DOUBLE_QUOTE_ESCAPES.has(command[i + 1])) i += 1;
        text += command[i];
        i += 1;
      }
      if (i >= command.length) return [];
      word = (word ?? "") + text;
      i += 1;
    } else if (ch === "\\") {
      if (command[i + 1] !== "\n") word = (word ?? "") + (command[i + 1] ?? "");
      i += 2;
    } else if (ch === "\n") {
      endSegment();
      i = skipHeredocBodies(i);
    } else if (ch === ";" || ch === "|" || (ch === "&" && command[i + 1] !== ">")) {
      endSegment();
      while (command[i] === ch) i += 1;
    } else if (ch === "<" || ch === ">" || ch === "&") {
      if (word !== null && /^\d+$/.test(word)) word = null; // the file-descriptor prefix of `2>`
      else endWord();
      if (command.startsWith("<<", i) && command[i + 2] !== "<") {
        const strip = command[i + 2] === "-";
        let from = i + (strip ? 3 : 2);
        while (command[from] === " " || command[from] === "\t") from += 1;
        const { tag, end } = readHeredocTag(from);
        heredocs.push({ tag, strip });
        i = end;
      } else {
        while (command[i] === "<" || command[i] === ">" || command[i] === "&") i += 1;
        skipTarget = true;
      }
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      i += 1;
    } else {
      word = (word ?? "") + ch;
      i += 1;
    }
  }
  endSegment();
  return segments;
}

// The files one shell segment prints, or [] when it is not a source print.
function printedFiles([command, ...args]) {
  if (!PRINTERS.has(command)) return [];
  const files = [];
  let quiet = false;
  let scriptPending = command === "sed";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (command === "sed" && /^-[A-Za-z]+$/.test(arg)) {
      // A short-flag cluster such as -n, -En or -ne; -e and -f take the rest of the cluster, or the next word.
      for (let k = 1; k < arg.length; k += 1) {
        if (arg[k] === "n") quiet = true;
        else if (arg[k] === "e" || arg[k] === "f") {
          if (k === arg.length - 1) i += 1;
          scriptPending = false;
          break;
        }
      }
    } else if ((command === "head" || command === "tail") && (arg === "-n" || arg === "-c")) i += 1;
    else if (arg.startsWith("-")) continue;
    else if (scriptPending) scriptPending = false;
    else if (arg) files.push(arg);
  }
  return command === "sed" && !quiet ? [] : files;
}

const resultText = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.reduce((text, c) => text + (c?.type === "text" && typeof c.text === "string" ? c.text : ""), "") : "");

// A path as the agent saw it: relative to its working directory when inside it, else absolute.
function readKey(path, cwd) {
  if (typeof cwd !== "string" || !cwd) return path;
  const absolute = resolve(cwd, path);
  const inside = relative(cwd, absolute);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : absolute;
}

// What one transcript read: how many Bash calls printed a source file, and the estimated tokens
// (characters / 4) each path's Read or print results put into the context.
export function transcriptReads(file) {
  let sourcePrints = 0;
  const reads = new Map();
  const pending = new Map();
  eachRecord(file, (r) => {
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (c?.type === "tool_use" && c.name === "Read" && typeof c.input?.file_path === "string")
        pending.set(c.id, [readKey(c.input.file_path, r.cwd)]);
      else if (c?.type === "tool_use" && c.name === "Bash" && typeof c.input?.command === "string") {
        const keys = shellSegments(c.input.command).flatMap(printedFiles).map((f) => readKey(f, r.cwd));
        if (!keys.length) continue;
        if (keys.some((k) => !k.startsWith(WORK_FILES_PREFIX))) sourcePrints += 1;
        pending.set(c.id, keys);
      } else if (c?.type === "tool_result" && pending.has(c.tool_use_id)) {
        const paths = pending.get(c.tool_use_id);
        pending.delete(c.tool_use_id);
        const share = Math.ceil(resultText(c.content).length / 4 / paths.length);
        for (const p of paths) reads.set(p, (reads.get(p) ?? 0) + share);
      }
    }
  });
  // A Map while counting, so a path named like an Object.prototype member cannot collide with it.
  return { sourcePrints, reads: Object.fromEntries(reads) };
}

// CLAUDE_DOCTOR_PROJECTS overrides the transcript root; it exists so the probe is testable
// without writing into the real ~/.claude. It defaults to claudeProjectsDir.
export function resolveTranscript(env, cwd, { agentId } = {}) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new Error("CLAUDE_CODE_SESSION_ID is not set — cannot identify this session");
  const root = env.CLAUDE_DOCTOR_PROJECTS || claudeProjectsDir(env);
  const name = agentId ? `agent-${agentId}.jsonl` : `${id}.jsonl`;

  // 1. cwd slug, 2. a filename search for a session whose cwd moved after it started.
  const slugDir = join(root, cwd.replaceAll("/", "-"));
  const direct = agentId ? join(slugDir, id, "subagents", name) : join(slugDir, name);
  const file = existsSync(direct) ? direct : (findTranscriptFiles(root) ?? []).find((f) => basename(f) === name);
  if (!file) throw new Error(`no transcript found for ${agentId ? `agent ${agentId} of ` : ""}session ${id} under ${root}`);
  return file;
}

const measured = (depth, model) => {
  const w = windowFor(model);
  // An unknown depth is never evidence of a shallow one: fail the probe rather than band it.
  if (!w) {
    throw new Error(`no context window known for ${model} (not priced, and older than its ` +
      `family's newest priced model; add it to scripts/pricing.mjs) — ${depth} tokens, band unknown`);
  }
  return { depth, model, ...w, fraction: depth / w.window, band: budgetBand(depth, w.window) };
};

export function resolveDepth(env, cwd, { agentId } = {}) {
  const file = resolveTranscript(env, cwd, { agentId });
  let last = null;
  // The "usage" substring is a cheap pre-filter: most transcript lines are not assistant turns with a
  // usage block, and a rejected line costs no parse. eachRecord streams the file in chunks, so no
  // whole-file string is held however long the session is. A torn trailing line (transcripts are
  // appended live) fails to parse and is skipped by the reader.
  eachRecord(file, (r) => { last = lastUsageOf(r) ?? last; }, { lineFilter: (line) => line.includes('"usage"') });
  if (!last) throw new Error(`no usage record in ${basename(file)} — nothing to measure`);
  return measured(contextDepth(last.usage), last.model);
}

export function depthLine(r) {
  const pct = (r.fraction * 100).toFixed(1);
  const assumed = r.windowProvisionalAs
    ? `, window assumed from ${r.windowProvisionalAs}`
    : r.windowAssumed ? ", window assumed — model not in scripts/pricing.mjs" : "";
  return `depth: ${r.depth} tokens (${pct}% of ${r.window}, model ${r.model}${assumed}) — band: ${r.band}`;
}

function main(argv) {
  let r;
  let json = false;
  try {
    const { flags } = parseFlags(argv, { "--agent": "value", "--transcript": "value", "--json": "none" });
    json = "--json" in flags;
    const file = requireValue(flags, "--transcript");
    const agentId = requireValue(flags, "--agent", "an agent id");
    if (file) {
      // transcriptStats reads a missing file as an empty one, which would misreport a typo'd path.
      if (!existsSync(file)) throw new Error(`transcript not found: ${file}`);
      const s = transcriptStats(file);
      if (!s) throw new Error(`no usage record in ${basename(file)} — nothing to measure`);
      r = measured(s.depth, s.model);
    } else {
      r = resolveDepth(process.env, process.cwd(), { agentId });
    }
  } catch (e) {
    console.error(`depth-probe: ${e.message}`);
    process.exit(1);
  }
  // The drive row records this effort beside the model (references/drive.md § Drive actions).
  if (json) {
    const { effort, problem } = resolveEffort({ env: process.env, cwd: process.cwd(), model: r.model });
    r = { ...r, effort, effortProblem: problem ?? null };
  }
  console.log(json ? JSON.stringify(r) : depthLine(r));
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
