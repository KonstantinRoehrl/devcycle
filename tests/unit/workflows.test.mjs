// Structural, deterministic checks against the two release workflows that had no suite:
// back-merge.yml and bump-version.yml. Same approach as prepare-release.test.mjs — raw text plus
// regex, no YAML parser, no workflow execution. What these pin is the contract CONTRIBUTING.md
// § Releasing states: back-merge is green and silent on a clean merge, red only on a genuine
// conflict, and opens a fallback PR only on a push event; Release refuses to re-tag.
import test from "node:test";
import assert from "node:assert/strict";
import { read, parseJobs } from "./workflow-yaml.mjs";

const BACK_MERGE = ".github/workflows/back-merge.yml";
const RELEASE = ".github/workflows/bump-version.yml";

test("back-merge: the fallback PR opens only on a push event", () => {
  const yaml = read(BACK_MERGE);
  const guard = yaml.match(/if \[ "\$EVENT" = "push" \]; then\n([\s\S]*?)\n\s*fi\n/);
  assert.ok(guard, 'no `if [ "$EVENT" = "push" ]` guard found in back-merge.yml');
  assert.match(
    guard[1],
    /gh pr create/,
    "the `gh pr create` fallback is outside the push guard — a scheduled or dispatched run would open a PR"
  );
  assert.equal(
    (yaml.match(/gh pr create/g) ?? []).length,
    1,
    "more than one `gh pr create` in back-merge.yml — only the guarded fallback may create a PR"
  );
});

test("back-merge: a conflict aborts the half-done merge before escalating", () => {
  const yaml = read(BACK_MERGE);
  const abortAt = yaml.indexOf("git merge --abort");
  const errorAt = yaml.indexOf("::error::");
  assert.ok(abortAt !== -1, "no `git merge --abort` — a conflicted merge would be left in the tree");
  assert.ok(errorAt !== -1, "no `::error::` escalation on the conflict path");
  assert.ok(abortAt < errorAt, "`git merge --abort` must run before the escalation, not after");
});

test("back-merge: the push retries with a rebase pull and gives up after three attempts", () => {
  const yaml = read(BACK_MERGE);
  assert.match(yaml, /until git push origin HEAD:dev; do/, "no retry loop around the push to dev");
  assert.match(yaml, /if \[ "\$n" -ge 3 \]/, "the retry loop has no attempt cap");
  assert.match(yaml, /git pull --rebase origin dev/, "the retry loop does not rebase before retrying");
});

test("back-merge: a clean run exits 0 without touching anything when dev already has main", () => {
  const yaml = read(BACK_MERGE);
  assert.match(
    yaml,
    /behind=\$\(git rev-list --count origin\/dev\.\.origin\/main\)/,
    "no behind-count — the workflow cannot tell an already-merged dev from a stale one"
  );
  assert.match(yaml, /if \[ "\$behind" -eq 0 \]; then[\s\S]{0,200}?exit 0/, "no early exit 0 on behind=0");
});

test("back-merge: permissions are least-privilege — read at the top, elevated only on the job", () => {
  const yaml = read(BACK_MERGE);
  assert.match(yaml, /^permissions:\n {2}contents: read$/m, "top-level permissions are not `contents: read`");
  const job = parseJobs(yaml)["back-merge"];
  assert.ok(job, "no `back-merge` job found");
  const body = job.join("\n");
  assert.match(body, /^ {6}contents: write/m, "the job does not elevate to `contents: write` to push");
  assert.match(body, /^ {6}pull-requests: write/m, "the job cannot open the fallback PR");
});

test("back-merge: concurrent runs queue rather than cancel each other", () => {
  const yaml = read(BACK_MERGE);
  assert.match(yaml, /^concurrency:\n {2}group: back-merge\n {2}cancel-in-progress: false$/m,
    "back-merge has no serialized concurrency group — a cancelled merge could leave dev behind");
});

test("release: an existing tag means nothing to release, and exits 0 rather than failing", () => {
  const yaml = read(RELEASE);
  const guard = yaml.match(
    /if git rev-parse -q --verify "refs\/tags\/devcycle--v\$V" >\/dev\/null; then\n([\s\S]*?)\n\s*fi\n/
  );
  assert.ok(guard, "no `refs/tags/devcycle--v$V` existence guard — every push to main would try to tag");
  assert.match(guard[1], /exit 0/, "the tag guard does not exit 0 — a non-release push to main would go red");
});

test("release: tagging and publishing never runs unless validate passed", () => {
  const yaml = read(RELEASE);
  const jobs = parseJobs(yaml);
  assert.ok(jobs.release, "no `release` job found");
  assert.match(
    jobs.release.join("\n"),
    /^ {4}needs: validate$/m,
    "the release job has no `needs: validate` — a commit that reached main unchecked would be published"
  );
  assert.match(
    yaml,
    /^ {4}uses: \.\/\.github\/workflows\/validate\.yml$/m,
    "no job-level call to validate.yml — the suite does not run in-line before the release"
  );
});

test("release: permissions are least-privilege — read at the top, write only on the release job", () => {
  const yaml = read(RELEASE);
  assert.match(yaml, /^permissions:\n {2}contents: read$/m, "top-level permissions are not `contents: read`");
  assert.match(
    parseJobs(yaml).release.join("\n"),
    /^ {6}contents: write$/m,
    "the release job does not elevate to `contents: write` to push the tag"
  );
});

test("release: the checkout is pinned to a full commit sha and stores no push credential", () => {
  const yaml = read(RELEASE);
  assert.match(
    yaml,
    /uses: actions\/checkout@[0-9a-f]{40} #/,
    "actions/checkout is not pinned to a full 40-character commit sha with a version comment"
  );
  assert.match(yaml, /persist-credentials: false/,
    "the checkout leaves a push credential in .git/config for later steps to read");
});
