#!/usr/bin/env node
// Deterministic half of devcycle's dreaming pass: checkpoint, corpus manifest, session
// cap, artifact freshness. The semantic half lives in skills/dreaming-across-sessions.
// Emits no message text — only ids, paths, timestamps, and counts.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { findTranscriptFiles, owningSession, readRecords, inWindow } from "./doctor.mjs";

const CAP = 100;
const dreamDir = (root) => join(root, ".devcycle", "dreaming");
const statePath = (root) => join(dreamDir(root), "state.md");

export function readCheckpoint(repoRoot) {
  const p = statePath(repoRoot);
  if (!existsSync(p)) return { lastDreamedThrough: null, lastArtifact: null };
  const text = readFileSync(p, "utf8");
  const field = (k) => {
    const m = text.match(new RegExp(`^- ${k}:\\s*(.*)$`, "m"));
    const v = m ? m[1].trim() : "";
    return !v || v === "never" || v === "none" ? null : v;
  };
  return { lastDreamedThrough: field("last-dreamed-through"), lastArtifact: field("last-artifact") };
}

export function writeCheckpoint(repoRoot, { lastDreamedThrough, lastArtifact }) {
  mkdirSync(dreamDir(repoRoot), { recursive: true });
  writeFileSync(
    statePath(repoRoot),
    "# dreaming checkpoint\n" +
      `- last-dreamed-through: ${lastDreamedThrough ?? "never"}\n` +
      `- last-artifact: ${lastArtifact ?? "none"}\n`,
  );
}

export function artifactFresh(repoRoot, since) {
  const dir = dreamDir(repoRoot);
  if (!existsSync(dir)) return { fresh: false, path: null };
  const dated = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}-dream\.md$/.test(f))
    .sort();
  const latest = dated.at(-1);
  if (!latest) return { fresh: false, path: null };
  const path = join(dir, latest);
  if (!since) return { fresh: true, path };
  return { fresh: latest.slice(0, 10) >= since.slice(0, 10), path };
}

function archives(repoRoot) {
  const dir = join(repoRoot, ".devcycle");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => /^archive-\d{4}-\d{2}-\d{2}-/.test(d))
    .map((d) => {
      const full = join(dir, d);
      const ev = join(full, "evidence");
      return {
        dir: full,
        date: d.slice("archive-".length, "archive-".length + 10),
        ledger: existsSync(join(full, "ledger.md")) ? join(full, "ledger.md") : null,
        evidenceCount: existsSync(ev) ? readdirSync(ev).length : 0,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function planCorpus({ repoRoot, projectsDir, since, cap = CAP }) {
  const groups = new Map();
  for (const file of findTranscriptFiles(projectsDir)) {
    const id = owningSession(file);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(file);
  }

  const sessions = [];
  for (const [id, files] of groups) {
    const stamps = [];
    let records = 0;
    for (const f of files)
      for (const r of readRecords(f)) {
        records += 1;
        if (r.timestamp) stamps.push(r.timestamp);
      }
    if (!stamps.length) continue;
    stamps.sort();
    const lastTimestamp = stamps.at(-1);
    if (!inWindow(lastTimestamp, since, null)) continue;
    sessions.push({ id, files, firstTimestamp: stamps[0], lastTimestamp, records });
  }

  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  const capped = sessions.length > cap;
  const kept = sessions.slice(0, cap);
  const { fresh, path } = artifactFresh(repoRoot, since);

  return {
    since: since ?? null,
    cap,
    capped,
    sessions: kept,
    archives: archives(repoRoot).filter((a) => inWindow(`${a.date}T23:59:59Z`, since, null)),
    // Escaping rule, owned by devcycle:distilling-learnings: the absolute cwd with every
    // "/" replaced by "-". basename() would silently point at the wrong store.
    memoryDir: join(homedir(), ".claude", "projects", repoRoot.replaceAll("/", "-"), "memory"),
    artifactFresh: fresh,
    artifactPath: path,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const root = process.cwd();
  if (argv.includes("--plan")) {
    const { lastDreamedThrough } = readCheckpoint(root);
    console.log(JSON.stringify(planCorpus({
      repoRoot: root,
      projectsDir: join(homedir(), ".claude", "projects"),
      since: lastDreamedThrough,
    }), null, 2));
    return;
  }
  const i = argv.indexOf("--commit-checkpoint");
  if (i !== -1 && argv[i + 1]) {
    const prev = readCheckpoint(root);
    writeCheckpoint(root, { lastDreamedThrough: argv[i + 1], lastArtifact: prev.lastArtifact });
    console.log("checkpoint: ok");
    return;
  }
  console.error("usage: dream.mjs --plan | --commit-checkpoint <iso>");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
