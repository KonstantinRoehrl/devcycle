import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  SECTION_CAP, STAGES, repoStorePath, userRepoStorePath, userGlobalStorePath,
  readSection, renderLessons, planLanding, applyLanding,
} from "../../scripts/lessons.mjs";
import { readFileSync } from "node:fs";

function storeFile(text) {
  const p = join(mkdtempSync(join(tmpdir(), "devcycle-lessons-")), "lessons.md");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

const TWO = `# Lessons

## executing-waves
- Pin the model tier in every dispatch [friction:model-inherited-not-pinned]
- Capture the whole gate, never a subset [friction:partial-evidence-capture]

## branch-review
- Re-review the blocking finding, never assume it fixed [friction:reviewer-role-confusion]
`;

test("readSection returns only the named stage's lines", () => {
  const p = storeFile(TWO);
  assert.deepEqual(readSection(p, "executing-waves"), [
    "- Pin the model tier in every dispatch [friction:model-inherited-not-pinned]",
    "- Capture the whole gate, never a subset [friction:partial-evidence-capture]",
  ]);
  assert.equal(readSection(p, "branch-review").length, 1);
});

test("a missing store is empty, not an error", () => {
  assert.deepEqual(readSection(join(tmpdir(), "no-such-devcycle-lessons.md"), "execution"), []);
});

test("a stage with no section is empty, not an error", () => {
  assert.deepEqual(readSection(storeFile(TWO), "on-device"), []);
});

test("renderLessons labels all three stores and caps each independently", () => {
  const many = Array.from({ length: 20 }, (_, i) => `- Lesson ${i} [friction:l${i}]`);
  const out = renderLessons("execution", { repo: many, userRepo: [], userGlobal: ["- Mine [friction:x]"] });
  assert.match(out, /repo \(docs\/devcycle\/lessons\.md\)/);
  assert.match(out, /user, this repo/);
  assert.match(out, /user, global/);
  assert.equal((out.match(/^- Lesson /gm) ?? []).length, SECTION_CAP,
    "each store is capped on its own, so a reader sees at most 15 lines per store");
  assert.match(out, /user, this repo[^\n]*\n\(none\)/,
    "an empty store says so — a silent gap reads as a store that was never consulted");
});

test("landing into a section under the cap needs no eviction", () => {
  const res = planLanding({
    stage: "execution", line: "- New lesson [friction:new]", culpritId: "friction:new",
    existing: ["- One [friction:a]"], events: [], promotions: [],
  });
  assert.equal(res.fits, true);
  assert.equal(res.eviction, null);
});

test("landing into a full section proposes the least-recently-recurred line", () => {
  const existing = Array.from({ length: SECTION_CAP }, (_, i) => `- Lesson ${i} [friction:l${i}]`);
  const events = [
    { runId: "a".repeat(16), culprit: "friction:l0", ts: "2026-08-01T00:00:00Z" },
    { runId: "a".repeat(16), culprit: "friction:l1", ts: "2026-08-09T00:00:00Z" },
  ];
  const res = planLanding({
    stage: "execution", line: "- New [friction:new]", culpritId: "friction:new",
    existing, events, promotions: [],
  });
  assert.equal(res.fits, false);
  assert.deepEqual(res.eviction, { culpritId: "friction:l0", section: "execution", reason: "cap" });
});

test("with an empty journal the tiebreak is the oldest landed date, not an undefined order", () => {
  const existing = Array.from({ length: SECTION_CAP }, (_, i) => `- Lesson ${i} [friction:l${i}]`);
  const promotions = [
    { culpritId: "friction:l5", landed: "2026-01-01", aliases: [] },
    { culpritId: "friction:l2", landed: "2026-06-01", aliases: [] },
  ];
  const res = planLanding({
    stage: "execution", line: "- New [friction:new]", culpritId: "friction:new",
    existing, events: [], promotions,
  });
  assert.equal(res.eviction.culpritId, "friction:l5",
    "cold start is exactly when this ordering must be defined");
});

test("a line whose id has neither a recurrence nor a landed date sorts oldest-first, deterministically", () => {
  const existing = Array.from({ length: SECTION_CAP }, (_, i) => `- Lesson ${i} [friction:l${i}]`);
  const a = planLanding({ stage: "execution", line: "- N [friction:n]", culpritId: "friction:n", existing, events: [], promotions: [] });
  const b = planLanding({ stage: "execution", line: "- N [friction:n]", culpritId: "friction:n", existing, events: [], promotions: [] });
  assert.deepEqual(a.eviction, b.eviction, "two identical calls must propose the same eviction");
  assert.equal(a.eviction.culpritId, "friction:l0");
});

test("applyLanding removes the evicted line and appends the new one under its stage", () => {
  const p = storeFile(TWO);
  const text = applyLanding(p, "executing-waves", "- New lesson [friction:new]", {
    culpritId: "friction:model-inherited-not-pinned", section: "executing-waves", reason: "cap",
  });
  assert.doesNotMatch(text, /model-inherited-not-pinned/);
  assert.match(text, /^- New lesson \[friction:new\]$/m);
  assert.match(text, /Re-review the blocking finding/, "another stage's section is untouched");
});

test("applyLanding creates the stage section when the store has none", () => {
  const p = storeFile("# Lessons\n");
  const text = applyLanding(p, "finish", "- Archive briefs before deleting them [friction:x]", null);
  assert.match(text, /^## finish$/m);
  assert.match(text, /^- Archive briefs before deleting them \[friction:x\]$/m);
});

test("STAGES matches the stage enum the run-record schema declares, in the same order", () => {
  const schema = JSON.parse(readFileSync(new URL("../fixtures/run-record.schema.json", import.meta.url).pathname, "utf8"));
  const declared = schema.oneOf.find((s) => s.properties?.kind?.const === "stage").properties.stage.enum;
  assert.deepEqual(STAGES, declared,
    "this module restates the enum because the schema is a JSON fixture, not a module — so the two must be pinned to each other");
});

test("the user store paths sit under the learnings root, mirroring the runs store", () => {
  process.env.DEVCYCLE_LEARNINGS_DIR = "/tmp/learnings";
  assert.match(userRepoStorePath("/tmp/fake-repo"), /^\/tmp\/learnings\/fake-repo-[0-9a-f]{8}\/lessons\.md$/);
  assert.equal(userGlobalStorePath(), "/tmp/learnings/global/lessons.md");
  assert.match(repoStorePath("/tmp/fake-repo"), /\/tmp\/fake-repo\/docs\/devcycle\/lessons\.md$/);
});
