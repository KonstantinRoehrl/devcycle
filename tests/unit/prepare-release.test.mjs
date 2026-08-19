// Structural, deterministic checks against .github/workflows/prepare-release.yml's raw text.
// This repo carries no YAML-parsing dependency (node --test only), so — matching the pattern
// already established in tests/unit/golden-path.test.mjs for the same directory — these tests
// read the file as text and assert against it with small regex-based helpers rather than a
// parser. They do not run the workflow; GitHub Actions syntax validity is not proven here.
import test from "node:test";
import assert from "node:assert/strict";
import { read, parseJobs } from "./workflow-yaml.mjs";

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

test("validate.yml: workflow_call declares an optional `ref` input", () => {
  const yaml = read(".github/workflows/validate.yml");
  const callTrigger = yaml.match(/^ {2}workflow_call:[\s\S]*?(?=\n {2}\S)/m)?.[0];
  assert.ok(callTrigger, "no `workflow_call:` trigger found");
  assert.match(
    callTrigger,
    /^ {4}inputs:\s*\n {6}ref:\s*\n(?: {8}.*\n)*? {8}required:\s*false\s*\n(?: {8}.*\n)*? {8}type:\s*string\s*$/m,
    "workflow_call does not declare an optional `ref` input"
  );
});

test("validate.yml: the validate job's checkout step falls back from `inputs.ref` to `github.ref`", () => {
  const yaml = read(".github/workflows/validate.yml");
  const jobs = parseJobs(yaml);
  const checkoutStep = jobs.validate?.join("\n").match(/- uses: actions\/checkout@[\s\S]*?(?=\n {6}- (?:uses|name):|\n {2}\S)/)?.[0];
  assert.ok(checkoutStep, "no checkout step found in the validate job");
  assert.match(
    checkoutStep,
    /ref:\s*\$\{\{\s*inputs\.ref\s*\|\|\s*github\.ref\s*\}\}/,
    "the validate job's checkout step does not fall back from `inputs.ref` to `github.ref`"
  );
});

test("prepare-release: the validate job passes `ref` sourced from `needs.prepare.outputs.sha`", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  const jobs = parseJobs(yaml);
  const validateJobId = Object.keys(jobs).find((id) =>
    /^ {4}uses: \.\/\.github\/workflows\/validate\.yml\s*$/m.test(jobs[id].join("\n"))
  );
  assert.ok(validateJobId, "no job calls validate.yml at job level — see the preceding test");
  const validateJobBody = jobs[validateJobId].join("\n");
  assert.match(
    validateJobBody,
    /^ {4}with:\s*\n {6}ref:\s*\$\{\{\s*needs\.prepare\.outputs\.sha\s*\}\}\s*$/m,
    "the validate job does not pass `with: ref: ${{ needs.prepare.outputs.sha }}`"
  );
});

test("prepare-release: the prepare job exposes the settled HEAD sha as a job output, captured after the push", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  assert.match(
    yaml,
    /^ {4}outputs:\s*\n(?: {6}.*\n)*? {6}sha:\s*\$\{\{\s*steps\.\S+\.outputs\.sha\s*\}\}/m,
    "the prepare job's `outputs:` block does not expose a `sha` output"
  );
  const pushIdx = yaml.indexOf("- name: Push the bump to dev");
  const shaCaptureMatch = yaml.match(/- name: [^\n]*\n(?: {8}id: (\S+)\n)?(?: {8}[^\n]*\n)*? {8}run: [^\n]*git rev-parse HEAD[^\n]*/);
  assert.ok(shaCaptureMatch, "no step found that captures `git rev-parse HEAD`");
  const shaCaptureIdx = yaml.indexOf(shaCaptureMatch[0]);
  assert.ok(
    pushIdx !== -1 && shaCaptureIdx > pushIdx,
    "the sha-capturing step does not run after the push step, so it could read an unsettled HEAD"
  );
});

test("prepare-release: the validate job's comment states it validates the exact commit, via the `ref` input", () => {
  const yaml = read(".github/workflows/prepare-release.yml");
  const validateJobComment = yaml.match(/ {2}validate:\n((?: {4}#[^\n]*\n)+)/)?.[1] ?? "";
  assert.ok(
    !/this actually validates that commit/.test(validateJobComment),
    "the validate job's comment still makes the false 'runs after, so this actually validates that commit' claim"
  );
  assert.match(
    validateJobComment,
    /ref/,
    "the validate job's comment does not mention the explicit `ref` input that now pins the commit validated"
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
