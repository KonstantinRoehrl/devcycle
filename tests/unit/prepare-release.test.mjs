// Structural, deterministic checks against .github/workflows/prepare-release.yml's raw text.
// This repo carries no YAML-parsing dependency (node --test only), so — matching the pattern
// already established in tests/unit/golden-path.test.mjs for the same directory — these tests
// read the file as text and assert against it with small regex-based helpers rather than a
// parser. They do not run the workflow; GitHub Actions syntax validity is not proven here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");

// Splits the `jobs:` section into { jobId: bodyText }, one entry per top-level (2-space
// indented) job key. Relies on this repo's own workflows being written with plain 2-space
// YAML indentation throughout (true of every workflow under .github/workflows/ today).
function parseJobs(yaml) {
  const bodyStart = yaml.indexOf("\njobs:\n");
  assert.ok(bodyStart !== -1, "no top-level `jobs:` key found");
  const lines = yaml.slice(bodyStart + 1).split("\n");
  const jobs = {};
  let current = null;
  for (const line of lines.slice(1)) {
    const jobHeader = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (jobHeader) {
      current = jobHeader[1];
      jobs[current] = [];
      continue;
    }
    if (current === null) continue;
    if (line.length && !/^\s/.test(line)) break; // dedented past the jobs: block entirely
    jobs[current].push(line);
  }
  return jobs;
}

test("prepare-release: validate.yml is called from a job-level `uses:`, not a step", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  // A step's `uses:` must resolve to an action manifest; calling a reusable workflow
  // (workflow_call) is only legal via `jobs.<job_id>.uses:`.
  assert.ok(
    !/^ {6}- (?:name: .*\n {8})?uses: \.\/\.github\/workflows\//m.test(yaml),
    "a step still calls a local reusable workflow via `uses:` — steps cannot run reusable workflows"
  );
  assert.match(
    yaml,
    /^ {4}uses: \.\/\.github\/workflows\/validate\.yml\s*$/m,
    "no job-level `uses: ./.github/workflows/validate.yml` found"
  );
});

test("prepare-release: the release PR job does not run until the validate job has passed", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  const jobs = parseJobs(yaml);
  const validateJobId = Object.keys(jobs).find((id) =>
    /^ {4}uses: \.\/\.github\/workflows\/validate\.yml\s*$/m.test(jobs[id].join("\n"))
  );
  assert.ok(validateJobId, "no job calls validate.yml at job level — see the preceding test");
  const prJobId = Object.keys(jobs).find((id) => jobs[id].join("\n").includes("Open the release PR"));
  assert.ok(prJobId, 'no job contains the "Open the release PR" step');
  const needsLine = jobs[prJobId].join("\n").match(/^ {4}needs:\s*(.+)$/m)?.[1] ?? "";
  assert.ok(
    needsLine.includes(validateJobId),
    `job "${prJobId}" (which opens the release PR) has no \`needs:\` on "${validateJobId}" — ` +
      "the PR can open before validation has run at all"
  );
});

test("prepare-release: the already-bumped guard reads the previously-committed version, not the post-bump working tree", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  const guardStep = yaml.match(/- name: Check whether the bump already landed[\s\S]*?(?=\n {6}- name:|\n {2}\S)/)?.[0];
  assert.ok(guardStep, 'no "Check whether the bump already landed" step found');
  assert.ok(
    !/CURRENT=\$\(node -p "require\('\.\/\.claude-plugin\/plugin\.json'\)\.version"\)/.test(guardStep),
    "the guard still reads CURRENT from the working-tree file, which the preceding bump step already mutated"
  );
  assert.match(
    guardStep,
    /git show HEAD:\.claude-plugin\/plugin\.json/,
    "the guard does not read the previously-committed version via `git show HEAD:...`"
  );
});

test("prepare-release: the guard step runs before, and gates, the bump step", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  const guardIdx = yaml.indexOf("- name: Check whether the bump already landed");
  const bumpIdx = yaml.indexOf("- name: Bump version and changelog");
  assert.ok(guardIdx !== -1 && bumpIdx !== -1, "guard or bump step not found");
  assert.ok(guardIdx < bumpIdx, "the guard step must run before the bump step whose `if:` depends on its output");

  const bumpStep = yaml.match(/- name: Bump version and changelog[\s\S]*?(?=\n {6}- name:|\n {2}\S)/)?.[0];
  assert.ok(bumpStep, '"Bump version and changelog" step not found');
  assert.match(
    bumpStep,
    /if:\s*steps\.guard\.outputs\.already-bumped\s*!=\s*'true'/,
    "the bump step has no `if:` gate on the guard's output — it always runs, even when already bumped"
  );
});

test("prepare-release: setup-node matches validate.yml's pin and reads .nvmrc, not lts/*", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  const validateYaml = read(".github/workflows/validate.yml");
  const pinLine = validateYaml.match(/^\s*- uses: actions\/setup-node@\S+ # v[\d.]+\s*$/m)?.[0]?.trim();
  assert.ok(pinLine, "validate.yml carries no discoverable setup-node pin — fixture assumption broke");
  assert.ok(
    yaml.includes(pinLine),
    `prepare-release.yml does not use the same setup-node pin as validate.yml ("${pinLine}")`
  );
  assert.ok(
    !/node-version:\s*lts\/\*/.test(yaml),
    "prepare-release.yml still pins node-version to lts/* instead of .nvmrc"
  );
  assert.match(
    yaml,
    /node-version-file:\s*"\.nvmrc"/,
    "prepare-release.yml does not read node-version-file from .nvmrc"
  );
});
