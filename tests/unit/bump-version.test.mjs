import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bumpLevel,
  nextVersion,
  notesForVersion,
  changelogWithSection,
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

test("bumpLevel: a BREAKING CHANGE body trailer promotes to major", () => {
  assert.equal(bumpLevel(["fix(a): x"], "BREAKING CHANGE: the flag is gone"), "major");
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
  const out = changelogWithSection("# Changelog\n\n## 0.11.0\n\n- old\n", "0.12.0", "- new");
  assert.match(out, /^# Changelog\n\n## 0\.12\.0\n\n- new\n\n## 0\.11\.0\n/);
  assert.equal(notesForVersion(out, "0.12.0"), "- new");
  assert.equal(notesForVersion(out, "0.11.0"), "- old");
});
