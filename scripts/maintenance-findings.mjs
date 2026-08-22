// The single reader/writer of devcycle's maintenance-finding records — one file per finding under
// docs/devcycle/maintenance-findings/, mirroring promotions.mjs's per-file store. Holds two record
// kinds (maintenance-finding, github-issue) distinguished by a finding-kind field, so verifyMaintenance
// and the --match extension read one store, not two. Reuses promotions.mjs's helpers rather than
// re-declaring them (QC1).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { field, slugify, oneLine, isValidCalendarDate, CULPRIT_ID_RE } from "./promotions.mjs";
import { fileMatchesGlob } from "./lessons.mjs";

export const maintDir = (root) => join(root, "docs", "devcycle", "maintenance-findings");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
const FINDING_KINDS = new Set(["maintenance-finding", "github-issue"]);
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const CONFIDENCES = new Set(["verified", "suspected"]);
const LIFECYCLE = ["resolved", "dismissed"]; // terminal/locked fates; an active finding carries none

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
  if (!FINDING_KINDS.has(rec.findingKind))
    throw new Error(`invalid finding-kind "${rec.findingKind}" — must be one of: ${[...FINDING_KINDS].join(", ")}`);
  if (rec.lifecycle != null && rec.lifecycle !== "" && !LIFECYCLE.includes(rec.lifecycle))
    throw new Error(`invalid lifecycle "${rec.lifecycle}" — must be one of: ${LIFECYCLE.join(", ")}`);
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
  if (rec.findingKind === "github-issue") {
    if (!Number.isInteger(rec.issue) || rec.issue < 1)
      throw new Error(`a github-issue record requires an integer issue number, got "${rec.issue}"`);
    if (rec.findingId !== `github-issue:${rec.issue}`)
      throw new Error(`github-issue finding-id must be "github-issue:${rec.issue}", got "${rec.findingId}"`);
  } else if (!KIND_RE.test(rec.culpritKind ?? "")) {
    throw new Error(`invalid culprit-kind "${rec.culpritKind}"`);
  }
}

export function recordMaintenanceFinding(root, rec) {
  validateMaintenanceFinding(rec, { repoRoot: root });
  mkdirSync(maintDir(root), { recursive: true });
  const path = join(maintDir(root), `${slugify(rec.findingId)}.md`);
  const affected = Array.isArray(rec.affectedFiles)
    ? rec.affectedFiles.map((f) => oneLine(f)).join(", ")
    : oneLine(rec.affectedFiles);
  const origin = oneLine(rec.origin) || (rec.findingKind === "github-issue" ? `github-issue #${rec.issue}` : "lens");
  const lines = [
    `# ${oneLine(rec.title)}`,
    `- finding-kind: ${rec.findingKind}`,
    `- finding-id: ${oneLine(rec.findingId)}`,
    rec.findingKind === "github-issue" ? `- issue: ${rec.issue}` : `- culprit-kind: ${oneLine(rec.culpritKind)}`,
    `- severity: ${rec.severity}`,
    `- confidence: ${rec.confidence}`,
    `- affected-files: ${affected}`,
    `- first-seen: ${oneLine(rec.firstSeen)}`,
    `- last-seen: ${oneLine(rec.lastSeen)}`,
    `- passes: ${rec.passes}`,
    `- origin: ${origin}`,
    `- verify: ${oneLine(rec.verify)}`,
    `- lifecycle: ${oneLine(rec.lifecycle)}`,
    `- dismissed-reason: ${oneLine(rec.dismissedReason)}`,
  ];
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

export function readMaintenanceFindings(root) {
  const dir = maintDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const orNull = (key) => field(text, key) || null;
      const issue = field(text, "issue");
      return {
        path: relative(root, join(dir, f)),
        title: (text.match(/^# (.*)$/m) ?? [, ""])[1].trim(),
        findingKind: field(text, "finding-kind"),
        findingId: field(text, "finding-id"),
        culpritKind: orNull("culprit-kind"),
        issue: issue ? Number(issue) : null,
        severity: field(text, "severity"),
        confidence: field(text, "confidence"),
        affectedFiles: field(text, "affected-files").split(",").map((s) => s.trim()).filter(Boolean),
        firstSeen: field(text, "first-seen"),
        lastSeen: field(text, "last-seen"),
        passes: Number(field(text, "passes")) || 0,
        origin: orNull("origin"),
        verify: orNull("verify"),
        lifecycle: orNull("lifecycle"),
        dismissedReason: orNull("dismissed-reason"),
      };
    });
}

// Three-tier, mirroring findPromotionById: exact finding-id → github-issue:<n> synonym → filename slug.
export function findMaintenanceFindingById(records, id) {
  const want = String(id ?? "").trim();
  if (!want) return null;
  for (const r of records) if (r.findingId === want) return r;
  for (const r of records) if (r.findingKind === "github-issue" && `github-issue:${r.issue}` === want) return r;
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
// absent. Reuses lessons.mjs's fileMatchesGlob rather than a second glob engine (QC1). A resolved or
// dismissed finding is settled and not surfaced; a new (one-pass) finding is not yet "known context".
export function matchMaintenanceFindings({ records, files, cap = 5 }) {
  const out = [];
  for (const r of records) {
    if (r.lifecycle) continue;      // resolved/dismissed are settled
    if (r.passes < 2) continue;     // persisting only
    const hit = (r.affectedFiles ?? []).some((g) => files.some((f) => g === f || fileMatchesGlob(f, g)));
    if (hit) out.push(r);
  }
  return out.slice(0, cap);
}

export function renderMaintenanceMatches(matches) {
  return matches
    .map((m) => `- known ${m.culpritKind ?? m.findingKind} concern, persisting since ${m.firstSeen} (${m.passes} passes): ${m.title} [${m.findingId}]`)
    .join("\n");
}
