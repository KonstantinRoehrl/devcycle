#!/usr/bin/env node
// Deterministic half of devcycle's dreaming pass: checkpoint, corpus manifest, session
// cap, artifact freshness. The semantic half lives in playbooks/learning-from-sessions.md.
// Emits no message text, no branch names — only ids, paths, timestamps, and counts.
// The stores each have one owner, and this file is the CLI over them rather than a second
// copy: journal.mjs (run records), promotions.mjs (landed lessons), lessons.mjs (the three
// capped stores), learn-report.mjs (the report).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { findTranscriptFiles, owningSession, readRecords, inWindow } from "./doctor.mjs";
import { journalEvents, eventsByCulprit } from "./journal.mjs";
import { readPromotions, recordPromotion, recordLifecycle, suppressedByCulpritId, legacySimilar, novelSlugs, findPromotionById } from "./promotions.mjs";
import { repoStorePath, userRepoStorePath, userGlobalStorePath, readSection, renderLessons, STAGES, budgetStatus, ALWAYS_LOADED_CEILING, lessonId, matchLessons, renderMatch, planLanding } from "./lessons.mjs";
import { parseFileList } from "./task-files.mjs";
import { verify, installedVersion, defaultRunCheck } from "./verification.mjs";
import { renderLearnReport } from "./learn-report.mjs";

const CAP = 100;
const dreamDir = (root) => join(root, ".devcycle", "dreaming");
const statePath = (root) => join(dreamDir(root), "state.md");

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

// Spec §5.4's five-value enum. A typo here must fail loud rather than silently seeding a
// garbage grouping key the reduce stage would then cluster on.
const OBSERVATION_KINDS = new Set(["friction", "correction", "rule-violation", "decision", "contradiction-side"]);

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

// `\s*` matches a newline too, so a field left blank on its own line would otherwise let
// the capture cross into the next "- key: value" line and read that line back as the
// value. `[ \t]*` stops at the newline: it only ever captures the rest of the field's own
// line, blank or not.
function field(text, key) {
  const m = text.match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

export function readCheckpoint(repoRoot) {
  const p = statePath(repoRoot);
  if (!existsSync(p)) return { lastDreamedThrough: null, lastArtifact: null };
  const text = readFileSync(p, "utf8");
  const literal = (v) => (!v || v === "never" || v === "none" ? null : v);
  return {
    lastDreamedThrough: literal(field(text, "last-dreamed-through")),
    lastArtifact: literal(field(text, "last-artifact")),
  };
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
  return session.files
    .flatMap((f) => readRecords(f))
    .map(messageText)
    .join("\n");
}

// The one subcommand that emits message text, by definition (spec §3.1). It is called by a
// map dispatch reading its own slice, never by a path that writes the manifest — which is what
// keeps the manifest's redaction property intact. Deliberately not routed through planCorpus:
// the 100-session cap and the checkpoint window bound *mining*, and a caller holding a session
// id must be able to read that session's text regardless of either.
export function extractSession({ repoRoot, projectsDir, sessionId }) {
  const files = resolveProjectFiles(repoRoot, projectsDir).filter(
    (f) => owningSession(f) === sessionId,
  );
  if (!files.length) throw new Error(`no transcript for session: ${sessionId}`);
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

function sessionCwdMatches(file, repoRoot) {
  return readRecords(file).some((r) => r.cwd === repoRoot);
}

// Safety net scripts/doctor.mjs's resolveDepth already has and this engine lacked: when
// the (correctly escaped) slug directory doesn't exist at all, fall back to a search of
// the whole projects root rather than reporting an empty corpus — the same fallback
// doctor.mjs:135-138 uses when its own slug misses. Kept repo-scoped by filtering on each
// session's own recorded `cwd`, so a sibling project's sessions still never leak in; this
// is the fallback path only, not the common case, so it does not reintroduce the
// machine-wide scan spec §10's amendment rejected on cost and leakage grounds.
function resolveProjectFiles(repoRoot, projectsDir) {
  const repoProjectDir = join(projectsDir, escapeProjectPath(repoRoot));
  const direct = readTranscriptsOrFail(repoProjectDir, "project directory");
  if (direct !== null) return direct;
  const all = readTranscriptsOrFail(projectsDir, "projects root");
  // A repo with no project directory yet is normal (handled by the fallback above). A
  // projects root that does not exist at all is not: the transcript source is absent, and
  // reporting an empty corpus at exit 0 is the silent swallow §9 forbids.
  if (all === null) throw new Error(`projects root does not exist: ${projectsDir}`);
  return all.filter((f) => sessionCwdMatches(f, repoRoot));
}

// F5: a slice id that is only the session id can never reopen when the session grows, so every
// byte written after the first mining pass was invisible forever — the exact window in which a
// recurrence would appear. The id now carries the slice's own size and a content hash, so growth
// produces a new id, a new work item, and a new observation file beside the old one.
export const sliceId = (sessionId, bytes, digest) => `${sessionId}@${bytes}-${digest}`;
export const sliceSessionId = (id) => String(id).split("@")[0];

export function planCorpus({ repoRoot, projectsDir, since, cap = CAP, excludeSelf = false }) {
  const groups = new Map();
  for (const file of resolveProjectFiles(repoRoot, projectsDir)) {
    const id = owningSession(file);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(file);
  }

  const sessions = [];
  for (const [id, files] of groups) {
    const stamps = [];
    let records = 0;
    let self = false;
    let bytes = 0;
    const hash = createHash("sha256");
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      bytes += Buffer.byteLength(raw);
      hash.update(raw);
      for (const r of readRecords(f)) {
        records += 1;
        if (r.timestamp) stamps.push(r.timestamp);
        if (!self && isSelfRecord(r)) self = true;
      }
    }
    if (!stamps.length) continue;
    // `excludeSelf` drops devcycle's own sessions from the mining corpus outright. Freshness
    // ignores them on every path — see artifactFresh — but by default they stay mineable here.
    if (excludeSelf && self) continue;
    stamps.sort();
    const lastTimestamp = stamps.at(-1);
    if (!inWindow(lastTimestamp, since, null)) continue;
    // F4: the model-visible size the same way `--extract` does, reused from messageText rather
    // than a second extractor (QC2).
    let extractBytes = 0;
    for (const f of files)
      for (const r of readRecords(f)) extractBytes += Buffer.byteLength(messageText(r));
    const slice = sliceId(id, bytes, hash.digest("hex").slice(0, 8));
    sessions.push({
      id,
      files,
      firstTimestamp: stamps[0],
      lastTimestamp,
      records,
      bytes,
      self,
      slice,
      extractBytes,
    });
  }

  sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  const capped = sessions.length > cap;
  const kept = sessions.slice(0, cap);
  const { fresh, path } = artifactFresh(repoRoot, since, sessions);

  return {
    since: since ?? null,
    cap,
    capped,
    sessions: kept,
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
    "--observations-deduped", "--plan-landing",
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
      const { lastDreamedThrough } = readCheckpoint(root);
      console.log(
        JSON.stringify(
          planCorpus({ repoRoot: root, projectsDir: resolveProjectsRoot(), since: lastDreamedThrough }),
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
      const argVal = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
      const stage = argVal("--stage");
      if (!STAGES.includes(stage)) throw new Error(`--match needs a valid --stage (one of ${STAGES.join(", ")})`);
      const files = parseFileList(argVal("--files") ?? "");
      const lessonLines = [
        ...readSection(repoStorePath(root), stage),
        ...readSection(userRepoStorePath(root), stage),
        ...readSection(userGlobalStorePath(), stage),
      ];
      const out = renderMatch(matchLessons({ lessonLines, promotions: readPromotions(root), files }));
      if (out) process.stdout.write(out + "\n");
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

  console.error(
    "usage: dream.mjs --plan | --extract <session-id> | --commit-checkpoint <iso> | --record-promotion <json> | " +
      "--record-lifecycle <json> | " +
      "--check-recurrence [--run-checks] | --check-suppressed <culprit-id> | --check-observations <slice-id> | " +
      "--journal-events [--since <iso>] | --legacy-similar <title> | --novel-slugs | --observations-deduped | --lessons <stage> | " +
      "--match --stage <stage> --files <csv> [--culprits <csv>] [--keywords <csv>] | --lesson <id> | " +
      "--render-report <candidates.json> [--outcome] | " +
      "--plan-landing --stage <stage> --line \"<lesson line>\" [--store repo|user-repo|user-global]",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
