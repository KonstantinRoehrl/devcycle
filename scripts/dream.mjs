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

const promoDir = (root) => join(root, "docs", "devcycle", "promotions");
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export function recordPromotion(repoRoot, rec) {
  mkdirSync(promoDir(repoRoot), { recursive: true });
  let path = join(promoDir(repoRoot), `${rec.landed}-${slugify(rec.title)}.md`);
  for (let n = 2; existsSync(path); n++)
    path = join(promoDir(repoRoot), `${rec.landed}-${slugify(rec.title)}-${n}.md`);
  writeFileSync(
    path,
    `# ${rec.title}\n` +
      `- promotion-type: ${rec.promotionType}\n` +
      `- cluster-signature: ${rec.clusterSignature}\n` +
      `- files-touched: ${rec.filesTouched.join(", ")}\n` +
      `- landed: ${rec.landed}\n` +
      `- commit: ${rec.commit}\n`,
  );
  return path;
}

export function readPromotions(repoRoot) {
  const dir = promoDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const get = (k) => (text.match(new RegExp(`^- ${k}:\\s*(.*)$`, "m")) ?? [, ""])[1].trim();
      return {
        title: (text.match(/^# (.*)$/m) ?? [, ""])[1].trim(),
        promotionType: get("promotion-type"),
        clusterSignature: get("cluster-signature"),
        filesTouched: get("files-touched").split(",").map((s) => s.trim()).filter(Boolean),
        landed: get("landed"),
        commit: get("commit"),
      };
    });
}

const words = (s) => new Set(s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []);

export function checkRecurrence(promotions, manifest, readText = defaultReadText) {
  const out = [];
  for (const p of promotions) {
    const sig = words(p.clusterSignature);
    if (!sig.size) continue;
    const hits = [];
    for (const s of manifest.sessions) {
      if (s.lastTimestamp.slice(0, 10) <= p.landed) continue;
      const seen = words(readText(s));
      let shared = 0;
      for (const w of sig) if (seen.has(w)) shared += 1;
      if (shared / sig.size >= 0.6) hits.push(s.id);
    }
    if (hits.length) out.push({ clusterSignature: p.clusterSignature, landed: p.landed, hits });
  }
  return out;
}

function defaultReadText(session) {
  return session.files.map((f) => readFileSync(f, "utf8")).join("\n");
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
  const r = argv.indexOf("--record-promotion");
  if (r !== -1 && argv[r + 1]) {
    console.log(recordPromotion(root, JSON.parse(argv[r + 1])));
    return;
  }
  if (argv.includes("--check-recurrence")) {
    const { lastDreamedThrough } = readCheckpoint(root);
    const manifest = planCorpus({
      repoRoot: root,
      projectsDir: join(homedir(), ".claude", "projects"),
      since: lastDreamedThrough,
    });
    console.log(JSON.stringify(checkRecurrence(readPromotions(root), manifest), null, 2));
    return;
  }
  console.error(
    "usage: dream.mjs --plan | --commit-checkpoint <iso> | --record-promotion <json> | --check-recurrence",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
