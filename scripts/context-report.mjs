#!/usr/bin/env node
// Per-entry-point context cost: for every command and playbook, the files, words and bytes of its
// refs-only closure (what validate.mjs check 15 gates, in bytes) and its all-hops closure (every
// prefixed citation followed; reported only). --diff <ref> adds the over-demotion worklist: every
// citation that lost its prefix since <ref>, and every file that left a closure.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { closure, diskReader } from "./context-closure.mjs";
import { GRAMMAR_DIRS, PREFIXED } from "./citation-grammar.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const listMd = (root, dir) =>
  existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`) : [];

export const entryPoints = (root) => [...listMd(root, "commands"), ...listMd(root, "playbooks")];

const figures = ({ files, words, bytes }) => ({ files: files.length, words, bytes });

export function report(root, read = diskReader(root), entries = entryPoints(root)) {
  return entries.map((file) => ({
    file,
    refsOnly: figures(closure(file, { follow: "refs", read })),
    allHops: figures(closure(file, { follow: "all", read })),
  }));
}

const git = (root, args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

function gitReader(root, ref) {
  const cache = new Map();
  return (rel) => {
    if (!cache.has(rel)) {
      const r = git(root, ["show", `${ref}:${rel}`]);
      cache.set(rel, r.status === 0 ? r.stdout : null);
    }
    return cache.get(rel);
  };
}

// One line's citations: its prefixed targets, how often each target sits bare, and its text with
// every prefix dropped — the key that recognises the line again once a prefix is removed.
const PREFIX = "${CLAUDE_PLUGIN_ROOT}/";
const citationLines = (text) =>
  (text ?? "").split("\n").map((l, i) => {
    const rest = l.replace(PREFIXED, "");
    return {
      line: i + 1,
      key: l.replaceAll(PREFIX, "").replace(/\s+/g, " ").trim(),
      prefixed: [...l.matchAll(PREFIXED)].map((m) => m[1]),
      bare: (target) => rest.split(target).length - 1,
    };
  });

const words = (key) => new Set(key.toLowerCase().split(/\s+/).map((w) => w.replace(/^\W+|\W+$/g, "")).filter(Boolean));
const overlap = (a, b) => {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared || 1);
};

// Matched per citation, never by count: a prefix dropped on one line and added on another for the
// same target is still a demotion. In order: a citation whose line is unchanged but for the prefix
// is kept or demoted in place; one whose line was reworded pairs with the most similar line that
// still names the target, prefixed or bare — a tie counts as bare — and is kept or lost there; a
// citation no line names any more is lost at none.
function lostCitations(file, beforeText, nowText) {
  const now = citationLines(nowText).map((l) => ({ ...l, bareTaken: new Map() }));
  const takePrefixed = (l, target) => {
    const i = l.prefixed.indexOf(target);
    if (i !== -1) l.prefixed.splice(i, 1);
    return i !== -1;
  };
  const takeBare = (l, target) => {
    const taken = l.bareTaken.get(target) ?? 0;
    if (taken >= l.bare(target)) return false;
    l.bareTaken.set(target, taken + 1);
    return true;
  };
  const lost = [];
  const loseAt = (c, at) => lost.push({ file, target: c.target, beforeLine: c.beforeLine, line: at ? at.line : null });
  const reworded = [];
  for (const c of citationLines(beforeText).flatMap((b) => b.prefixed.map((target) => ({ target, beforeLine: b.line, key: b.key })))) {
    if (now.some((l) => l.key === c.key && takePrefixed(l, c.target))) continue;
    const inPlace = now.find((l) => l.key === c.key && takeBare(l, c.target));
    if (inPlace) loseAt(c, inPlace);
    else reworded.push(c);
  }
  for (const c of reworded) {
    const was = words(c.key);
    const unclaimedBare = (l) => (l.bareTaken.get(c.target) ?? 0) < l.bare(c.target);
    let best = null;
    for (const l of now) {
      const prefixed = l.prefixed.includes(c.target);
      if (!prefixed && !unclaimedBare(l)) continue;
      const score = overlap(was, words(l.key));
      if (!best || score > best.score || (score === best.score && !prefixed)) best = { l, score, prefixed };
    }
    if (!best) loseAt(c, null);
    else if (best.prefixed) takePrefixed(best.l, c.target);
    else {
      takeBare(best.l, c.target);
      loseAt(c, best.l);
    }
  }
  return lost.sort((a, b) => a.beforeLine - b.beforeLine);
}

export function diffSince(root, ref) {
  if (git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0)
    throw new Error(`unknown git ref "${ref}"`);
  const listed = git(root, ["ls-tree", "-r", "--name-only", ref, "--", ...GRAMMAR_DIRS]);
  const before = gitReader(root, ref);
  const now = diskReader(root);
  const files = [
    ...new Set([...listed.stdout.split("\n").filter((p) => p.endsWith(".md")), ...GRAMMAR_DIRS.flatMap((d) => listMd(root, d))]),
  ].sort();
  const lostPrefixes = files.flatMap((file) => lostCitations(file, before(file), now(file)));
  const dropped = [];
  for (const file of entryPoints(root)) {
    if (before(file) === null) continue;
    const gone = (follow) => {
      const kept = new Set(closure(file, { follow, read: now }).files);
      return closure(file, { follow, read: before }).files.filter((f) => !kept.has(f));
    };
    const refsOnly = gone("refs");
    const allHops = gone("all");
    if (refsOnly.length || allHops.length) dropped.push({ file, refsOnly, allHops });
  }
  return { ref, lostPrefixes, dropped };
}

function usage(message) {
  console.error(`context-report: ${message}`);
  console.error("context-report: usage: context-report.mjs [--json] [--diff <git-ref>]");
  process.exit(1);
}

function main(argv) {
  let flags;
  let ref;
  try {
    ({ flags } = parseFlags(argv, { "--json": "none", "--diff": "value" }));
    ref = requireValue(flags, "--diff", "a git ref");
  } catch (err) {
    usage(err.message);
  }
  const root = process.cwd();
  const entries = report(root);
  let diff;
  if (ref !== undefined) {
    try {
      diff = diffSince(root, ref);
    } catch (err) {
      usage(err.message);
    }
  }
  if (flags["--json"]) {
    process.stdout.write(JSON.stringify(diff ? { entries, diff } : { entries }) + "\n");
    return;
  }
  console.log("context report — per entry point (check 15 gates refs-only, in bytes; all-hops is reported only)");
  for (const e of entries)
    console.log(
      `${e.file}  refs-only: ${e.refsOnly.files} files / ${e.refsOnly.words} words / ${e.refsOnly.bytes} bytes   ` +
        `all-hops: ${e.allHops.files} files / ${e.allHops.words} words`
    );
  if (!diff) return;
  console.log(`\nlost prefixes since ${diff.ref}:`);
  for (const l of diff.lostPrefixes)
    console.log(`  ${l.file}:${l.beforeLine}  ${l.target}  ${l.line === null ? "removed" : `bare at line ${l.line}`}`);
  console.log(`\ndropped from closures since ${diff.ref}:`);
  for (const d of diff.dropped)
    console.log(`  ${d.file}  refs-only: ${d.refsOnly.join(", ") || "none"}  all-hops: ${d.allHops.join(", ") || "none"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
