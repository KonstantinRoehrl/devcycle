#!/usr/bin/env node
// The single reader/writer of devcycle's maintenance-finding records — one file per finding under
// docs/devcycle/maintenance-findings/, mirroring promotions.mjs's per-file store. Every record is a
// maintenance-finding: GitHub owns issue state, so the store keeps no issue record (CONTRIBUTING.md
// owns that split). Reuses promotions.mjs's and md-field.mjs's helpers rather than re-declaring
// them (QC1).
// Also the store's only CLI — apply-pass, dismiss, stranded — which /devcycle:maintain's step 8 runs.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { field, slugify, oneLine, isValidCalendarDate, CULPRIT_ID_RE } from "./promotions.mjs";
import { readRecordDir, recordTitle } from "./md-field.mjs";
import { fileMatchesGlob } from "./lessons.mjs";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { verifyMaintenance } from "./verification.mjs";

const STORE_PATH = "docs/devcycle/maintenance-findings";
export const maintDir = (root) => join(root, STORE_PATH);

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

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// references/branch.md § "Names first": git's own ref grammar, then the characters git accepts in a
// ref name but a shell would expand; then the name spelled the way this clone resolves it.
const SHELL_UNSAFE = /[$`'";&|<>\n]/;
function resolveRefName(root, name) {
  const n = String(name ?? "");
  if (spawnSync("git", ["check-ref-format", "--allow-onelevel", n]).status !== 0 || SHELL_UNSAFE.test(n))
    throw new Error(`invalid ref name "${n}"`);
  for (const candidate of [n, `origin/${n}`])
    if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: root }).status === 0)
      return candidate;
  throw new Error(`ref "${n}" resolves neither as ${n} nor as origin/${n}`);
}

// The store as committed at a ref, so a pass can compare against its base without a worktree.
function readMaintenanceFindingsAtRef(root, ref) {
  const at = resolveRefName(root, ref);
  return git(root, ["ls-tree", "-z", "--name-only", at, "--", `${STORE_PATH}/`])
    .split("\0")
    .filter((p) => p.endsWith(".md") && !p.endsWith("/README.md"))
    .sort()
    .map((p) => parseMaintenanceFinding(git(root, ["show", `${at}:${p}`]), p));
}

const ENTRY_FIELDS = ["culpritKind", "canonicalLocation", "title", "severity", "confidence", "affectedFiles"];
const higherSeverity = (a, b) => ((SEVERITY_ORDER[a] ?? 9) <= (SEVERITY_ORDER[b] ?? 9) ? a : b);
const passRow = (r) => ({
  id: r.findingId, title: r.title, severity: r.severity, confidence: r.confidence,
  passes: r.passes, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
});

// One pass's store update, computed and validated whole before anything is written, so a bad
// entry anywhere leaves the store exactly as it was.
export function applyPass({ root, ref = null, entries, date, resolve = false, dryRun = false }) {
  if (!isValidCalendarDate(date ?? "")) throw new Error(`--date must be a real YYYY-MM-DD date, got "${date}"`);
  if (!Array.isArray(entries)) throw new Error("the pass file must hold a JSON array of findings");
  const incoming = new Map();
  entries.forEach((e, i) => {
    const missing = ENTRY_FIELDS.find((k) => e?.[k] == null || e[k] === "" || (Array.isArray(e[k]) && !e[k].length));
    if (missing) throw new Error(`entry ${i}: missing mandatory field ${missing}`);
    if (!Array.isArray(e.affectedFiles)) throw new Error(`entry ${i}: affectedFiles must be an array of paths`);
    const blank = e.affectedFiles.findIndex((f) => typeof f !== "string" || !f.trim());
    if (blank !== -1) throw new Error(`entry ${i}: affectedFiles item ${blank} is blank — every item must be a path`);
    // Checked here, not only by the record validator: a persisting build keeps the higher of stored
    // and incoming severity, which would silently drop an unknown incoming value.
    if (!SEVERITIES.has(e.severity))
      throw new Error(`entry ${i}: invalid severity "${e.severity}" — must be one of: ${[...SEVERITIES].join(", ")}`);
    const id = findingId(e.culpritKind, e.canonicalLocation);
    if (incoming.has(id)) throw new Error(`entry ${i}: duplicate finding-id ${id} — merge it with the entry that derives the same id`);
    incoming.set(id, e);
  });
  const stored = ref ? readMaintenanceFindingsAtRef(root, ref) : readMaintenanceFindings(root);
  const late = stored.find((r) => r.lastSeen > date);
  if (late) throw new Error(`${late.findingId} was last seen ${late.lastSeen}, after --date ${date} — dates never move backwards`);
  const byId = new Map(stored.map((r) => [r.findingId, r]));
  const summary = { new: [], persisting: [], dismissed: [], resolved: [], gaps: [], written: [], deleted: [] };
  const toWrite = [];
  for (const [id, e] of incoming) {
    const prior = byId.get(id);
    if (prior?.lifecycle === "dismissed") {
      summary.dismissed.push(passRow(prior));
      continue;
    }
    const fields = { culpritKind: e.culpritKind, title: e.title, confidence: e.confidence, affectedFiles: e.affectedFiles };
    // A stored record first seen today was created by an earlier run of this same pass.
    const isNew = !prior || prior.firstSeen === date;
    const rec = isNew
      ? { findingKind: FINDING_KIND, findingId: id, ...fields, severity: e.severity, verify: e.verify ?? null,
          firstSeen: date, lastSeen: date, passes: 1 }
      : { ...prior, ...fields, severity: higherSeverity(prior.severity, e.severity), verify: e.verify ?? prior.verify,
          lifecycle: null, dismissedReason: null, lastSeen: date,
          passes: prior.lastSeen === date ? prior.passes : prior.passes + 1 };
    try {
      validateMaintenanceFinding(rec);
    } catch (err) {
      throw new Error(`${id}: ${err.message}`);
    }
    toWrite.push(rec);
    summary[isNew ? "new" : "persisting"].push(passRow(rec));
  }
  const resolved = [];
  if (resolve) {
    // verifyMaintenance owns which undetected records resolve; it runs no verify: here, so every
    // resolution comes back uncorroborated in gaps.
    const { sections, gaps } = verifyMaintenance(stored, { detectedIds: new Set(incoming.keys()) });
    const ids = new Set(sections.resolved.map((row) => row.id));
    resolved.push(...stored.filter((r) => ids.has(r.findingId)));
    summary.resolved = resolved.map(passRow);
    summary.gaps = gaps;
  }
  if (!dryRun) {
    for (const rec of toWrite) summary.written.push(relative(root, recordMaintenanceFinding(root, rec)));
    for (const r of resolved) {
      const removed = removeMaintenanceFinding(root, r.findingId);
      if (removed) summary.deleted.push(relative(root, removed));
    }
  }
  return summary;
}

// The reconsider path as well as the dismissal, so nobody hand-edits the store.
export function dismissFinding(root, { id, reason = null, revoke = false, title = null }) {
  if (!id) throw new Error("--id <finding-id> is required");
  if ((reason != null) === Boolean(revoke)) throw new Error("pass exactly one of --reason or --revoke");
  const rec = findMaintenanceFindingById(readMaintenanceFindings(root), id);
  if (!rec) throw new Error(`no maintenance finding with id "${id}"`);
  if (rec.findingKind !== FINDING_KIND)
    throw new Error(`${rec.findingId} is a legacy ${rec.findingKind} record — it cannot be dismissed; a confirmed --resolve pass retires it`);
  if (!rec.title && !oneLine(title))
    throw new Error(`${rec.findingId} has a blank title — pass --title so the rewritten record validates`);
  const next = {
    ...rec,
    title: oneLine(title) || rec.title,
    lifecycle: revoke ? null : "dismissed",
    dismissedReason: revoke ? null : oneLine(reason),
  };
  return relative(root, recordMaintenanceFinding(root, next));
}

const STORE_BRANCHES = ["refs/heads/chore/maintenance-findings-*", "refs/remotes/origin/chore/maintenance-findings-*"];

// null when gh cannot answer (missing, unauthenticated, offline), so the caller falls back to history.
function mergedPr(root, head) {
  const r = spawnSync("gh", ["pr", "list", "--state", "merged", "--head", head, "--json", "number", "--limit", "1"],
    { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).length > 0;
  } catch {
    return null;
  }
}

// Offline: a squash merge leaves no ancestry link, so a ref has landed when every store path it
// changed since the merge-base has its blob — or its deletion — somewhere in base's history for
// that path since the merge-base. A later change on base does not un-land it.
function contentReachedBase(root, mergeBase, base, ref) {
  const blobAt = (rev, path) => {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], { cwd: root, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const changed = git(root, ["diff", "--no-renames", "--name-only", "-z", mergeBase, ref, "--", `${STORE_PATH}/`])
    .split("\0").filter(Boolean);
  return changed.every((path) => {
    const want = blobAt(ref, path);
    return git(root, ["rev-list", `${mergeBase}..${base}`, "--", path])
      .split("\n").filter(Boolean)
      .some((commit) => blobAt(commit, path) === want);
  });
}

// An earlier pass's store branch that never landed on base (#243).
export function findStranded(root, base) {
  const at = resolveRefName(root, base);
  const refs = git(root, ["for-each-ref", "--format=%(refname:short)", ...STORE_BRANCHES]).split("\n").filter(Boolean);
  const out = [];
  for (const ref of refs) {
    const mb = spawnSync("git", ["merge-base", at, ref], { cwd: root, encoding: "utf8" });
    if (mb.status === 1 && !mb.stdout.trim()) {
      out.push({ ref, status: "skipped" });
      continue;
    }
    if (mb.status !== 0) throw new Error(`git merge-base ${at} ${ref} failed: ${mb.stderr.trim()}`);
    const landed = mergedPr(root, ref.replace(/^origin\//, "")) ?? contentReachedBase(root, mb.stdout.trim(), at, ref);
    if (!landed) out.push({ ref, status: "stranded" });
  }
  return out;
}

function toplevel(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("not inside a git repository — pass --root <dir>");
  return r.stdout.trim();
}

const VERBS = {
  "apply-pass": {
    flags: { "--pass": "value", "--date": "value", "--resolve": "none", "--dry-run": "none", "--root": "value", "--ref": "value" },
    run: (root, flags) => {
      const passPath = requireValue(flags, "--pass");
      if (!passPath) throw new Error("--pass <file.json> is required");
      const date = requireValue(flags, "--date", "a YYYY-MM-DD date");
      if (!date) throw new Error("--date YYYY-MM-DD is required");
      const ref = requireValue(flags, "--ref", "a ref name") ?? null;
      if (ref && !flags["--dry-run"]) throw new Error("--ref reads a committed store, so it requires --dry-run");
      let entries;
      try {
        entries = JSON.parse(readFileSync(passPath, "utf8"));
      } catch (e) {
        throw new Error(`cannot read the pass file ${passPath}: ${e.message}`);
      }
      return JSON.stringify(applyPass({
        root, ref, entries, date, resolve: Boolean(flags["--resolve"]), dryRun: Boolean(flags["--dry-run"]),
      }));
    },
  },
  dismiss: {
    flags: { "--id": "value", "--reason": "value", "--revoke": "none", "--title": "value", "--root": "value" },
    run: (root, flags) => dismissFinding(root, {
      id: requireValue(flags, "--id", "a finding id"),
      reason: requireValue(flags, "--reason", "a non-empty, load-bearing reason") ?? null,
      revoke: Boolean(flags["--revoke"]),
      title: requireValue(flags, "--title", "a non-empty title") ?? null,
    }),
  },
  stranded: {
    flags: { "--base": "value", "--root": "value" },
    run: (root, flags) => {
      const base = requireValue(flags, "--base", "a branch name");
      if (!base) throw new Error("--base <branch> is required");
      return findStranded(root, base)
        .map(({ ref, status }) => (status === "skipped" ? `skipped ${ref} (no merge-base)` : `stranded ${ref}`))
        .join("\n");
    },
  },
};

function main() {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    if (!Object.hasOwn(VERBS, verb ?? ""))
      throw new Error(`unknown verb "${verb ?? ""}" — expected one of: ${Object.keys(VERBS).join(", ")}`);
    const { flags } = parseFlags(rest, VERBS[verb].flags);
    const root = requireValue(flags, "--root") ?? toplevel(process.cwd());
    const out = VERBS[verb].run(root, flags);
    if (out) process.stdout.write(`${out}\n`);
  } catch (e) {
    process.stderr.write(`maintenance-findings ${verb ?? ""}: ${e.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
