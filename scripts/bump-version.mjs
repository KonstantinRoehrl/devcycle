#!/usr/bin/env node
// Prepares a release *before* it lands on main: computes the next version from the
// Conventional Commit subjects that are about to be squashed onto main, writes
// plugin.json and prepends a CHANGELOG section, and prints the new version.
//
// This runs on the integration branch, not on main. Nothing may push directly to main —
// a ruleset requires every change there to arrive through a checked pull request — so the
// version bump has to travel in the release PR itself rather than be committed afterwards.
//
// The release PR is squash-merged, so main receives exactly one commit per release and its
// subject is the PR title. That title already decided the version before this script moved
// off main — it was the only subject in range — so it is the input here, stated rather than
// re-derived. No ref-range works on the integration branch: squash merges leave dev's own
// commits out of main's ancestry forever, so `main..dev` reports long-released work as new.
//
//   --subject <s>      the release PR title; decides the bump level and the CHANGELOG entry
//   --dry-run          print "<level> <version>" and change nothing
//   --notes-for <ver>  print that version's CHANGELOG section and exit (used at tag time)
//   --date <YYYY-MM-DD>  the release date stamped on the CHANGELOG heading; defaults to today (UTC)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PLUGIN_PATH = ".claude-plugin/plugin.json";
const CHANGELOG_PATH = "CHANGELOG.md";
const CONFIG_CHANGELOG_PATH = "references/config-changelog.md";
const CC = /^(feat|fix|perf|docs|chore|ci|refactor|style|test|build)(\([a-z0-9-]+\))?(!)?: /;

/** Subjects a release counts. A subject that is not a Conventional Commit is invisible to
 *  versioning, which is why CI rejects a malformed PR title: it would ship no release. */
export const releasingSubjects = (subjects) => subjects.filter((s) => CC.test(s));

/** major on any `!` subject, minor on any feat, else patch. A `BREAKING CHANGE:` trailer is
 *  deliberately NOT a trigger: `Prepare release` takes the PR title as its only input and authors the
 *  release PR's body itself, so no body text ever reaches versioning. `!` in the title says the same
 *  thing and is the one signal this path can actually read. */
export function bumpLevel(subjects) {
  const releasing = releasingSubjects(subjects);
  if (releasing.some((s) => CC.exec(s)[3] === "!")) return "major";
  if (releasing.some((s) => s.startsWith("feat"))) return "minor";
  return "patch";
}

export function nextVersion(current, level) {
  const [MA, MI, PA] = String(current).split(".").map(Number);
  if (![MA, MI, PA].every(Number.isInteger))
    throw new Error(`current version "${current}" is not MAJOR.MINOR.PATCH`);
  if (level === "major") return `${MA + 1}.0.0`;
  if (level === "minor") return `${MA}.${MI + 1}.0`;
  return `${MA}.${MI}.${PA + 1}`;
}

/** One version's CHANGELOG section, heading stripped — the GitHub release body. Returns null
 *  when there is no such section or it is empty, so the caller fails loudly rather than
 *  publishing a release that says nothing about what shipped. */
export function notesForVersion(changelog, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Deliberately no `m` flag: with it, `$` in the lookahead matches end-of-*line*, so an
  // empty section would capture the next version's heading instead of stopping empty.
  // `(?: — \d{4}-\d{2}-\d{2})?` — the release date, added 2026-08-13 so outer-loop turnaround has
  // a per-version date to measure against. Optional, because every heading written before that
  // date carries none and `--notes-for` must still build a release body for those tags.
  const m = changelog.match(
    new RegExp(`(?:^|\\n)## ${escaped}(?: — \\d{4}-\\d{2}-\\d{2})?[ \\t]*\\n([\\s\\S]*?)(?=\\n## |$)`),
  );
  const body = m && m[1].trim();
  return body || null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const changelogWithSection = (changelog, version, notes, date) => {
  // Refused rather than written: a malformed date produces a heading that check 19 rejects and
  // that releaseDates() cannot parse, and the failure would only surface at the next release.
  if (!ISO_DATE.test(String(date))) throw new Error(`release date "${date}" is not a YYYY-MM-DD date`);
  return changelog.replace(/^# Changelog\n/, `# Changelog\n\n## ${version} — ${date}\n\n${notes}\n`);
};

/** Stamps every `version: "unreleased"` record with the version now being released, keeping the
 *  promise references/config-changelog.md:12-13 makes. Scoped to the FIRST fenced yaml block — the
 *  only one `scripts/doctor.mjs:556` parses for config drift — so the prose below it is never
 *  rewritten. A file with no pending record is the common case, not an error, and comes back
 *  unchanged. */
export function changelogWithReleasedMarkers(text, version) {
  // The closing fence is anchored to a line start, so a ``` inside a field's value cannot end
  // the block early and leave every record below it silently unstamped. `\r?` so a CRLF file is
  // stamped rather than falling into the no-op path, which looks identical to having nothing pending.
  const fence = text.match(/```yaml\r?\n[\s\S]*?^```/m);
  if (!fence) return text;
  // `[ \t]*$` rather than `\s*$`: on a CRLF file `\s*` swallows the line's `\r`, leaving the
  // stamped records the only LF-terminated lines in the file.
  const stamped = fence[0].replace(/^(\s*-\s+version:\s*)"unreleased"[ \t]*$/gm, `$1"${version}"`);
  return text.slice(0, fence.index) + stamped + text.slice(fence.index + fence[0].length);
}

function main() {
  const argv = process.argv.slice(2);

  const notesIdx = argv.indexOf("--notes-for");
  if (notesIdx !== -1) {
    const version = argv[notesIdx + 1];
    if (!version) throw new Error("--notes-for requires a version");
    const notes = notesForVersion(readFileSync(CHANGELOG_PATH, "utf8"), version);
    if (!notes) throw new Error(`CHANGELOG.md has no section for ${version}`);
    console.log(notes);
    return;
  }

  const subjectIdx = argv.indexOf("--subject");
  const subject = subjectIdx === -1 ? "" : argv[subjectIdx + 1];
  if (!subject) throw new Error("--subject requires the release PR title");
  // Refused rather than silently treated as a patch: a title outside the convention is
  // invisible to versioning, so the release would ship with no bump and no entry.
  if (!releasingSubjects([subject]).length)
    throw new Error(`release title "${subject}" is not a Conventional Commit`);

  const dateIdx = argv.indexOf("--date");
  // Defaults to today in UTC. The flag exists so tests pin a date instead of depending on
  // when they run; the release workflow leaves it off and stamps the day it stages the release.
  const date = dateIdx === -1 ? new Date().toISOString().slice(0, 10) : argv[dateIdx + 1];

  const level = bumpLevel([subject]);
  const plugin = JSON.parse(readFileSync(PLUGIN_PATH, "utf8"));
  const version = nextVersion(plugin.version, level);

  if (argv.includes("--dry-run")) {
    console.log(`${level} ${version}`);
    return;
  }

  plugin.version = version;
  writeFileSync(PLUGIN_PATH, JSON.stringify(plugin, null, 2) + "\n");
  writeFileSync(
    CHANGELOG_PATH,
    changelogWithSection(readFileSync(CHANGELOG_PATH, "utf8"), version, `- ${subject}`, date),
  );
  // The one step references/config-changelog.md:12-13 promises and nobody used to perform: a record
  // written before its release carries `version: "unreleased"` until the release computes the number.
  // Skipped when the file is absent so the script stays runnable against a minimal fixture.
  if (existsSync(CONFIG_CHANGELOG_PATH)) {
    const before = readFileSync(CONFIG_CHANGELOG_PATH, "utf8");
    const after = changelogWithReleasedMarkers(before, version);
    if (after !== before) writeFileSync(CONFIG_CHANGELOG_PATH, after);
  }
  console.log(version);
}

// CLI only, so the pure helpers above stay importable by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
