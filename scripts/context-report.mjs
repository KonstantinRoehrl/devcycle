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
import { parseFlags, requireValue } from "./cli-flags.mjs";

const SURFACE_DIRS = ["commands", "playbooks", "references"];
const PREFIXED = /\$\{CLAUDE_PLUGIN_ROOT\}\/((?:references|playbooks|commands)\/[A-Za-z0-9._-]+\.md)/g;

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

const prefixedCounts = (text) => {
  const counts = new Map();
  for (const m of (text ?? "").matchAll(PREFIXED)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
};

const bareLines = (text, target) =>
  (text ?? "").split("\n").flatMap((l, i) => (l.replace(PREFIXED, "").includes(target) ? [i + 1] : []));

export function diffSince(root, ref) {
  if (git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status !== 0)
    throw new Error(`unknown git ref "${ref}"`);
  const listed = git(root, ["ls-tree", "-r", "--name-only", ref, "--", ...SURFACE_DIRS]);
  const before = gitReader(root, ref);
  const now = diskReader(root);
  const files = [
    ...new Set([...listed.stdout.split("\n").filter((p) => p.endsWith(".md")), ...SURFACE_DIRS.flatMap((d) => listMd(root, d))]),
  ].sort();
  const lostPrefixes = [];
  for (const file of files) {
    const was = prefixedCounts(before(file));
    const is = prefixedCounts(now(file));
    for (const [target, n] of was) {
      const left = is.get(target) ?? 0;
      if (left < n) lostPrefixes.push({ file, target, before: n, after: left, bareLines: bareLines(now(file), target) });
    }
  }
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
    console.log(`  ${l.file}  ${l.target}  ${l.before} → ${l.after}  bare at ${l.bareLines.join(", ") || "(removed)"}`);
  console.log(`\ndropped from closures since ${diff.ref}:`);
  for (const d of diff.dropped)
    console.log(`  ${d.file}  refs-only: ${d.refsOnly.join(", ") || "none"}  all-hops: ${d.allHops.join(", ") || "none"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
