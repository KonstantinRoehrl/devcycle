#!/usr/bin/env node
// Deterministic half of devcycle's dreaming pass: checkpoint, corpus manifest, session
// cap, artifact freshness. The semantic half lives in skills/dreaming-across-sessions.
// Emits no message text, no branch names — only ids, paths, timestamps, and counts.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { findTranscriptFiles, owningSession, readRecords, inWindow } from "./doctor.mjs";

const CAP = 100;
const dreamDir = (root) => join(root, ".devcycle", "dreaming");
const statePath = (root) => join(dreamDir(root), "state.md");

// The durable store the map stage writes and both the reduce stage and every later dream
// read (spec §5.4). Local-only under the already-gitignored .devcycle/, so nothing is added
// to .gitignore. The engine only *reads* it: which sessions have a file is the mining work
// list, and that list is what makes a marginal run cheaper rather than merely asserted to be.
export const observationsDir = (repoRoot) => join(dreamDir(repoRoot), "observations");

export function hasObservations(repoRoot, sliceId) {
  return existsSync(join(observationsDir(repoRoot), `${sliceId}.json`));
}

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

// `\s*` matches a newline too, so a field left blank on its own line would otherwise let
// the capture cross into the next "- key: value" line and read that line back as the
// value. `[ \t]*` stops at the newline: it only ever captures the rest of the field's own
// line, blank or not. Also shared by readPromotions' field reader below (one regex, not two).
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

const promoDir = (root) => join(root, "docs", "devcycle", "promotions");
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
// A value that itself contained a newline could otherwise open what looks like its own
// "- key: value" line in the written record, and a later read-back would match that
// phantom line before the real one (readCheckpoint/readPromotions take the first match).
// `\r` alone and the U+2028/U+2029 line/paragraph separators are line terminators for
// `^`/`$`/`.` in JavaScript regexes too, so all of them — not just "\r?\n" — must fold.
const oneLine = (s) => String(s ?? "").replace(/\r\n|[\r\n\u2028\u2029]/g, " ").trim();

const PROMOTION_TYPES = new Set([
  "doc-edit",
  "skill-edit",
  "contradiction-resolution",
  "config-proposal",
  "extract-to-script",
]);
const LANDED_RE = /^\d{4}-\d{2}-\d{2}$/;

// `Date.parse("2026-02-30")` rolls over to March 2 in V8 instead of returning NaN, so
// `Number.isNaN(Date.parse(...))` alone accepts impossible calendar dates the shape regex
// already let through. Round-tripping through `toISOString` catches the rollover.
const isValidCalendarDate = (s) =>
  LANDED_RE.test(s) && !Number.isNaN(Date.parse(s)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function validatePromotion(rec) {
  if (!PROMOTION_TYPES.has(rec.promotionType))
    throw new Error(
      `invalid promotion-type "${rec.promotionType}" — must be one of: ${[...PROMOTION_TYPES].join(", ")}`,
    );
  if (!isValidCalendarDate(rec.landed ?? ""))
    throw new Error(`invalid landed date "${rec.landed}" — must be a real YYYY-MM-DD calendar date`);
  // Required because it is the record's entire purpose: checkRecurrence skips any
  // promotion whose signature is empty, so one recorded without it is permanently
  // invisible to the recurrence metric with nothing anywhere reporting it.
  if (!String(rec.clusterSignature ?? "").trim())
    throw new Error("cluster-signature is required and cannot be empty");
}

export function recordPromotion(repoRoot, rec) {
  validatePromotion(rec);
  mkdirSync(promoDir(repoRoot), { recursive: true });
  const slug = slugify(oneLine(rec.title));
  let path = join(promoDir(repoRoot), `${rec.landed}-${slug}.md`);
  for (let n = 2; existsSync(path); n++) path = join(promoDir(repoRoot), `${rec.landed}-${slug}-${n}.md`);
  // README.md documents files-touched as "comma-separated paths" — a plain string is the
  // documented shape; an array (the --record-promotion JSON payload's own shape) and an
  // absent value are also accepted rather than crashing after the promotion already landed.
  // Each element is sanitized on its own before joining: joining raw elements let a
  // newline (or \r, or U+2028) inside a single element forge a phantom "- landed:" line,
  // same as an unsanitized joined string would.
  const filesTouched = Array.isArray(rec.filesTouched)
    ? rec.filesTouched.map((f) => oneLine(f)).join(", ")
    : oneLine(rec.filesTouched);
  writeFileSync(
    path,
    `# ${oneLine(rec.title)}\n` +
      `- promotion-type: ${oneLine(rec.promotionType)}\n` +
      `- cluster-signature: ${oneLine(rec.clusterSignature)}\n` +
      `- files-touched: ${filesTouched}\n` +
      `- landed: ${oneLine(rec.landed)}\n` +
      `- commit: ${oneLine(rec.commit)}\n`,
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
      return {
        path: relative(repoRoot, join(dir, f)),
        title: (text.match(/^# (.*)$/m) ?? [, ""])[1].trim(),
        promotionType: field(text, "promotion-type"),
        clusterSignature: field(text, "cluster-signature"),
        filesTouched: field(text, "files-touched").split(",").map((s) => s.trim()).filter(Boolean),
        landed: field(text, "landed"),
        commit: field(text, "commit"),
      };
    });
}

// Every whitespace form a transcript can contain folds to a single separator — literal
// newline/tab/CRLF, U+2028/U+2029, and JSON-escaped "\n"/"\r"/"\t" (the two characters
// backslash+letter, for text that reaches here without having been JSON-decoded first).
// A *single* separator, never deleted: deleting instead of spacing would glue words
// split by a genuine line wrap back together but would just as wrongly glue two
// unrelated words meeting at a mid-word wrap into a spurious match.
const WHITESPACE_RE = /\\[nrt]|\r\n|[\r\n\t\u2028\u2029]/g;
const normalizePhrase = (s) =>
  String(s ?? "")
    .replace(WHITESPACE_RE, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// devcycle's own dreaming/doctor sessions echo the recurrence output (a promotion's commit,
// landed date, cluster phrasing quoted back) into their own transcript — corpus for a
// later run — so a signature could otherwise match the very run that reported it.
// Excluded from the recurrence corpus only; --plan's mining corpus still sees them.
const SELF_SKILL_RE = /^devcycle:(dreaming-across-sessions|doctor)$/;
function isSelfRecord(r) {
  if (SELF_SKILL_RE.test(r.attributionSkill ?? "")) return true;
  const content = r.message?.content;
  if (!Array.isArray(content)) return false;
  for (const item of content)
    if (
      item &&
      item.type === "tool_use" &&
      item.name === "Skill" &&
      typeof item.input?.skill === "string" &&
      SELF_SKILL_RE.test(item.input.skill)
    )
      return true;
  return false;
}

export function checkRecurrence(promotions, manifest, readText = defaultReadText) {
  // Compute each promotion's normalized signature first and bail out before reading the
  // corpus at all when none carries one — with zero promotion records (every repo's
  // first dreams) this was a full corpus read-and-normalize for nothing: 2.63 s and RSS
  // from 209 MB to 805 MB on this repo's own 65-session corpus.
  const candidates = promotions
    .map((p) => ({ p, sig: normalizePhrase(p.clusterSignature) }))
    .filter(({ sig }) => sig);
  if (!candidates.length) return [];

  // Read and normalize every session's text once, not once per promotion — re-reading and
  // re-tokenizing the whole corpus per record was the measured cost (4.6s/13.5s/43.6s for
  // 1/3/10 records).
  const sessions = manifest.sessions.map((s) => ({ ...s, normalized: normalizePhrase(readText(s)) }));
  const out = [];
  for (const { p, sig } of candidates) {
    const hits = [];
    for (const s of sessions) {
      if (s.lastTimestamp.slice(0, 10) <= p.landed) continue;
      if (s.normalized.includes(sig)) hits.push(s.id);
    }
    if (hits.length)
      out.push({ recordPath: p.path, title: p.title, commit: p.commit, landed: p.landed, hits });
  }
  return out;
}

// Extracts a record's actual message text rather than dumping the raw transcript line:
// matching over raw JSONL meant a message newline (the two characters "\" and "n" in the
// file on disk) survived normalization with the "n" read back as a stray word, so a
// phrase that happened to wrap in the transcript silently missed. Reading the decoded
// text field means JSON.parse has already turned that escape into a real newline before
// normalizePhrase (above) ever sees it.
function messageText(record) {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
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
  if (all === null) return [];
  return all.filter((f) => sessionCwdMatches(f, repoRoot));
}

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
    for (const f of files) {
      bytes += statSync(f).size;
      for (const r of readRecords(f)) {
        records += 1;
        if (r.timestamp) stamps.push(r.timestamp);
        if (!self && isSelfRecord(r)) self = true;
      }
    }
    if (!stamps.length) continue;
    // `excludeSelf` (the recurrence path) drops these sessions outright, because a printed
    // signature would self-seed a permanent hit. Freshness ignores them on every path — see
    // artifactFresh — but they stay mineable here.
    if (excludeSelf && self) continue;
    stamps.sort();
    const lastTimestamp = stamps.at(-1);
    if (!inWindow(lastTimestamp, since, null)) continue;
    sessions.push({ id, files, firstTimestamp: stamps[0], lastTimestamp, records, bytes, self });
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
    totalBytes: kept.reduce((n, s) => n + s.bytes, 0),
    // The mining work list: an interrupted run resumes by mining only these, which is the same
    // mechanism that makes a marginal run cheap.
    observations: listObservations(repoRoot),
    unmined: kept.filter((s) => !hasObservations(repoRoot, s.id)).map((s) => s.id),
    archives: archives(repoRoot).filter((a) => inWindow(`${a.date}T23:59:59Z`, since, null)),
    // Same escaping as the transcript project directory above: every non-alphanumeric
    // character becomes "-". Replacing only "/" points at a store that does not exist
    // for any repo path containing "." or "_".
    memoryDir: join(homedir(), ".claude", "projects", escapeProjectPath(repoRoot), "memory"),
    artifactFresh: fresh,
    artifactPath: path,
  };
}

// The recurrence corpus is windowed per promotion by that promotion's own `landed` date
// (done inside checkRecurrence), not by the checkpoint — so it must not itself be bounded
// by the checkpoint, or a promotion landed before the checkpoint but after by less than a
// full mining cycle would see its own recurring sessions silently excluded. The 100-session
// cap still applies, which is what keeps the comparison independent of checkpoint age (§10).
// `capped` travels alongside `hits` rather than as a bare array: an empty result and a
// corpus truncated to the 100-most-recent-session cap otherwise render identically, and
// on a repo past 100 sessions cap truncation is the normal case, not the exception.
export function runCheckRecurrence({ repoRoot, projectsDir }) {
  const manifest = planCorpus({ repoRoot, projectsDir, since: null, excludeSelf: true });
  return { capped: manifest.capped, hits: checkRecurrence(readPromotions(repoRoot), manifest) };
}

// CLAUDE_DREAM_PROJECTS overrides the transcript root, mirroring doctor.mjs's
// CLAUDE_DOCTOR_PROJECTS; it exists so the CLI is testable without scanning ~/.claude.
const resolveProjectsRoot = () => process.env.CLAUDE_DREAM_PROJECTS || join(homedir(), ".claude", "projects");

function main() {
  const argv = process.argv.slice(2);
  const root = process.cwd();

  const hasPlan = argv.includes("--plan");
  const hasCheckRecurrence = argv.includes("--check-recurrence");
  const commitIdx = argv.indexOf("--commit-checkpoint");
  const hasCommit = commitIdx !== -1;

  if (hasCommit && hasPlan) {
    console.error("dream: --commit-checkpoint and --plan cannot be combined");
    process.exit(1);
  }

  if (hasCommit && hasCheckRecurrence) {
    console.error("dream: --commit-checkpoint and --check-recurrence cannot be combined");
    process.exit(1);
  }

  const extractIdx = argv.indexOf("--extract");
  if (extractIdx !== -1) {
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

  const r = argv.indexOf("--record-promotion");
  if (r !== -1 && argv[r + 1]) {
    try {
      console.log(recordPromotion(root, JSON.parse(argv[r + 1])));
    } catch (e) {
      console.error(`dream: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (hasCheckRecurrence) {
    console.log(JSON.stringify(runCheckRecurrence({ repoRoot: root, projectsDir: resolveProjectsRoot() }), null, 2));
    return;
  }

  console.error(
    "usage: dream.mjs --plan | --extract <session-id> | --commit-checkpoint <iso> | --record-promotion <json> | --check-recurrence",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
