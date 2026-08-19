import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpLevel,
  nextVersion,
  notesForVersion,
  changelogWithSection,
  changelogWithReleasedMarkers,
  releasingSubjects,
} from "../../scripts/bump-version.mjs";

test("bumpLevel: a feat subject promotes to minor", () => {
  assert.equal(bumpLevel(["fix(a): x", "feat(b): y"]), "minor");
});

test("bumpLevel: no feat and no breaking change stays patch", () => {
  assert.equal(bumpLevel(["fix(a): x", "docs(b): y", "chore: z"]), "patch");
});

test("bumpLevel: a `!` subject promotes to major even alongside a feat", () => {
  assert.equal(bumpLevel(["feat(a): x", "fix(b)!: y"]), "major");
});

// `Prepare release` passes ONE thing to this script: the PR title (.github/workflows/
// prepare-release.yml:66-71). These two drive that real path via a subprocess rather than calling
// bumpLevel directly — the previous test passed a `bodies` argument no caller supplies, so it
// proved a branch production could never reach.
function bumpFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bump-"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.14.0" }) + "\n");
  return dir;
}

const SCRIPT = fileURLToPath(new URL("../../scripts/bump-version.mjs", import.meta.url));

test("release path: a `!` title is the major trigger, end to end", () => {
  const dir = bumpFixture();
  const r = spawnSync(process.execPath, [SCRIPT, "--subject", "feat(x)!: y", "--dry-run"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "major 1.0.0");
  rmSync(dir, { recursive: true, force: true });
});

test("release path: a BREAKING CHANGE trailer is NOT a trigger — no body reaches versioning", () => {
  // The release PR's body is authored by the workflow itself (gh pr create --body, prepare-release.yml
  // :140-147), so no body text exists for the script to read. A title without `!` stays a patch even
  // when the words appear in it. CONTRIBUTING.md documents `!` as the sole trigger for this reason.
  const dir = bumpFixture();
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--subject", "fix(x): drop the flag — BREAKING CHANGE: the flag is gone", "--dry-run"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "patch 0.14.1");
  rmSync(dir, { recursive: true, force: true });
});

test("bumpLevel: subjects that are not Conventional Commits are invisible to versioning", () => {
  // The exact failure the pr-title CI job exists to prevent: a malformed subject
  // contributes nothing, so a "feature" released under one ships no minor bump.
  assert.equal(bumpLevel(["Add dreaming across sessions", "9 fixes"]), "patch");
  assert.deepEqual(releasingSubjects(["Add a thing", "feat: real"]), ["feat: real"]);
});

test("nextVersion: each level moves the right component and zeroes the rest", () => {
  assert.equal(nextVersion("0.11.0", "major"), "1.0.0");
  assert.equal(nextVersion("0.11.4", "minor"), "0.12.0");
  assert.equal(nextVersion("0.11.4", "patch"), "0.11.5");
});

test("nextVersion: a malformed current version fails loudly rather than producing NaN", () => {
  assert.throws(() => nextVersion("0.11", "patch"), /not MAJOR\.MINOR\.PATCH/);
  assert.throws(() => nextVersion("v0.11.0", "patch"), /not MAJOR\.MINOR\.PATCH/);
});

const CHANGELOG = `# Changelog

## 0.12.0

- feat(dream): add dreaming across sessions
- fix(doctor): forward-fill attribution

## 0.11.0

- feat: earlier thing
`;

test("notesForVersion: returns only the requested version's entries", () => {
  assert.equal(
    notesForVersion(CHANGELOG, "0.12.0"),
    "- feat(dream): add dreaming across sessions\n- fix(doctor): forward-fill attribution",
  );
  assert.equal(notesForVersion(CHANGELOG, "0.11.0"), "- feat: earlier thing");
});

test("notesForVersion: an absent or empty section returns null, never an empty release body", () => {
  assert.equal(notesForVersion(CHANGELOG, "9.9.9"), null);
  assert.equal(notesForVersion("# Changelog\n\n## 0.1.0\n\n## 0.0.9\n\n- x\n", "0.1.0"), null);
});

test("notesForVersion: the version is matched literally, not as a regex", () => {
  // "0.1.0" must not match "0x1y0" via the dots-as-wildcards reading.
  assert.equal(notesForVersion("# Changelog\n\n## 0x1y0\n\n- nope\n", "0.1.0"), null);
});

test("changelogWithSection: prepends above every existing section", () => {
  const out = changelogWithSection("# Changelog\n\n## 0.11.0\n\n- old\n", "0.12.0", "- new", "2026-08-13");
  assert.match(out, /^# Changelog\n\n## 0\.12\.0 — 2026-08-13\n\n- new\n\n## 0\.11\.0\n/);
  assert.equal(notesForVersion(out, "0.12.0"), "- new");
  assert.equal(notesForVersion(out, "0.11.0"), "- old");
});

test("notesForVersion reads a dated heading", () => {
  const log = "# Changelog\n\n## 1.2.0 — 2026-08-13\n\n- feat(x): a thing\n\n## 1.1.0 — 2026-08-01\n\n- fix(y): older\n";
  assert.equal(notesForVersion(log, "1.2.0"), "- feat(x): a thing");
  assert.equal(notesForVersion(log, "1.1.0"), "- fix(y): older");
});

test("notesForVersion still reads an undated heading, so an old tag can still be released", () => {
  assert.equal(notesForVersion("# Changelog\n\n## 1.0.0\n\n- feat(x): a thing\n", "1.0.0"), "- feat(x): a thing");
});

test("notesForVersion returns null for an empty dated section rather than the next section", () => {
  const log = "# Changelog\n\n## 1.2.0 — 2026-08-13\n\n## 1.1.0 — 2026-08-01\n\n- fix(y): older\n";
  assert.equal(notesForVersion(log, "1.2.0"), null);
});

test("changelogWithSection writes the date it was given", () => {
  assert.match(
    changelogWithSection("# Changelog\n\n## 1.1.0 — 2026-08-01\n\n- old\n", "1.2.0", "- feat(x): new", "2026-08-13"),
    /^# Changelog\n\n## 1\.2\.0 — 2026-08-13\n\n- feat\(x\): new\n/,
  );
});

test("changelogWithSection refuses a date that is not YYYY-MM-DD rather than writing a bad heading", () => {
  assert.throws(
    () => changelogWithSection("# Changelog\n", "1.2.0", "- feat(x): new", "13-08-2026"),
    /not a YYYY-MM-DD date/,
  );
});

// references/config-changelog.md:12-13 promises the release step replaces `version: "unreleased"`
// with the version the change landed in. Before this, no script and no workflow did it — four
// records sat permanently unreleased. These pin the promise.
const FIXTURE_CHANGELOG = `# Config changelog

Prose above the block.

\`\`\`yaml
- version: "0.8.0"
  change: added
  key: gitPolicy
- version: "unreleased"
  change: added
  key: implementerModel
  note: "pool support"
- version: "unreleased"
  change: added
  key: taskReviewerModel
\`\`\`

## A section below the block

Prose that happens to mention version: "unreleased" and must not be touched.
`;

test("changelogWithReleasedMarkers: stamps every pending record with the released version", () => {
  const out = changelogWithReleasedMarkers(FIXTURE_CHANGELOG, "0.15.0");
  assert.equal((out.match(/version: "0\.15\.0"/g) ?? []).length, 2);
  assert.ok(!/- version: "unreleased"/.test(out), "a record still carries the unreleased marker");
});

test("changelogWithReleasedMarkers: leaves the released records and the prose below the block alone", () => {
  const out = changelogWithReleasedMarkers(FIXTURE_CHANGELOG, "0.15.0");
  assert.match(out, /- version: "0\.8\.0"/, "an already-released record was rewritten");
  assert.match(
    out,
    /Prose that happens to mention version: "unreleased" and must not be touched\./,
    "text outside the first yaml block was rewritten — only the block doctor parses may be stamped"
  );
});

test("changelogWithReleasedMarkers: no pending record is the common case and returns the input unchanged", () => {
  const settled = FIXTURE_CHANGELOG.replaceAll('- version: "unreleased"', '- version: "0.9.0"');
  assert.equal(changelogWithReleasedMarkers(settled, "0.15.0"), settled);
});

test("release path: a real bump stamps the config changelog alongside plugin.json and CHANGELOG.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "bump-"));
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.14.0" }) + "\n");
  writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.14.0 — 2026-08-19\n\n- old\n");
  writeFileSync(join(dir, "references", "config-changelog.md"), FIXTURE_CHANGELOG);

  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--subject", "feat(x): y", "--date", "2026-09-01"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "0.15.0");

  const stamped = readFileSync(join(dir, "references", "config-changelog.md"), "utf8");
  assert.equal((stamped.match(/version: "0\.15\.0"/g) ?? []).length, 2);
  assert.ok(!/- version: "unreleased"/.test(stamped), "the release left a pending marker behind");
  rmSync(dir, { recursive: true, force: true });
});
