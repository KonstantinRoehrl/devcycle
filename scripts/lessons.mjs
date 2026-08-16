#!/usr/bin/env node
// The r2 rung's three stores and the cap that keeps them finite: the repo's committed
// docs/devcycle/lessons.md, the user's per-repo store, and the user's global store. Reads and
// merges for a stage; proposes an eviction when a section is full. Never writes: the caller
// screens the text first (a user store is written outside the repo, where git's own guards
// do not reach).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { repoSlug } from "./run-record.mjs";
import { findPromotionById } from "./promotions.mjs";

export const SECTION_CAP = 15;

// Spec §7's always-loaded byte budget. The ceiling is the committed r2 store's current byte count
// (`wc -c docs/devcycle/lessons.md`, 0 while the store has no landed lessons yet) plus one
// section's headroom (SECTION_CAP × ~80 bytes/line ≈ 1200), so the first net growth beyond a
// single section requires a same-run retirement to make room.
export const ALWAYS_LOADED_CEILING = 1200;

// A run may grow the always-loaded surface past the ceiling only when it also retires a lesson in
// the same run — otherwise the store ratchets up forever. `netBytes` is the net bytes this run
// adds to the landed r2 store (QC6: it gates that surface alone, and knows nothing about mining or
// dreaming depth); `hasRetirement` is whether this run retires a lesson.
export function budgetStatus(netBytes, hasRetirement) {
  return { netBytes, withinBudget: netBytes <= ALWAYS_LOADED_CEILING || hasRetirement };
}

// The same enum tests/fixtures/run-record.schema.json declares, in the same order. Restated here
// rather than imported because that file is a JSON fixture, not a module — but any change there
// must be mirrored here, which tests/unit/lessons.test.mjs pins.
export const STAGES = [
  "scoping", "audit", "diagnosis", "brainstorm", "planning", "execution",
  "branch-review", "on-device", "fast-path", "sweep", "finish",
];

const learningsRoot = () =>
  process.env.DEVCYCLE_LEARNINGS_DIR ?? join(homedir(), ".claude", "devcycle", "learnings");

export const repoStorePath = (repoRoot) => join(repoRoot, "docs", "devcycle", "lessons.md");
export const userRepoStorePath = (repoRoot) => join(learningsRoot(), repoSlug(repoRoot), "lessons.md");
export const userGlobalStorePath = () => join(learningsRoot(), "global", "lessons.md");

const LESSON_RE = /^- .+ \[[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*\]$/;
export const lessonId = (line) => (line.match(/\[([^\]]+)\]\s*$/) ?? [, null])[1];

// A store that does not exist is empty — the normal state of every repo before its first landing,
// and of the user stores for anyone who has never chosen `just-me`.
export function readSection(path, stage) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${stage}`);
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    if (LESSON_RE.test(lines[i])) out.push(lines[i]);
  }
  return out;
}

const LABELS = [
  ["repo", "repo (docs/devcycle/lessons.md)"],
  ["userRepo", "user, this repo"],
  ["userGlobal", "user, global"],
];

// Each store is capped on its own and labelled, so a stage reads at most 45 lines and can always
// tell which store a line came from. "(none)" rather than a silent gap: an absent label would be
// indistinguishable from a store this run never consulted.
export function renderLessons(stage, stores) {
  const out = [`# Lessons — ${stage}`];
  for (const [key, label] of LABELS) {
    const lines = (stores[key] ?? []).slice(0, SECTION_CAP);
    out.push("", `## ${label}`, lines.length ? lines.join("\n") : "(none)");
  }
  return out.join("\n") + "\n";
}

// Least-recently-recurred, with the cold-start case defined rather than left to sort stability:
// no journal event for an id means nothing has recurred, so its promotion's `landed` date orders
// it; an id with neither sorts oldest of all, and ties break on the id itself so two identical
// calls always propose the same eviction.
function evictionOrder(existing, events, promotions) {
  const lastByCulprit = new Map();
  for (const e of events) {
    if (!e.culprit) continue;
    const prev = lastByCulprit.get(e.culprit);
    if (!prev || String(e.ts) > prev) lastByCulprit.set(e.culprit, String(e.ts));
  }
  const landedByCulprit = new Map();
  for (const p of promotions) {
    for (const id of [p.culpritId, ...(p.aliases ?? [])]) {
      if (!id) continue;
      const prev = landedByCulprit.get(id);
      if (!prev || String(p.landed) < prev) landedByCulprit.set(id, String(p.landed));
    }
  }
  const rows = existing
    .map((line, index) => ({ line, index, id: lessonId(line) }))
    .filter((r) => r.id)
    .map((r) => ({
      ...r,
      recurred: lastByCulprit.get(r.id) ?? null,
      landed: landedByCulprit.get(r.id) ?? null,
    }));

  // Rank only among lines with an actual signal at each tier — absence of evidence is not
  // evidence of staleness (the F1 lesson, restated for eviction), so a line with no recorded
  // recurrence or landed date is protected rather than treated as infinitely old. Only when no
  // line carries any signal at all does the tiebreak fall back to insertion order.
  const withRecurred = rows.filter((r) => r.recurred);
  if (withRecurred.length)
    return withRecurred.sort((a, b) => a.recurred.localeCompare(b.recurred) || a.id.localeCompare(b.id));

  const withLanded = rows.filter((r) => r.landed);
  if (withLanded.length)
    return withLanded.sort((a, b) => a.landed.localeCompare(b.landed) || a.id.localeCompare(b.id));

  return rows.sort((a, b) => a.index - b.index);
}

export function planLanding({ stage, line, culpritId, existing, events = [], promotions = [] }) {
  const already = existing.some((l) => lessonId(l) === culpritId);
  if (already || existing.length < SECTION_CAP) return { fits: true, eviction: null };
  const [oldest] = evictionOrder(existing, events, promotions);
  if (!oldest) return { fits: true, eviction: null };
  return { fits: false, eviction: { culpritId: oldest.id, section: stage, reason: "cap" } };
}

export const MATCH_CAP = 5;

// Minimal glob match, no dependency: '*' matches within a path segment, '**' across segments.
export function fileMatchesGlob(file, glob) {
  if (!glob) return false;
  if (glob === file) return true;
  const rx = "^" + String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*") + "$";
  return new RegExp(rx).test(file);
}

// Pure: join each r2 lesson headline to its promotion record, glob-match the record's
// affected-files (files-touched fallback) against `files`, dedupe by id, rank exact>glob, cap.
export function matchLessons({ lessonLines, promotions, files, cap = MATCH_CAP }) {
  const seen = new Set();
  const ranked = [];
  for (const line of lessonLines) {
    const id = lessonId(line);
    if (!id || seen.has(id)) continue;
    const rec = findPromotionById(promotions, id);
    const globs = (rec && rec.affectedFiles && rec.affectedFiles.length ? rec.affectedFiles : rec && rec.filesTouched) || [];
    let rank = null; // 0 exact, 1 glob
    for (const g of globs) {
      for (const f of files) {
        if (g === f) { rank = 0; break; }
        if (rank === null && fileMatchesGlob(f, g)) rank = 1;
      }
      if (rank === 0) break;
    }
    if (rank === null) continue;
    seen.add(id);
    ranked.push({ id, line, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.slice(0, cap);
}

export function renderMatch(matches) {
  return matches
    .map((m) => `${m.line} → node "\${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lesson ${m.id}`)
    .join("\n");
}

// Pure: returns the store's new text. The caller writes it, after screening — spec §7's user
// stores are written outside the repo, where nothing else would catch a credential.
export function applyLanding(path, stage, line, eviction) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "# Lessons\n";
  let lines = text.split("\n");
  if (eviction) lines = lines.filter((l) => lessonId(l) !== eviction.culpritId);
  let start = lines.findIndex((l) => l.trim() === `## ${stage}`);
  if (start === -1) {
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    lines.push("", `## ${stage}`, line, "");
    return lines.join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  while (end > start + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, line);
  return lines.join("\n");
}
