#!/usr/bin/env node
// The single reader and writer of devcycle's promotion records — one file per landed lesson under
// docs/devcycle/promotions/. Lives here rather than in dream.mjs because doctor.mjs reads these
// records too, and importing them from dream.mjs made the two scripts a cycle.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";

export const promoDir = (root) => join(root, "docs", "devcycle", "promotions");

// (verbatim from scripts/dream.mjs:80-83 — one regex, not two)
function field(text, key) {
  const m = text.match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
// The two Unicode escapes are line terminators for `^`/`$` in JavaScript regexes; written as
// escapes rather than literal characters so a copy cannot silently drop them, which would let a
// value forge a phantom "- landed:" line in the record it is written into.
const oneLine = (s) => String(s ?? "").replace(/\r\n|[\r\n\u2028\u2029]/g, " ").trim();

const PROMOTION_TYPES = new Set([
  "doc-edit", "skill-edit", "enforcement-gap", "contradiction-resolution", "config-proposal",
]);
const LANDED_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidCalendarDate = (s) =>
  LANDED_RE.test(s) && !Number.isNaN(Date.parse(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

const RUNGS = ["r0", "r1", "r2", "r3"];
// A culprit-id is either a bare taxonomy slug (`fix-misses-the-convention`) or the
// `<kind>:<slug>` colon form (`novel:x`). The bare slug is canonical for known-taxonomy ids,
// matching the journal/run-record.mjs and references/culprits.json convention; the colon form
// stays valid for novel and other kinds. lessons.mjs LESSON_RE mirrors this grammar (QC4).
const CULPRIT_ID_RE = /^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
export const LIFECYCLE = ["retirement", "revert"];

// An r3 lesson's whole claim is "a check exists and is green", so a verify: that resolves to
// nothing makes the strongest rung the least verifiable one. Rejected at WRITE time, not at read
// time: a record already on disk cannot be un-landed, and the check is worthless once the lie is
// committed.
function validateVerify(rec, repoRoot) {
  if (rec.rung !== "r3") return;
  const v = oneLine(rec.verify);
  if (!v) throw new Error("rung r3 requires a verify: value — a path to the check, or the command that runs it");
  const abs = isAbsolute(v) ? v : join(repoRoot, v.split(/\s/)[0]);
  if (existsSync(abs)) return;
  // A command is accepted only when it is not merely a path that happens not to exist: a value
  // with no whitespace and a file-ish shape is a path the author expected to resolve.
  if (/\s/.test(v.trim())) return;
  throw new Error(
    `r3 verify "${v}" resolves to no path under the repo and is not a command`,
  );
}

export function validatePromotion(rec, { repoRoot } = {}) {
  // A lifecycle record (retirement/revert) is not a landing — it shares the culprit-id/rung/date
  // shape with a promotion record but carries none of the promotion-specific fields, so it is
  // validated and returned on its own branch rather than falling through to the checks below.
  if (rec.lifecycle != null) {
    if (!LIFECYCLE.includes(rec.lifecycle))
      throw new Error(`invalid lifecycle "${rec.lifecycle}" — must be one of: ${LIFECYCLE.join(", ")}`);
    if (!CULPRIT_ID_RE.test(rec.culpritId ?? ""))
      throw new Error(`invalid culprit-id "${rec.culpritId}" — must be a lowercase kebab slug or <kind>:<slug>`);
    if (!RUNGS.includes(rec.rung))
      throw new Error(`invalid rung "${rec.rung}" — must be one of: ${RUNGS.join(", ")}`);
    if (!isValidCalendarDate(rec.landed ?? ""))
      throw new Error(`invalid landed date "${rec.landed}" — must be a real YYYY-MM-DD calendar date`);
    if (!isValidCalendarDate(rec.at ?? ""))
      throw new Error(`invalid at date "${rec.at}" — must be a real YYYY-MM-DD calendar date`);
    return;
  }
  if (!PROMOTION_TYPES.has(rec.promotionType))
    throw new Error(`invalid promotionType "${rec.promotionType}" — must be one of: ${[...PROMOTION_TYPES].join(", ")}`);
  if (!isValidCalendarDate(rec.landed ?? ""))
    throw new Error(`invalid landed date "${rec.landed}" — must be a real YYYY-MM-DD calendar date`);
  if (!String(rec.clusterSignature ?? "").trim())
    throw new Error("cluster-signature is required and cannot be empty");
  if (rec.sourcedFromMemory != null && typeof rec.sourcedFromMemory !== "boolean")
    throw new Error(`sourced-from-memory must be a boolean or absent, got ${JSON.stringify(rec.sourcedFromMemory)}`);
  if (rec.rung != null && !RUNGS.includes(rec.rung))
    throw new Error(`invalid rung "${rec.rung}" — must be one of: ${RUNGS.join(", ")}`);
  if (rec.culpritId != null && !CULPRIT_ID_RE.test(rec.culpritId))
    throw new Error(`invalid culprit-id "${rec.culpritId}" — must be a lowercase kebab slug or <kind>:<slug>`);
  validateVerify(rec, repoRoot ?? process.cwd());
}

export function recordPromotion(repoRoot, rec) {
  validatePromotion(rec, { repoRoot });
  mkdirSync(promoDir(repoRoot), { recursive: true });
  const slug = slugify(oneLine(rec.title));
  let path = join(promoDir(repoRoot), `${rec.landed}-${slug}.md`);
  for (let n = 2; existsSync(path); n++) path = join(promoDir(repoRoot), `${rec.landed}-${slug}-${n}.md`);
  const filesTouched = Array.isArray(rec.filesTouched)
    ? rec.filesTouched.map((f) => oneLine(f)).join(", ")
    : oneLine(rec.filesTouched);
  const affectedFiles = Array.isArray(rec.affectedFiles)
    ? rec.affectedFiles.map((f) => oneLine(f)).join(", ")
    : rec.affectedFiles != null
      ? oneLine(rec.affectedFiles)
      : filesTouched;
  const aliases = Array.isArray(rec.aliases) ? rec.aliases.map((a) => oneLine(a)).join(", ") : oneLine(rec.aliases);
  writeFileSync(
    path,
    `# ${oneLine(rec.title)}\n` +
      `- promotion-type: ${oneLine(rec.promotionType)}\n` +
      `- cluster-signature: ${oneLine(rec.clusterSignature)}\n` +
      `- files-touched: ${filesTouched}\n` +
      `- affected-files: ${affectedFiles}\n` +
      `- landed: ${oneLine(rec.landed)}\n` +
      `- commit: ${oneLine(rec.commit)}\n` +
      `- plugin-version: ${oneLine(rec.pluginVersion)}\n` +
      `- sourced-from-memory: ${rec.sourcedFromMemory == null ? "" : rec.sourcedFromMemory === true}\n` +
      `- culprit-id: ${oneLine(rec.culpritId)}\n` +
      `- rung: ${oneLine(rec.rung)}\n` +
      `- audience: ${oneLine(rec.audience)}\n` +
      `- verify: ${oneLine(rec.verify)}\n` +
      `- aliases: ${aliases}\n`,
  );
  return path;
}

export function recordLifecycle(repoRoot, rec) {
  validatePromotion(rec); // shares the lifecycle branch above
  mkdirSync(promoDir(repoRoot), { recursive: true });
  const suffix = rec.lifecycle === "revert" ? "reverted" : "retired";
  const slug = rec.culpritId.split(":").pop();
  const file = join(promoDir(repoRoot), `${rec.at}-${slug}-${suffix}.md`);
  const lines = [
    `# ${oneLine(rec.title)}`,
    `- lifecycle: ${rec.lifecycle}`,
    `- culprit-id: ${rec.culpritId}`,
    `- rung: ${rec.rung}`,
    `- landed: ${rec.landed}`,
    `- at: ${rec.at}`,
    `- plugin-version: ${rec.pluginVersion ?? ""}`,
    ...(rec.lifecycle === "revert" ? [`- reverts-commit: ${rec.revertsCommit ?? ""}`] : []),
    `- reason: ${rec.reason ?? ""}`,
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

export function readPromotions(repoRoot) {
  const dir = promoDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const orNull = (key) => field(text, key) || null;
      return {
        path: relative(repoRoot, join(dir, f)),
        title: (text.match(/^# (.*)$/m) ?? [, ""])[1].trim(),
        promotionType: field(text, "promotion-type"),
        clusterSignature: field(text, "cluster-signature"),
        filesTouched: field(text, "files-touched").split(",").map((s) => s.trim()).filter(Boolean),
        affectedFiles: field(text, "affected-files").split(",").map((s) => s.trim()).filter(Boolean),
        landed: field(text, "landed"),
        commit: field(text, "commit"),
        pluginVersion: orNull("plugin-version"),
        culpritId: orNull("culprit-id"),
        rung: orNull("rung"),
        audience: orNull("audience"),
        verify: orNull("verify"),
        aliases: field(text, "aliases").split(",").map((s) => s.trim()).filter(Boolean),
        sourcedFromMemory:
          field(text, "sourced-from-memory") === "" ? null : field(text, "sourced-from-memory") === "true",
        lifecycle: orNull("lifecycle"),
        at: orNull("at"),
        revertsCommit: orNull("reverts-commit"),
      };
    });
}

// Identity, not similarity. An id is either the same id or it is not, so this can never produce
// the 74-of-100 false-positive rate the prose comparison it replaces measured (known-issues F1/F2).
export function suppressedByCulpritId(culpritId, promotions) {
  const id = String(culpritId ?? "").trim();
  if (!id) return false;
  return promotions.some((p) => p.culpritId === id || p.aliases.includes(id));
}

// Resolves a lesson id to its record: culprit-id first, then alias, then the filename slug (the
// date prefix and .md extension stripped) — the last fallback exists so a pre-culprit-id record
// can still be joined against a trigger written before culprit-ids existed.
export function findPromotionById(promotions, id) {
  const want = String(id ?? "").trim();
  if (!want) return null;
  for (const p of promotions) if (p.culpritId === want) return p;
  for (const p of promotions) if (p.aliases.includes(want)) return p;
  for (const p of promotions) {
    const base = p.path.split("/").pop().replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
    if (base === want) return p;
  }
  return null;
}

const tokens = (s) =>
  new Set(String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean));

// D-5: the 39 records that predate culprit-ids get a HINT at Confirm, never a suppression. F1
// measured 0/26 and F2 measured 1/30 on signature matching, so an automatic fallback would read
// as coverage it does not provide — this returns candidates for a human to look at and nothing more.
export function legacySimilar(title, promotions) {
  const want = tokens(title);
  if (!want.size) return [];
  return promotions
    .filter((p) => p.culpritId === null)
    .map((p) => {
      const have = tokens(p.title);
      const shared = [...want].filter((w) => have.has(w)).length;
      return { p, overlap: shared / Math.max(want.size, 1) };
    })
    .filter(({ overlap }) => overlap >= 0.5)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 3)
    .map(({ p }) => p);
}

export function novelSlugs(promotions) {
  const out = new Set();
  for (const p of promotions) {
    if (p.culpritId?.startsWith("novel:")) out.add(p.culpritId);
    for (const a of p.aliases) if (a.startsWith("novel:")) out.add(a);
  }
  return [...out].sort();
}
