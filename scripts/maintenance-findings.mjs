// The single reader/writer of devcycle's maintenance-finding records — one file per finding under
// docs/devcycle/maintenance-findings/, mirroring promotions.mjs's per-file store. Every record is a
// maintenance-finding: GitHub owns issue state, so the store keeps no issue record (CONTRIBUTING.md
// owns that split). Reuses promotions.mjs's and md-field.mjs's helpers rather than re-declaring
// them (QC1).
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { field, slugify, oneLine, isValidCalendarDate, CULPRIT_ID_RE } from "./promotions.mjs";
import { readRecordDir, recordTitle } from "./md-field.mjs";
import { fileMatchesGlob } from "./lessons.mjs";

export const maintDir = (root) => join(root, "docs", "devcycle", "maintenance-findings");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
const FINDING_KIND = "maintenance-finding";
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const CONFIDENCES = new Set(["verified", "suspected"]);
// "dismissed" is the one lifecycle a record carries — the locked fate that must persist, since
// deleting it would let the finding resurface as new and defeat the dismissal (never
// auto-re-evaluated). A resolved finding is deleted outright, never marked. A record written before
// this rule may still carry "resolved": it is read as-is, so --match keeps skipping it, and is
// rejected only if something tries to write it back.
const LIFECYCLE = ["dismissed"];

// Repo-local finding identity (M4): <culprit-kind>:<location-hash>, mirroring run-record.mjs's repoSlug
// canonicalization (sha256 sliced to 8 hex). The caller (the playbook) builds canonicalLocation WITHOUT
// a line number so a finding survives cosmetic line moves; a rename/split changes the path and so the
// id — the known limit verifyMaintenance surfaces as a gap.
export function findingId(culpritKind, canonicalLocation) {
  const kind = String(culpritKind ?? "").trim();
  if (!KIND_RE.test(kind)) throw new Error(`invalid culprit-kind "${culpritKind}" — must be a lowercase kebab slug`);
  return `${kind}:${sha256(String(canonicalLocation ?? "")).slice(0, 8)}`;
}

export function validateMaintenanceFinding(rec, { repoRoot } = {}) {
  void repoRoot;
  if (rec.findingKind !== FINDING_KIND)
    throw new Error(`invalid finding-kind "${rec.findingKind}" — must be ${FINDING_KIND}`);
  if (!oneLine(rec.title))
    throw new Error(`finding "${rec.findingId}" has a blank title`);
  if (rec.lifecycle != null && rec.lifecycle !== "" && !LIFECYCLE.includes(rec.lifecycle))
    throw new Error(`invalid lifecycle "${rec.lifecycle}" — must be empty or one of: ${LIFECYCLE.join(", ")}`);
  if (rec.lifecycle === "dismissed" && !String(rec.dismissedReason ?? "").trim())
    throw new Error("a dismissed finding requires a load-bearing dismissed-reason");
  if (!SEVERITIES.has(rec.severity))
    throw new Error(`invalid severity "${rec.severity}"`);
  if (!CONFIDENCES.has(rec.confidence))
    throw new Error(`invalid confidence "${rec.confidence}"`);
  if (!isValidCalendarDate(rec.firstSeen ?? ""))
    throw new Error(`invalid first-seen "${rec.firstSeen}" — must be a real YYYY-MM-DD date`);
  if (!isValidCalendarDate(rec.lastSeen ?? ""))
    throw new Error(`invalid last-seen "${rec.lastSeen}" — must be a real YYYY-MM-DD date`);
  if (!Number.isInteger(rec.passes) || rec.passes < 1)
    throw new Error(`invalid passes "${rec.passes}" — must be an integer >= 1`);
  if (!CULPRIT_ID_RE.test(rec.findingId ?? ""))
    throw new Error(`invalid finding-id "${rec.findingId}"`);
  if (!KIND_RE.test(rec.culpritKind ?? ""))
    throw new Error(`invalid culprit-kind "${rec.culpritKind}"`);
}

export function recordMaintenanceFinding(root, rec) {
  validateMaintenanceFinding(rec, { repoRoot: root });
  mkdirSync(maintDir(root), { recursive: true });
  const path = join(maintDir(root), `${slugify(rec.findingId)}.md`);
  const affected = Array.isArray(rec.affectedFiles)
    ? rec.affectedFiles.map((f) => oneLine(f)).join(", ")
    : oneLine(rec.affectedFiles);
  const lines = [
    `# ${oneLine(rec.title)}`,
    `- finding-kind: ${rec.findingKind}`,
    `- finding-id: ${oneLine(rec.findingId)}`,
    `- culprit-kind: ${oneLine(rec.culpritKind)}`,
    `- severity: ${rec.severity}`,
    `- confidence: ${rec.confidence}`,
    `- affected-files: ${affected}`,
    `- first-seen: ${oneLine(rec.firstSeen)}`,
    `- last-seen: ${oneLine(rec.lastSeen)}`,
    `- passes: ${rec.passes}`,
    `- verify: ${oneLine(rec.verify)}`,
  ];
  if (rec.lifecycle === "dismissed")
    lines.push("- lifecycle: dismissed", `- dismissed-reason: ${oneLine(rec.dismissedReason)}`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// A resolved finding's file is deleted outright rather than persisted with lifecycle: resolved
// (see the LIFECYCLE comment above) — the closed loop is not a longitudinal artifact worth keeping
// tracked forever, unlike a dismissed one. Idempotent: a missing file (already removed, or never
// written) is a no-op, not an error, so a caller can call this unconditionally from the persistence
// step without first checking existence.
export function removeMaintenanceFinding(root, findingId) {
  const path = join(maintDir(root), `${slugify(String(findingId ?? ""))}.md`);
  if (!existsSync(path)) return null;
  unlinkSync(path);
  return path;
}

export function parseMaintenanceFinding(text, path) {
  const orNull = (key) => field(text, key) || null;
  return {
    path,
    title: recordTitle(text),
    findingKind: field(text, "finding-kind"),
    findingId: field(text, "finding-id"),
    culpritKind: orNull("culprit-kind"),
    severity: field(text, "severity"),
    confidence: field(text, "confidence"),
    affectedFiles: field(text, "affected-files").split(",").map((s) => s.trim()).filter(Boolean),
    firstSeen: field(text, "first-seen"),
    lastSeen: field(text, "last-seen"),
    passes: Number(field(text, "passes")) || 0,
    verify: orNull("verify"),
    lifecycle: orNull("lifecycle"),
    dismissedReason: orNull("dismissed-reason"),
  };
}

export function readMaintenanceFindings(root) {
  const dir = maintDir(root);
  return readRecordDir(dir).map(({ file, text }) => parseMaintenanceFinding(text, relative(root, join(dir, file))));
}

// Two-tier, mirroring findPromotionById minus its synonym tier: exact finding-id → filename slug.
export function findMaintenanceFindingById(records, id) {
  const want = String(id ?? "").trim();
  if (!want) return null;
  for (const r of records) if (r.findingId === want) return r;
  for (const r of records) {
    const b = r.path.split("/").pop().replace(/\.md$/, "");
    if (b === want || b === slugify(want)) return r;
  }
  return null;
}

// Ranking (§M5): severity is primary and is never lowered. Within a severity tier, sort by the trending
// signal — confidence (verified before suspected), then passes (more before fewer), then first-seen
// (older before newer), then id — so two same-severity findings have a stable, non-arbitrary order and
// an old low-severity finding can never outrank a new critical one.
export function rankByTrending(findings) {
  const conf = (c) => (c === "verified" ? 0 : 1);
  const id = (f) => String(f.findingId ?? f.id ?? "");
  return [...findings].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
    conf(a.confidence) - conf(b.confidence) ||
    (b.passes ?? 0) - (a.passes ?? 0) ||
    String(a.firstSeen).localeCompare(String(b.firstSeen)) ||
    id(a).localeCompare(id(b)));
}

// §M9: a file's persisting findings (held across >=2 passes), matched by affected-files, silent when
// absent. Reuses lessons.mjs's fileMatchesGlob rather than a second glob engine (QC1). A dismissed
// finding — or a legacy resolved one still on disk — is settled and not surfaced; a new (one-pass)
// finding is not yet "known context".
export function matchMaintenanceFindings({ records, files, cap = 5 }) {
  const out = [];
  for (const r of records) {
    if (r.lifecycle) continue;      // dismissed, or a legacy resolved record: settled
    if (r.passes < 2) continue;     // persisting only
    const hit = (r.affectedFiles ?? []).some((g) => files.some((f) => g === f || fileMatchesGlob(f, g)));
    if (hit) out.push(r);
  }
  return rankByTrending(out).slice(0, cap);
}

export function renderMaintenanceMatches(matches) {
  return matches
    .map((m) => `- known ${m.culpritKind} concern, persisting since ${m.firstSeen} (${m.passes} passes): ${m.title} [${m.findingId}]`)
    .join("\n");
}
