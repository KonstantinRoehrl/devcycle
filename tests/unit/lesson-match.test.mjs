import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { recordMaintenanceFinding } from "../../scripts/maintenance-findings.mjs";
import { matchedLessons } from "../../scripts/lesson-match.mjs";

const GUARD = '- Guard the thing [novel:guard-thing] → node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lesson novel:guard-thing';
const QUOTE = '- Quote the plugin root [novel:quote-root] → node "${CLAUDE_PLUGIN_ROOT}/scripts/dream.mjs" --lesson novel:quote-root';
const WRAPPER = "- known dead-abstraction concern, persisting since 2026-08-10 (3 passes): pass-through wrapper [dead-abstraction:beef0001]";

// The user stores live under DEVCYCLE_LEARNINGS_DIR, read at call time; each test gets its own.
function withLearnings(fn) {
  const prior = process.env.DEVCYCLE_LEARNINGS_DIR;
  process.env.DEVCYCLE_LEARNINGS_DIR = makeTempDir("lesson-match-learn-");
  try {
    return fn(process.env.DEVCYCLE_LEARNINGS_DIR);
  } finally {
    if (prior === undefined) delete process.env.DEVCYCLE_LEARNINGS_DIR;
    else process.env.DEVCYCLE_LEARNINGS_DIR = prior;
  }
}

// A repo whose execution lesson and persisting maintenance finding both name scripts/x.mjs.
function store() {
  const root = realpathSync(makeTempDir("lesson-match-"));
  mkdirSync(join(root, "docs/devcycle/promotions"), { recursive: true });
  writeFileSync(join(root, "docs/devcycle/lessons.md"), "# Lessons\n\n## execution\n- Guard the thing [novel:guard-thing]\n");
  writeFileSync(join(root, "docs/devcycle/promotions/2026-08-16-guard-thing.md"),
    "# Guard the thing\n- files-touched: scripts/x.mjs\n- affected-files: scripts/*.mjs\n- culprit-id: novel:guard-thing\n");
  recordMaintenanceFinding(root, {
    findingKind: "maintenance-finding", findingId: "dead-abstraction:beef0001", culpritKind: "dead-abstraction",
    title: "pass-through wrapper", severity: "high", confidence: "verified",
    affectedFiles: ["scripts/x.mjs"], firstSeen: "2026-08-10", lastSeen: "2026-08-22", passes: 3,
  });
  return root;
}

test("matchedLessons renders a file's lessons, then its persisting maintenance findings, with no trailing newline", () =>
  withLearnings(() => {
    const root = store();
    assert.equal(matchedLessons({ root, stage: "execution", files: ["scripts/x.mjs"] }), `${GUARD}\n${WRAPPER}`);
  }));

test("matchedLessons reads the user stores for the stage too, an exact file match ranked first", () =>
  withLearnings((learnings) => {
    const root = store();
    mkdirSync(join(learnings, "global"), { recursive: true });
    writeFileSync(join(learnings, "global/lessons.md"), "# Lessons\n\n## execution\n- Quote the plugin root [novel:quote-root]\n");
    writeFileSync(join(root, "docs/devcycle/promotions/2026-08-17-quote-root.md"),
      "# Quote the plugin root\n- affected-files: scripts/x.mjs\n- culprit-id: novel:quote-root\n");
    assert.equal(matchedLessons({ root, stage: "execution", files: ["scripts/x.mjs"] }), `${QUOTE}\n${GUARD}\n${WRAPPER}`);
  }));

test("matchedLessons is empty for an unrelated file, and culprits and keywords narrow the lessons only", () =>
  withLearnings(() => {
    const root = store();
    assert.equal(matchedLessons({ root, stage: "execution", files: ["other/z.md"] }), "");
    assert.equal(matchedLessons({ root, stage: "planning", files: ["scripts/x.mjs"] }), WRAPPER);
    assert.equal(matchedLessons({ root, stage: "execution", files: ["scripts/x.mjs"], culprits: ["novel:other"] }), WRAPPER);
    assert.equal(matchedLessons({ root, stage: "execution", files: ["scripts/x.mjs"], keywords: ["guard"] }), `${GUARD}\n${WRAPPER}`);
  }));
