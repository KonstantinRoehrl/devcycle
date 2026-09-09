#!/usr/bin/env node
// Deterministic half of devcycle's dreaming pass: checkpoint, corpus manifest, session
// cap, artifact freshness. The semantic half lives in playbooks/learning-from-sessions.md.
// Emits no message text, no branch names — only ids, paths, timestamps, and counts.
// The stores each have one owner, and this file is the CLI over them rather than a second
// copy: journal.mjs (run records), promotions.mjs (landed lessons), lessons.mjs (the three
// capped stores), learn-report.mjs (the report).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { findTranscriptFiles, owningSession, inWindow } from "./doctor.mjs";
import { journalEvents, eventsByCulprit } from "./journal.mjs";
import { readPromotions, recordPromotion, recordLifecycle, suppressedByCulpritId, legacySimilar, novelSlugs, findPromotionById } from "./promotions.mjs";
import { repoStorePath, userRepoStorePath, userGlobalStorePath, readSection, renderLessons, STAGES, budgetStatus, ALWAYS_LOADED_CEILING, lessonId, matchLessons, renderMatch, planLanding, MATCH_CAP } from "./lessons.mjs";
import { readMaintenanceFindings, matchMaintenanceFindings, renderMaintenanceMatches } from "./maintenance-findings.mjs";
import { parseFileList } from "./task-files.mjs";
import { parseFlags, requireCount } from "./cli-flags.mjs";
import { verify, installedVersion, defaultRunCheck } from "./verification.mjs";
import { renderLearnReport } from "./learn-report.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { fieldText } from "./md-field.mjs";
import { gitToplevel, worktreeRoots } from "./git-identity.mjs";
import { eachRecord } from "./jsonl.mjs";

const CAP = 100;
// Phase B reads at most cap + RANK_MARGIN sessions. mtime tracks a transcript's last append to
// within write-flush latency, so the margin covers file copies and clock skew, not routine use.
export const RANK_MARGIN = 25;
// A per-session ceiling checked from statSync before any read. A backstop, not the main defence
// — the streaming reader is what bounds the ordinary case — sized to exclude nothing in a real
// multi-gigabyte corpus while capping one runaway transcript's parse.
export const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const dreamDir = (root) => join(root, ".devcycle", "dreaming");
const statePath = (root) => join(dreamDir(root), "state.md");

// Anchored at the git toplevel, not process.cwd(): --plan and --extract both derive their root
// from cwd, so a dispatch invoked from a subdirectory would otherwise miss the cache silently —
// the fix would quietly fail to apply exactly where mining runs. gitToplevel resolves a linked
// worktree to its shared checkout, so one cache serves every worktree of the repo.
const corpusCachePath = (repoRoot, gitRunner) =>
  join(gitToplevel(repoRoot, gitRunner), ".devcycle", "dreaming", "corpus.json");

// Every miss — absent file, unparseable, a different projects root, an unknown session, a recorded
// path that is no longer on disk — returns null and lets the caller resolve live. That self-healing
// miss path is the whole invalidation strategy, and it is what keeps --extract independent of
// --plan having run first.
function cachedSessionFiles(repoRoot, projectsDir, sessionId, gitRunner) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(corpusCachePath(repoRoot, gitRunner), "utf8"));
  } catch {
    return null;
  }
  if (doc?.projectsDir !== projectsDir) return null;
  const files = doc?.sessions?.[sessionId];
  if (!Array.isArray(files) || !files.length) return null;
  // A transcript rotated or deleted since --plan wrote the cache is the likeliest miss of all, and
  // a list naming one no longer describes the session: re-resolve rather than stat a path that is
  // gone (a raw ENOENT out of --extract) or read around it (a partial session mined as if whole).
  return files.every((f) => existsSync(f)) ? files : null;
}

// The durable store the map stage writes and both the reduce stage and every later dream
// read (spec §5.4). Local-only under the already-gitignored .devcycle/, so nothing is added
// to .gitignore. The engine only *reads* it: which sessions have a file is the mining work
// list, and that list is what makes a marginal run cheaper rather than merely asserted to be.
export const observationsDir = (repoRoot) => join(dreamDir(repoRoot), "observations");

// The staged corpus mines more than sessions — the memory store and each archive are slices
// too — so the skill needs the store's actual contents to derive each stage's work list, not
// just the session-shaped subset `unmined` reports.
export function listObservations(repoRoot) {
  const dir = observationsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

// Spec §5.4's observation-kind enum, extended with "win" (L2) so the miner can file a
// grounded success, not only a corrective. A typo here must fail loud rather than silently
// seeding a garbage grouping key the reduce stage would then cluster on.
const OBSERVATION_KINDS = new Set(["friction", "correction", "rule-violation", "decision", "contradiction-side", "win"]);

// Mirrors validatePromotion's style and error-message shape (`scripts/promotions.mjs`, the
// one validator of the other record shape this engine writes). `subject` and `quote`
// are the two fields §5.4 calls load-bearing: `subject` is the cross-session grouping key
// and `quote` is the grounding anchor ("an observation may state only what its quote
// shows"), so both are required rather than merely typed.
function validateObservation(rec, index) {
  if (!OBSERVATION_KINDS.has(rec?.kind))
    throw new Error(
      `record ${index}: invalid kind "${rec?.kind}" — must be one of: ${[...OBSERVATION_KINDS].join(", ")}`,
    );
  if (!String(rec.subject ?? "").trim()) throw new Error(`record ${index}: subject is required and cannot be empty`);
  if (!String(rec.quote ?? "").trim()) throw new Error(`record ${index}: quote is required and cannot be empty`);
  if (rec.target !== null && typeof rec.target !== "string")
    throw new Error(`record ${index}: target must be a repo-relative path or null`);
  // Lenient on exact format — an absent/null `ts` stays valid, preserving back-compat (QC2)
  // with observation files already on disk that predate the field.
  if (rec.ts != null && typeof rec.ts !== "string")
    throw new Error(`record ${index}: ts must be an ISO-8601 string or absent`);
}

// The observation store's validating reader (spec §15's 2026-08-05 amendment). Without it,
// an existence-only check let a truncated file left by an interrupted map
// dispatch count as mined forever, and a record missing subject/quote or carrying an
// out-of-enum kind was caught by nothing. Throws rather than returning partial data — a
// caller wanting the "which slice ids have a file" listing already has that in
// listObservations.
export function readObservations(repoRoot, sliceId) {
  const path = join(observationsDir(repoRoot), `${sliceId}.json`);
  if (!existsSync(path)) throw new Error(`no observation file for session: ${sliceId}`);
  let records;
  try {
    records = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`malformed observation file (invalid JSON): ${sliceId}`);
  }
  if (!Array.isArray(records)) throw new Error(`malformed observation file (not an array): ${sliceId}`);
  records.forEach((rec, i) => validateObservation(rec, i));
  return records;
}

// The resume mechanism used to be "does a file exist", so a truncated file left by an interrupted
// dispatch counted as mined forever — the exact failure the validation was written for, never
// reached because it only ran inside the dispatch that had just succeeded. A slice is mined when
// its observation file PARSES, not when it is present.
export function isMined(repoRoot, id) {
  try {
    readObservations(repoRoot, id);
    return true;
  } catch {
    return false;
  }
}

// One utterance mined into several sibling session/observation files (a parent transcript plus
// its subagent transcripts) is one observation, not N. Identity is the verbatim quote plus the
// message timestamp; `ts` absent (older files) falls back to the quote alone. Normalizing
// whitespace keeps a re-wrapped copy from reading as distinct.
const normalizeQuote = (q) => String(q ?? "").replace(/\s+/g, " ").trim();
export const observationKey = (rec) =>
  createHash("sha256").update(normalizeQuote(rec.quote)).digest("hex") + "|" + (rec.ts ?? "");
export function dedupeObservations(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const key = observationKey(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}
// Every mined slice's observations, concatenated then deduped — the reduce stage's whole view of
// the store. Returns the raw `total`, the post-dedup `unique` count, and the deduped `observations`
// so a caller can report how much collapsing the dedup did. Skips slices whose file no longer
// parses (same tolerance as isMined) rather than throwing the whole reduce away for one bad file.
export function readAllObservations(repoRoot) {
  const all = [];
  for (const slice of listObservations(repoRoot)) {
    try { all.push(...readObservations(repoRoot, slice)); } catch { /* unparseable slice skipped */ }
  }
  const observations = dedupeObservations(all);
  return { total: all.length, unique: observations.length, observations };
}

export function readCheckpoint(repoRoot) {
  const p = statePath(repoRoot);
  if (!existsSync(p)) return { lastDreamedThrough: null, lastArtifact: null };
  const text = readFileSync(p, "utf8");
  const literal = (v) => (!v || v === "never" || v === "none" ? null : v);
  return {
    lastDreamedThrough: literal(fieldText(text, "last-dreamed-through")),
    lastArtifact: literal(fieldText(text, "last-artifact")),
  };
}

export function writeCheckpoint(repoRoot, { lastDreamedThrough, lastArtifact }) {
  mkdirSync(dreamDir(repoRoot), { recursive: true });
  atomicWrite(
    statePath(repoRoot),
    "# dreaming checkpoint\n" +
      `- last-dreamed-through: ${lastDreamedThrough ?? "never"}\n` +
      `- last-artifact: ${lastArtifact ?? "none"}\n`,
  );
}

const DATED_ARTIFACT_RE = /^\d{4}-\d{2}-\d{2}-dream\.md$/;

function latestArtifactFile(repoRoot) {
  const dir = dreamDir(repoRoot);
  if (!existsSync(dir)) return null;
  const dated = readdirSync(dir).filter((f) => DATED_ARTIFACT_RE.test(f)).sort();
  const latest = dated.at(-1);
  return latest ? join(dir, latest) : null;
}

// Fresh only when no in-range session is newer than the range the artifact actually
// covers — `since`, the checkpoint boundary the artifact was written against. Compares
// full ISO-8601 instants (not just the artifact filename's calendar date), so an artifact
// written and checkpointed on the same day a session lands later that same day correctly
// goes stale instead of reading fresh forever after.
export function artifactFresh(repoRoot, since, sessions = []) {
  const path = latestArtifactFile(repoRoot);
  if (!path) return { fresh: false, path: null };
  // `since = null` means the checkpoint has never advanced — nothing has been mined yet,
  // so there is no covered range the artifact could be fresh *against*.
  if (!since) return { fresh: false, path };
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return { fresh: false, path };
  // Instants, never strings: `commitCheckpoint` accepts "+HH:MM" offsets and minute
  // precision, and a lexicographic compare reads "T12:00:00+02:00" (=10:00Z) as later than
  // "T11:00:00Z" — which turns the dream into a permanent no-op on the first non-UTC call.
  // Self sessions are skipped here on every call, whatever `excludeSelf` was: a dream's own
  // session sits in its own corpus, and letting it count makes `fresh` permanently false.
  const newestMs = sessions.reduce((max, s) => {
    if (s.self) return max;
    const t = Date.parse(s.lastTimestamp);
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, sinceMs);
  return { fresh: newestMs <= sinceMs, path };
}

// Accepts the ISO-8601 UTC-instant forms a caller would reasonably emit: optional
// fractional seconds, optional seconds at all (minute precision), and either a literal
// "Z" or a numeric "+HH:MM"/"-HH:MM" offset — not just the one exact shape this repo's
// own `writeCheckpoint` happens to write.
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isIsoInstant = (s) => typeof s === "string" && ISO_INSTANT_RE.test(s) && !Number.isNaN(Date.parse(s));

// The only writer of last-dreamed-through: validates the instant, then records which
// artifact (if any) this checkpoint now covers — the vehicle artifactFresh above and a
// later run both need, and the one thing nothing previously populated.
export function commitCheckpoint(repoRoot, iso) {
  if (!isIsoInstant(iso)) throw new Error(`invalid ISO-8601 timestamp: ${JSON.stringify(iso ?? null)}`);
  const prev = readCheckpoint(repoRoot);
  const latest = latestArtifactFile(repoRoot);
  const lastArtifact = latest ? relative(repoRoot, latest) : prev.lastArtifact;
  writeCheckpoint(repoRoot, { lastDreamedThrough: iso, lastArtifact });
  return { lastDreamedThrough: iso, lastArtifact };
}

// Two branches finished the same day are ordinary (finishing-the-cycle names archives
// `archive-<date>-<branch-slug>`), so grouping by date alone produced byte-identical
// entries a reader couldn't tell apart or address. Each archive now gets an `id`/`index`
// disambiguator derived only from sort order — never from the directory name, which
// still must not reach the manifest — plus its evidence files listed by name (not by
// path, so the branch-slugged parent directory never appears) so a reader has enough to
// actually work with, per the manifest's own established file-list pattern.
function archives(repoRoot) {
  const dir = join(repoRoot, ".devcycle");
  if (!existsSync(dir)) return [];
  const byDate = new Map();
  for (const d of readdirSync(dir).filter((d) => /^archive-\d{4}-\d{2}-\d{2}-/.test(d)).sort()) {
    const date = d.slice("archive-".length, "archive-".length + 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(d);
  }
  const out = [];
  for (const [date, names] of byDate) {
    names.forEach((name, i) => {
      const full = join(dir, name);
      const ev = join(full, "evidence");
      const hasLedger = existsSync(join(full, "ledger.md"));
      const evidenceFiles = existsSync(ev) ? readdirSync(ev).sort() : [];
      out.push({
        id: `${date}-${i + 1}`,
        date,
        index: i + 1,
        evidenceFiles,
        evidenceCount: evidenceFiles.length,
        // A glob keyed on date, never the real directory name — the branch slug must not reach
        // the manifest. `index` travels inside this value rather than only beside it: two
        // archives finished on one day share the glob, and a consumer that uses the string
        // alone reads whichever entry sorts first. A reader sorts the glob's expansion and
        // takes the `index`-th entry.
        ledger: hasLedger ? { glob: `.devcycle/archive-${date}-*/ledger.md`, index: i + 1 } : null,
      });
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.index - b.index);
}

// devcycle's own dreaming/doctor sessions echo a run's own output back into their own
// transcript — corpus for a later run — so mining them can re-attribute this run's findings to
// the sessions that reported them. Excluded from `artifactFresh` on every call (a dream's own
// session must not make its own artifact stale); `excludeSelf` drops them from the mining
// corpus too. The ids are the commands that run these two scripts. `dreaming-across-sessions`
// is the pre-v0.12 id for what is now `learn`, kept for transcripts that may carry it: this is
// a shipped plugin, so v0.11-era transcripts exist on installed machines even though none of
// the transcripts readable here carry the id. Dropping it would re-admit every dream recorded
// before the rename.
const SELF_ATTRIBUTION_RE = /^devcycle:(learn|dreaming-across-sessions|doctor)$/;
function isSelfRecord(r) {
  if (SELF_ATTRIBUTION_RE.test(r.attributionSkill ?? "")) return true;
  const content = r.message?.content;
  if (!Array.isArray(content)) return false;
  // Nothing devcycle emits today reaches this arm — the plugin ships no skills, and
  // validate.mjs check 3 forbids naming a playbook by a `devcycle:` id — so it is here for
  // pre-v0.12 transcripts alone, on the same reasoning as the retired id above.
  for (const item of content)
    if (
      item &&
      item.type === "tool_use" &&
      item.name === "Skill" &&
      typeof item.input?.skill === "string" &&
      SELF_ATTRIBUTION_RE.test(item.input.skill)
    )
      return true;
  return false;
}

// Extracts a record's actual message text rather than dumping the raw transcript line: a
// consumer of `--extract` gets what the model wrote, with JSON.parse having already turned
// each escape back into the character it stands for — never the JSONL bytes around it.
// F3: role and timestamp are what make a correction slice a correction slice, and tool_result is
// where an AskUserQuestion answer actually lives — doctor reports AskUserQuestion turns for
// sessions whose extracted text held none of them. Prefixing rather than returning a structure
// keeps every existing caller (defaultReadText, extractSession, the F4 byte sum) working on a
// string, and gives each observation record a real per-message `ts` to carry.
export function messageText(record) {
  const role = record.message?.role ?? record.type ?? "unknown";
  const ts = record.timestamp ?? "";
  const content = record.message?.content;
  const parts = [];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content))
    for (const c of content) {
      if (!c) continue;
      if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
      // A tool_result's content is either a string or the same block array again.
      else if (c.type === "tool_result") {
        if (typeof c.content === "string") parts.push(c.content);
        else if (Array.isArray(c.content))
          for (const b of c.content) if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
  if (!parts.length) return "";
  return `[${ts}] ${role}: ${parts.join("\n")}`;
}

function defaultReadText(session) {
  const parts = [];
  for (const f of session.files) eachRecord(f, (r) => { parts.push(messageText(r)); });
  return parts.join("\n");
}

// The one subcommand that emits message text, by definition (spec §3.1). It is called by a
// map dispatch reading its own slice, never by a path that writes the manifest — which is what
// keeps the manifest's redaction property intact. Deliberately not routed through planCorpus:
// the 100-session cap and the checkpoint window bound *mining*, and a caller holding a session
// id must be able to read that session's text regardless of either.
export function extractSession({ repoRoot, projectsDir, sessionId, gitRunner, includeOversized = false }) {
  const files = cachedSessionFiles(repoRoot, projectsDir, sessionId, gitRunner)
    ?? resolveProjectFiles(repoRoot, projectsDir, gitRunner).files.filter((f) => owningSession(f) === sessionId);
  if (!files.length) throw new Error(`no transcript for session: ${sessionId}`);
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  if (!includeOversized && bytes > MAX_SESSION_BYTES)
    throw new Error(
      `session ${sessionId} is ${bytes} bytes, over the ${MAX_SESSION_BYTES}-byte ceiling; ` +
        `re-run with --include-oversized to mine it anyway`,
    );
  return defaultReadText({ files });
}

// Claude Code's real project-directory convention: every character that is not
// alphanumeric becomes its own "-", not just "/" — a repo path containing "_" or "."
// (e.g. "Hobby_Programming", "site.com") previously computed a slug that never existed,
// mining zero sessions and reporting success as if none had ever run.
const escapeProjectPath = (p) => p.replace(/[^A-Za-z0-9]/g, "-");

// Mirrors scripts/doctor.mjs's own `findTranscriptFiles` contract at its one caller
// (`run()`, doctor.mjs:622-625): `null` (missing or unreadable) is not silently the same
// as an empty result. A path that simply does not exist yet is "nothing mined here
// before" — not a failure. A path that exists but cannot be read (permission denied, or
// something other than a directory sitting where one is expected) is a genuine failure,
// and must surface as one rather than as an empty, indistinguishable-from-success corpus.
function readTranscriptsOrFail(dir, label) {
  const files = findTranscriptFiles(dir);
  if (files !== null) return files;
  if (!existsSync(dir)) return null;
  throw new Error(`${label} exists but could not be read: ${dir}`);
}

// A worktree path that no longer exists must degrade to its literal form, never throw: the
// corpus of a deleted worktree is still worth resolving.
const realpathOr = (p) => { try { return realpathSync(p); } catch { return p; } };

// The learn corpus spans every live worktree of the invoking repo, not only the exact-cwd
// checkout: each worktree is a distinct project slug, so the common path enumerates them
// (`git worktree list`, one call — never a per-session git call, keeping the machine-wide scan
// spec §10 rejected out of the hot path) and unions their slug dirs. Sessions from a *sibling
// project* never enter: an enumerated slug is this repo's own worktree, and the whole-root
// fallback filters on git-repo identity. Documented gaps: a deleted worktree (gone from
// `git worktree list`) and a session launched from a subdir of a worktree (its slug is the
// subdir, not the worktree root — a pre-existing gap for the main checkout too).
// The FIRST record carrying a `cwd` decides. This narrows the previous
// `readRecords(file).some(...)`, which accepted a match from any record in the file: a session
// that cd'd from another repo into this one used to match and no longer does. Deliberate — a
// session's cwd is fixed in practice, and it is the only version that bounds the whole-root
// fallback, which otherwise parses every transcript the user has ever produced in full.
//
// `read` is injected for the same reason `statFile` and `gitRunner` are: the early exit is a
// resource bound, and a bound asserted any way other than by counting calls through a
// collaborator is the shape issues #89 and #154 record (QC6).
export function sessionRepoMatches(file, mineTop, topOf, read = eachRecord) {
  let matched = false;
  read(file, (r) => {
    if (!r.cwd) return true;
    matched = topOf(r.cwd) === mineTop;
    return false;
  });
  return matched;
}

// Per-process memo, keyed on (repoRoot, projectsDir): those two arguments are the entire input to
// the resolve. `gitRunner` is a test seam over the same repo, never a second corpus, so it is
// deliberately not part of the key. There is no invalidation, which is what "per-process" means:
// dream.mjs runs as a short-lived CLI over a corpus that does not change under it, and a stale
// entry cannot outlive the process that made it.
const resolveCache = new Map();

export function resolveProjectFiles(repoRoot, projectsDir, gitRunner) {
  const key = `${repoRoot} ${projectsDir}`;
  let hit = resolveCache.get(key);
  if (hit === undefined) resolveCache.set(key, (hit = resolveUncached(repoRoot, projectsDir, gitRunner)));
  return hit;
}

function resolveUncached(repoRoot, projectsDir, gitRunner) {
  // Both the literal and the realpath-resolved slug, unioned: replacing the literal one would
  // silently change the slug computed for any path reached through a symlink (macOS /tmp ->
  // /private/tmp), while the union can only ever find more.
  const roots = [...new Set(worktreeRoots(repoRoot, gitRunner).flatMap((r) => [r, realpathOr(r)]))];
  const primary = [...new Set(roots.flatMap((r) =>
    readTranscriptsOrFail(join(projectsDir, escapeProjectPath(r)), "project directory") ?? []))];
  if (primary.length) return { files: primary, corpusResolution: "primary" };

  const all = readTranscriptsOrFail(projectsDir, "projects root");
  if (all === null) throw new Error(`projects root does not exist: ${projectsDir}`);
  // Memoize per distinct cwd so the whole-root fallback issues at most one `git` call per cwd
  // (spec Component 3): the scan reads every session under the projects root, and a sibling
  // project repeats one cwd across all its transcripts. gitToplevel never returns undefined, so
  // it is a safe cache-miss sentinel. repoRoot is resolved through the same cache.
  const topCache = new Map();
  const topOf = (cwd) => {
    let top = topCache.get(cwd);
    if (top === undefined) topCache.set(cwd, (top = gitToplevel(cwd, gitRunner)));
    return top;
  };
  const mineTop = topOf(repoRoot);
  return { files: all.filter((f) => sessionRepoMatches(f, mineTop, topOf)), corpusResolution: "fallback" };
}

// F5: a slice id that is only the session id can never reopen when the session grows, so every
// byte written after the first mining pass was invisible forever — the exact window in which a
// recurrence would appear. The id now carries the slice's own size and a content hash, so growth
// produces a new id, a new work item, and a new observation file beside the old one.
export const sliceId = (sessionId, bytes, digest) => `${sessionId}@${bytes}-${digest}`;
export const sliceSessionId = (id) => String(id).split("@")[0];

// Phase A: rank candidates from filesystem metadata alone. Nothing here opens a transcript, so
// the cost of deciding WHICH sessions to mine no longer scales with how many have ever existed.
// Note this is only content-free when the primary slug lookup hits; on the fallback path
// resolveProjectFiles must itself probe every transcript under the projects root.
export function planCandidates({ repoRoot, projectsDir, since, cap = CAP, gitRunner, statFile = statSync, includeOversized = false }) {
  const { files, corpusResolution } = resolveProjectFiles(repoRoot, projectsDir, gitRunner);
  const groups = new Map();
  for (const file of files) {
    const id = owningSession(file);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(file);
  }

  const sinceMs = since ? Date.parse(since) : null;
  const candidates = [];
  const oversized = [];
  for (const [id, sessionFiles] of groups) {
    let bytes = 0;
    let mtimeMs = 0;
    for (const f of sessionFiles) {
      const st = statFile(f);
      bytes += st.size;
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
    }
    // Conservative in one direction only: a record's timestamp cannot postdate the write that
    // stored it, so a session whose newest file predates the checkpoint holds no in-window
    // record. This can over-keep (a copied file) and never under-keeps; Phase B's exact
    // inWindow test is what actually decides membership.
    if (sinceMs != null && Number.isFinite(sinceMs) && mtimeMs < sinceMs) continue;
    // Recorded only where the ceiling is what excluded the session, and so only after the window
    // test: `oversized` is the list the learn playbook's cost gate reads out to the user as
    // "skipped without being read", which an out-of-window session this run would never have mined
    // is not, and neither is one --include-oversized then content-reads and mines.
    if (bytes > MAX_SESSION_BYTES && !includeOversized) {
      oversized.push({ id, bytes });
      continue;
    }
    candidates.push({ id, files: sessionFiles, mtimeMs, bytes });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { candidates, oversized, corpusResolution };
}

// `reader` is injected for the same reason `statFile` and `gitRunner` are, and is the pair the
// spec's §C10 names: one content read per surviving file is a resource bound, and a bound asserted
// any way other than by counting calls through a collaborator is the shape issues #89 and #154
// record. Defaults to the real streaming reader, so no caller changes.
export function planCorpus({ repoRoot, projectsDir, since, cap = CAP, excludeSelf = false, gitRunner, statFile = statSync, reader = eachRecord, includeOversized = false, writeCache = false }) {
  const { candidates, oversized, corpusResolution } =
    planCandidates({ repoRoot, projectsDir, since, cap, gitRunner, statFile, includeOversized });

  const sessions = [];
  let readFiles = 0;
  let readSessions = 0;
  // Phase B: the only place a transcript's contents are read. One streaming pass per file
  // replaces the previous readFileSync plus two readRecords calls.
  for (const candidate of candidates.slice(0, cap + RANK_MARGIN)) {
    readSessions += 1;
    const stamps = [];
    let records = 0;
    let self = false;
    let bytes = 0;
    let extractBytes = 0;
    const hash = createHash("sha256");
    for (const f of candidate.files) {
      readFiles += 1;
      const { bytes: fileBytes } = reader(f, (r) => {
        records += 1;
        if (r.timestamp) stamps.push(r.timestamp);
        if (!self && isSelfRecord(r)) self = true;
        // F4: the model-visible size the same way `--extract` does, reused from messageText
        // rather than a second extractor (QC2 of the original spec).
        extractBytes += Buffer.byteLength(messageText(r));
      }, { onChunk: (chunk) => hash.update(chunk) });
      bytes += fileBytes;
    }
    if (!stamps.length) continue;
    // Both this and the excludeSelf rejection below consume a candidate slot Phase A could not
    // foresee — self-ness and timestamp presence are knowable only by reading — so a run can
    // return fewer than `cap` sessions. RANK_MARGIN absorbs a small number of these. If
    // excludeSelf ever becomes reachable (it is false at every present call site), Phase B must
    // refill from the remaining candidates rather than returning short.
    if (excludeSelf && self) continue;
    stamps.sort();
    const lastTimestamp = stamps.at(-1);
    if (!inWindow(lastTimestamp, since, null)) continue;
    sessions.push({
      id: candidate.id,
      files: candidate.files,
      firstTimestamp: stamps[0],
      lastTimestamp,
      records,
      bytes,
      self,
      slice: sliceId(candidate.id, bytes, hash.digest("hex").slice(0, 8)),
      extractBytes,
    });
  }

  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  // Counted over Phase A's candidates, not Phase B's survivors, because Phase B only ever looks at
  // cap + RANK_MARGIN of them. Phase A's mtime filter over-keeps by design, so in a skew case
  // (a session whose newest file was touched inside the window but whose records all predate it)
  // this reports `true` where an exact filter would have said `false`. The over-report is accepted:
  // `capped: true` is read as "a bounded run", and claiming a bound that did not quite bite is the
  // harmless direction, where missing one that did would hide a truncated corpus.
  const capped = candidates.length > cap;
  const kept = sessions.slice(0, cap);
  // artifactFresh now sees the survivor list rather than every in-window session. It reduces to a
  // single max over non-self sessions, and mtime ranking keeps exactly the newest, so the result
  // is preserved except in one case: if every survivor is a self-session while a non-self one
  // sits below the margin, `fresh` flips from false to true.
  const { fresh, path } = artifactFresh(repoRoot, since, sessions);

  if (writeCache) {
    // atomicWrite does not create directories — writeCheckpoint does its own mkdirSync for the
    // same reason. The directory must come from the cache path itself: dreamDir(repoRoot) is
    // join(repoRoot, ".devcycle", "dreaming"), while the cache lives under the git TOPLEVEL, and
    // those are different directories in exactly the subdirectory case the cache exists to serve
    // — creating one and writing into the other throws ENOENT rather than degrading.
    mkdirSync(dirname(corpusCachePath(repoRoot, gitRunner)), { recursive: true });
    atomicWrite(corpusCachePath(repoRoot, gitRunner), JSON.stringify({
      resolvedAt: new Date().toISOString(),
      projectsDir,
      corpusResolution,
      sessions: Object.fromEntries(kept.map((s) => [s.id, s.files])),
    }, null, 2) + "\n");
  }

  return {
    since: since ?? null,
    cap,
    capped,
    sessions: kept,
    // Which lookup produced the corpus. A whole-root fallback used to be entirely silent.
    corpusResolution,
    // In-window sessions this run excluded by MAX_SESSION_BYTES, never content-read. Mine one with
    // --include-oversized, under which nothing is skipped for size and this list is empty.
    oversized,
    // Read counters, so a test can assert the bound by counting rather than by timing.
    readSessions,
    readFiles,
    // `records` alone let a dispatch be handed an unreadable 22.6 MB slice with no warning,
    // and a run cannot be budgeted without a size. Totals cover the kept sessions only, so the
    // number describes what a run would actually mine rather than what the cap discarded.
    // F4: this is JSONL on disk, not what a dispatch reads — see extractBytes below for the
    // budgeting number. Stays for a caller sizing disk reads.
    totalBytes: kept.reduce((n, s) => n + s.bytes, 0),
    // F4: totalBytes is JSONL on disk and overstated model-visible input ~34× on this repo's own
    // corpus. It stays — a caller sizing disk reads still wants it — but the budgeting number a
    // run is planned against is the extract sum, which is what a dispatch actually reads.
    extractBytes: kept.reduce((n, s) => n + s.extractBytes, 0),
    // The mining work list: an interrupted run resumes by mining only these, which is the same
    // mechanism that makes a marginal run cheap. Keyed by each session's `slice`, not its bare
    // `id` (F5) — so a grown session reopens under its new id — and mined means the observation
    // file PARSES (isMined), not merely exists (the happy-path validation gap).
    observations: listObservations(repoRoot),
    unmined: kept.filter((s) => !isMined(repoRoot, s.slice)).map((s) => s.slice),
    // F6: a dispatch that wrote its file under a truncated name leaves a store entry the manifest
    // cannot address. Naming it is the whole fix — the alternative is a slice that is re-mined
    // every run with nobody able to see why.
    orphanObservations: listObservations(repoRoot).filter((o) => !kept.some((s) => s.slice === o)),
    archives: archives(repoRoot).filter((a) => inWindow(`${a.date}T23:59:59Z`, since, null)),
    // Same escaping as the transcript project directory above: every non-alphanumeric
    // character becomes "-". Replacing only "/" points at a store that does not exist
    // for any repo path containing "." or "_".
    memoryDir: join(homedir(), ".claude", "projects", escapeProjectPath(repoRoot), "memory"),
    artifactFresh: fresh,
    artifactPath: path,
    // D3 step 1: the journal is already structured, so it is read directly rather than mined —
    // it needs no observation file and never appears in `unmined`. `empty` describes the store,
    // which is what lets the report say "journal empty" instead of "nothing found".
    journal: (() => {
      const { journalEmpty, events, runs } = journalEvents({ toplevel: repoRoot, since });
      return { empty: journalEmpty, events: events.length, runs };
    })(),
  };
}

// CLAUDE_DREAM_PROJECTS overrides the transcript root, mirroring doctor.mjs's
// CLAUDE_DOCTOR_PROJECTS; it exists so the CLI is testable without scanning ~/.claude.
const resolveProjectsRoot = () => process.env.CLAUDE_DREAM_PROJECTS || join(homedir(), ".claude", "projects");

// Spec §7's always-loaded byte budget gates LANDED output only (QC6): the r2 digest lines and any
// r1 always-loaded prose this run lands, minus the bytes a same-run eviction reclaims. r0/r3 are
// not always-loaded and never count. The pinned candidate schema (QC1) carries no landed-line
// text, so each landed always-loaded candidate is measured by the digest line it lands — the
// `- <title> [<culpritId>]` shape lessons.md stores (`LESSON_RE`) — which is real, title-proportional
// growth rather than a vacuous constant. just-me-scoped candidates land only in the user's personal
// store and never touch the committed docs/devcycle/lessons.md this ceiling protects, so they are
// excluded from the sum.
export function alwaysLoadedNetBytes(candidates, root) {
  const landed = (candidates.candidates ?? []).filter(
    (c) => c.disposition === "landed" && (c.rung === "r1" || c.rung === "r2") && c.scope !== "just-me",
  );
  const added = landed.reduce((n, c) => n + Buffer.byteLength(`- ${c.title} [${c.culpritId}]`), 0);
  // An eviction reclaims the exact line it removes from the capped store; read its current bytes so
  // a run that lands one line and evicts a longer one nets negative rather than being over-counted.
  const reclaimed = (candidates.evictions ?? []).reduce((n, e) => {
    const line = readSection(repoStorePath(root), e.section).find((l) => lessonId(l) === e.culpritId);
    return n + (line ? Buffer.byteLength(line) : 0);
  }, 0);
  return added - reclaimed;
}

// A same-run reclaim: the pinned candidate schema (QC1) has no dedicated retirement field, and an
// eviction is exactly the removal of a landed lesson from the capped always-loaded store — the
// concrete "made room this run" signal spec §7's gate turns on.
const hasSameRunRetirement = (candidates) => (candidates.evictions ?? []).length > 0;

function main() {
  const argv = process.argv.slice(2);
  const root = process.cwd();

  // §9's guard requirement covers every subcommand against every other, not only the pairs
  // someone thought of: each handler below dispatches and returns, so an unguarded combination
  // silently runs one and omits the other's output entirely — read by a caller parsing for that
  // output's key, the omission reads as a confident (and wrong) answer. Enumerated once rather
  // than pairwise, which cost five lines per flag added.
  const SUBCOMMANDS = [
    "--plan", "--commit-checkpoint", "--check-suppressed", "--extract", "--check-observations",
    "--record-promotion", "--record-lifecycle", "--check-recurrence", "--journal-events", "--legacy-similar",
    "--novel-slugs", "--lessons", "--render-report", "--match", "--lesson",
    "--observations-deduped", "--plan-landing", "--staleness",
  ];
  const present = SUBCOMMANDS.filter((f) => argv.includes(f));
  if (present.length > 1) {
    console.error(`dream: ${present.join(" and ")} cannot be combined`);
    process.exit(1);
  }

  const hasPlan = argv.includes("--plan");
  const hasCheckRecurrence = argv.includes("--check-recurrence");
  // A modifier, not a subcommand: deliberately outside SUBCOMMANDS so it does not trip the
  // mutual-exclusivity check above.
  const hasRunChecks = argv.includes("--run-checks");
  const commitIdx = argv.indexOf("--commit-checkpoint");
  const hasCommit = commitIdx !== -1;
  const suppressedIdx = argv.indexOf("--check-suppressed");
  const hasSuppressed = suppressedIdx !== -1;
  const extractIdx = argv.indexOf("--extract");
  const hasExtract = extractIdx !== -1;
  const observationsIdx = argv.indexOf("--check-observations");
  const hasCheckObservations = observationsIdx !== -1;
  const r = argv.indexOf("--record-promotion");
  const hasRecord = r !== -1;

  if (hasExtract) {
    try {
      process.stdout.write(
        extractSession({
          repoRoot: root,
          projectsDir: resolveProjectsRoot(),
          sessionId: argv[extractIdx + 1],
          // The session id is positional and parseFlags refuses bare positionals, so presence is
          // tested directly rather than by wrapping this branch in a flag parse.
          includeOversized: argv.includes("--include-oversized"),
        }),
      );
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (hasPlan) {
    try {
      const { flags } = parseFlags(argv, {
        "--plan": "none", "--cap": "value", "--include-oversized": "none",
        // Tolerated before this branch parsed anything, and must stay tolerated: it is a modifier,
        // not a subcommand, so it never trips the mutual-exclusivity guard above either.
        "--run-checks": "none",
      });
      const cap = requireCount(flags, "--cap") ?? CAP;
      const plan = planCorpus({
        repoRoot: root,
        projectsDir: resolveProjectsRoot(),
        since: readCheckpoint(root).lastDreamedThrough,
        cap,
        includeOversized: flags["--include-oversized"] === true,
        writeCache: true,
      });
      console.log(JSON.stringify(plan, null, 2));
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (hasCommit) {
    try {
      commitCheckpoint(root, argv[commitIdx + 1]);
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    console.log("checkpoint: ok");
    return;
  }

  if (hasRecord && argv[r + 1]) {
    try {
      console.log(recordPromotion(root, JSON.parse(argv[r + 1])));
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // A retirement/revert is written through the promotions store's own lifecycle writer, which tags
  // it so it never reads back as a landing. Mirrors --record-promotion's guard/parse/print style.
  const lifecycleIdx = argv.indexOf("--record-lifecycle");
  if (lifecycleIdx !== -1) {
    try {
      const arg = argv[lifecycleIdx + 1];
      if (!arg) throw new Error("--record-lifecycle requires a JSON record argument");
      console.log(recordLifecycle(root, JSON.parse(arg)));
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // Gives readObservations a real caller: the Map dispatch verifies the slice it just wrote
  // via this subcommand rather than the skill re-reading the file itself ("the skill invokes
  // the CLI, not the module"). Reports pass/fail only — never the records themselves, which
  // would put a subject or a quote into this session's own transcript.
  if (hasCheckObservations) {
    try {
      const sliceId = argv[observationsIdx + 1];
      if (!sliceId) throw new Error("--check-observations requires a session id argument");
      readObservations(root, sliceId);
      console.log("observations: ok");
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // The shared verification engine (scripts/verification.mjs) is the one owner of the recurrence
  // math — this prints its full output: `{ scoreboard, candidates, resolvedIn }`. The engine's 2nd
  // argument is the events ARRAY (it does `journalEvents.filter(...)`), and the installed version is
  // the running plugin's own manifest, never an env var.
  if (hasCheckRecurrence) {
    try {
      console.log(
        JSON.stringify(
          verify(readPromotions(root), journalEvents({ toplevel: root }).events, installedVersion(),
            { root, ...(hasRunChecks ? { runCheck: defaultRunCheck } : {}) }),
          null,
          2,
        ),
      );
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // The reduce stage's suppression check, called by the skill as a subcommand — the skill
  // invokes the CLI, not the module. The verdict is an equality test on a culprit-id, so the
  // id is safe to print: an id is matched in the promotion store and never against transcript
  // text, which is what makes echoing it unable to self-seed a later run.
  if (hasSuppressed) {
    try {
      const culpritId = argv[suppressedIdx + 1];
      if (!culpritId) throw new Error("--check-suppressed requires a culprit-id argument");
      // A culprit-id is a single token. Extra argv elements mean the caller passed something
      // else — most plausibly an unquoted title the shell split — and answering for the first
      // element alone would report on an id that was never actually checked.
      const trailing = [];
      for (let i = suppressedIdx + 2; i < argv.length && !argv[i].startsWith("--"); i++) trailing.push(argv[i]);
      if (trailing.length)
        throw new Error("--check-suppressed requires a single culprit-id argument, not several");
      console.log(JSON.stringify({ suppressed: suppressedByCulpritId(culpritId, readPromotions(root)) }));
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (argv.includes("--journal-events")) {
    try {
      const sinceIdx = argv.indexOf("--since");
      const { journalEmpty, events } = journalEvents({
        toplevel: root, since: sinceIdx === -1 ? null : argv[sinceIdx + 1],
      });
      const byCulprit = Object.fromEntries([...eventsByCulprit(events)].map(([k, v]) => [k, v]));
      console.log(JSON.stringify({ journalEmpty, events, byCulprit }, null, 2));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  if (argv.includes("--novel-slugs")) {
    try {
      console.log(JSON.stringify({ slugs: novelSlugs(readPromotions(root)) }));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  // The reduce stage's deduped view of the observation store: one utterance mined across sibling
  // session files collapses to a single record here, so occurrence counts are not inflated. It
  // legitimately reads content, unlike --check-observations, which only reports pass/fail.
  if (argv.includes("--observations-deduped")) {
    try {
      console.log(JSON.stringify(readAllObservations(root), null, 2));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  const legacyIdx = argv.indexOf("--legacy-similar");
  if (legacyIdx !== -1) {
    try {
      const title = argv[legacyIdx + 1];
      if (!title) throw new Error("--legacy-similar requires a title argument");
      console.log(JSON.stringify({
        hints: legacySimilar(title, readPromotions(root)).map((p) => ({ path: p.path, title: p.title })),
      }));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  const lessonsIdx = argv.indexOf("--lessons");
  if (lessonsIdx !== -1) {
    try {
      const stage = argv[lessonsIdx + 1];
      if (!STAGES.includes(stage))
        throw new Error(`unknown stage "${stage}" — must be one of: ${STAGES.join(", ")}`);
      process.stdout.write(renderLessons(stage, {
        repo: readSection(repoStorePath(root), stage),
        userRepo: readSection(userRepoStorePath(root), stage),
        userGlobal: readSection(userGlobalStorePath(), stage),
      }));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  const matchIdx = argv.indexOf("--match");
  if (matchIdx !== -1) {
    try {
      const KNOWN = {
        "--match": "none", "--stage": "value", "--files": "value",
        "--culprits": "value", "--keywords": "value",
      };
      const { flags } = parseFlags(argv, KNOWN);
      const stage = flags["--stage"];
      if (!STAGES.includes(stage)) throw new Error(`--match needs a valid --stage (one of ${STAGES.join(", ")})`);
      const files = parseFileList(flags["--files"] ?? "");
      const culprits = parseFileList(flags["--culprits"] ?? "");
      const keywords = (flags["--keywords"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const lessonLines = [
        ...readSection(repoStorePath(root), stage),
        ...readSection(userRepoStorePath(root), stage),
        ...readSection(userGlobalStorePath(), stage),
      ];
      const out = renderMatch(matchLessons({ lessonLines, promotions: readPromotions(root), files, culprits, keywords }));
      const maint = renderMaintenanceMatches(
        matchMaintenanceFindings({ records: readMaintenanceFindings(root), files, cap: MATCH_CAP }),
      );
      const combined = [out, maint].filter((s) => s && s.length).join("\n");
      if (combined) process.stdout.write(combined + "\n");
      return;
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
  }

  const lessonPullIdx = argv.indexOf("--lesson");
  if (lessonPullIdx !== -1) {
    try {
      const id = argv[lessonPullIdx + 1];
      const rec = findPromotionById(readPromotions(root), id);
      if (!rec) { console.error(`no record for ${id}`); process.exit(1); }
      process.stdout.write(readFileSync(join(root, rec.path), "utf8"));
      return;
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
  }

  const renderIdx = argv.indexOf("--render-report");
  if (renderIdx !== -1) {
    try {
      const path = argv[renderIdx + 1];
      if (!path) throw new Error("--render-report requires a candidate file path");
      const candidates = JSON.parse(readFileSync(path, "utf8"));
      const budget = budgetStatus(alwaysLoadedNetBytes(candidates, root), hasSameRunRetirement(candidates));
      // Spec §7's hard gate: refuse growth past the always-loaded ceiling unless this run also
      // reclaims room (a same-run eviction/retirement). The report is never even written for a
      // refused run — the byte figure and the ceiling are named so the caller can act.
      if (!budget.withinBudget) {
        console.error(
          `dream: always-loaded budget exceeded — this run adds ${budget.netBytes} net bytes, past the ` +
            `${ALWAYS_LOADED_CEILING}-byte ceiling; retire a lesson in the same run to make room`,
        );
        process.exit(1);
      }
      // The verification engine's own candidates, not a default: without this argument
      // learn-report.mjs falls back to empty arrays and both candidate sections render
      // "(none this run)" for candidates the engine did compute. No --run-checks mode is
      // plumbed here on purpose — verification.mjs:110-117 skips every r3 row with a runnable
      // check before the escalation and retirement pushes, so a run check cannot change one
      // byte of this report.
      const verification = verify(
        readPromotions(root),
        journalEvents({ toplevel: root }).events,
        installedVersion(),
        { root },
      );
      process.stdout.write(renderLearnReport({
        candidates, promotions: readPromotions(root), outcome: argv.includes("--outcome"),
        verification, budget,
      }));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  // The eviction tie-break has one owner: this module. It used to ship twice — as
  // lessons.mjs's planLanding and as prose telling the model to apply the same ordering by
  // hand — and only the unreachable copy was tested. The culprit-id is read off the line
  // rather than passed alongside it: a separate argument could disagree with the line it
  // describes.
  const planLandingIdx = argv.indexOf("--plan-landing");
  if (planLandingIdx !== -1) {
    try {
      const flag = (name) => {
        const i = argv.indexOf(name);
        return i === -1 ? null : argv[i + 1] ?? null;
      };
      const stage = flag("--stage");
      if (!stage || !STAGES.includes(stage))
        throw new Error(`--stage must name a stage in the enum, got ${stage ?? "nothing"}`);
      const line = flag("--line");
      const culpritId = line ? lessonId(line) : null;
      if (!culpritId) throw new Error("--line requires a lesson line ending in a [culprit-id]");
      const store = flag("--store") ?? "repo";
      const paths = {
        repo: () => repoStorePath(root),
        "user-repo": () => userRepoStorePath(root),
        "user-global": () => userGlobalStorePath(),
      };
      if (!paths[store]) throw new Error(`--store must be repo, user-repo or user-global, got ${store}`);
      console.log(JSON.stringify(planLanding({
        stage,
        line,
        culpritId,
        existing: readSection(paths[store](), stage),
        events: journalEvents({ toplevel: root }).events,
        promotions: readPromotions(root),
      })));
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // The staleness probe finishing-the-cycle.md runs at cycle end: reads the distilling
  // checkpoint's own `last-run:` (learning-from-sessions.md owns that file) and reports whether
  // enough unmined sessions or days have accrued to warrant another /devcycle:learn pass. It is a
  // read-only nudge — it advances no checkpoint and mines nothing. Reuses planCandidates (QC2)
  // for the unmined-session count rather than re-walking transcripts.
  if (argv.includes("--staleness")) {
    try {
      const { flags } = parseFlags(argv, {
        "--staleness": "none", "--max-sessions": "value", "--max-days": "value", "--cap": "value",
      });
      const cap = requireCount(flags, "--cap") ?? CAP;
      const maxSessions = requireCount(flags, "--max-sessions") ?? 5;
      const maxDays = requireCount(flags, "--max-days") ?? 14;
      const dsPath = join(root, ".devcycle", "distilling-state.md");
      const lastRun = existsSync(dsPath) ? (fieldText(readFileSync(dsPath, "utf8"), "last-run") || null) : null;
      // `never` (or an empty/missing line) means the corpus was never mined — the strongest stale
      // signal, and never a real `since:` to filter the corpus against.
      const literal = lastRun && lastRun !== "never" ? lastRun : null;
      // Only the count is needed, so Phase A alone answers it — this used to run a full plan,
      // reading every transcript in the corpus, to read one number. The mtime-approximate since
      // boundary is adequate for a nudge that asks only whether enough sessions have accrued.
      const { candidates } = planCandidates({ repoRoot: root, projectsDir: resolveProjectsRoot(), since: literal, cap });
      const unminedSessions = Math.min(candidates.length, cap);
      // QC1: an unminable age is `null`, never `0` — a never-mined corpus has no elapsed days, and
      // reading that as zero days would falsely read as "just mined".
      const daysSince = literal ? Math.floor((Date.now() - Date.parse(literal)) / 86400000) : null;
      const stale = literal == null || unminedSessions >= maxSessions
        || (daysSince != null && daysSince >= maxDays);
      console.log(JSON.stringify(
        { stale, unminedSessions, daysSince, lastRun: literal, threshold: { maxSessions, maxDays } },
        null, 2));
    } catch (e) { console.error(`dream: ${e.message}`); process.exit(1); }
    return;
  }

  console.error(
    "usage: dream.mjs --plan [--cap N] [--include-oversized] | --extract <session-id> [--include-oversized] | " +
      "--commit-checkpoint <iso> | --record-promotion <json> | " +
      "--record-lifecycle <json> | " +
      "--check-recurrence [--run-checks] | --check-suppressed <culprit-id> | --check-observations <slice-id> | " +
      "--journal-events [--since <iso>] | --legacy-similar <title> | --novel-slugs | --observations-deduped | --lessons <stage> | " +
      "--match --stage <stage> --files <csv> [--culprits <csv>] [--keywords <csv>] | --lesson <id> | " +
      "--render-report <candidates.json> [--outcome] | " +
      "--plan-landing --stage <stage> --line \"<lesson line>\" [--store repo|user-repo|user-global] | " +
      "--staleness [--max-sessions N] [--max-days M] [--cap N]",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
