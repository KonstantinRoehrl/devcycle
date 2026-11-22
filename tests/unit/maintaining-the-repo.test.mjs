import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pb = readFileSync(join(root, "playbooks/maintaining-the-repo.md"), "utf8");
const folding = () => readFileSync(join(root, "references/issue-folding.md"), "utf8");

test("orientation is graph-first via the extracted helper with an Explore fallback", () => {
  assert.match(pb, /graph-availability\.mjs/);
  assert.match(pb, /Explore/);
});

test("a deterministic-facts pre-pass runs, reusing duplication-check.mjs", () => {
  assert.match(pb, /deterministic/i);
  assert.match(pb, /duplication-check\.mjs/);
});

test("orientation feeds a hotspot list to --match, not the whole tree", () => {
  assert.match(pb, /hotspot/i);
  assert.match(pb, /--match|--files/);
});

test("depth gates the lenses: standard adds abstraction, thorough adds history", () => {
  assert.match(pb, /maintenance depth/i);
  assert.match(pb, /standard[^\n]*abstraction/i);
  assert.match(pb, /thorough[^\n]*history/i);
});

test("history is dispatched at the fast tier within its traversal bound", () => {
  assert.match(pb, /history-inspector/);
  assert.match(pb, /fast tier/i);
});

test("fan-out ceiling: bounded concurrent + total lenses with a hard stop", () => {
  assert.match(pb, /at most 5|5 concurrent/i);
  assert.match(pb, /at most 9 total LLM dispatches/);
  assert.match(pb, /\+ 1 sweep verification/);
  assert.match(pb, /hard stop|20%/i);
});

test("still read-only: starts no cycle, writes no state file", () => {
  assert.match(pb, /read-only/i);
  assert.match(pb, /starts no cycle|no .*state file/i);
});

test("issue-folding: fetch is read-only via issue-intake.mjs, runs at all depths", () => {
  assert.match(pb, /issue-intake\.mjs/);
  assert.match(pb, /read-only/i);
  assert.match(pb, /all (profile )?depths|every depth|lean.*standard.*thorough/i);
});

test("the issue-folding reference owns the six steps, in order", () => {
  const t = folding();
  const at = ["## Fetch and screen", "## Decompose", "## Classify", "## Verify", "## Rank", "## Cluster"].map((h) => t.indexOf(`\n${h}\n`));
  assert.ok(at.every((i) => i > 0), `missing a step heading: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test("decompose-before-classify, with the #44 shape as the worked example, lives in the reference only", () => {
  assert.match(folding(), /#44/);
  assert.match(folding(), /decompos/i);
  assert.doesNotMatch(pb, /#44|Decompose before classify|whichever existing lens methodology|same severity-first ordering/);
});

test("each step that differs carries a maintain/triage switch, and only triage clusters", () => {
  const t = folding();
  const section = (h) => t.split(`\n${h}\n`)[1].split("\n## ")[0];
  for (const h of ["## Fetch and screen", "## Classify", "## Verify", "## Rank"]) {
    assert.match(section(h), /- \*\*maintain:\*\*/, `${h} has no maintain switch`);
    assert.match(section(h), /- \*\*triage:\*\*/, `${h} has no triage switch`);
  }
  assert.match(section("## Cluster"), /maintain does not cluster\./);
  assert.match(section("## Fetch and screen"), /--include-tracked/);
  assert.match(section("## Classify"), /feature[\s\S]*count/i);
  assert.match(section("## Verify"), /lens methodology/);
  assert.match(section("## Verify"), /landed commit or PR/);
  assert.match(section("## Verify"), /highest Impact level/);
  assert.match(section("## Rank"), /references\/findings\.md/);
  assert.match(section("## Rank"), /Origin: github-issue #<n>/);
  assert.match(section("## Cluster"), /\/devcycle:cycle/);
});

test("maintain step 7 reads the reference and keeps its own parts", () => {
  assert.ok(pb.includes("${CLAUDE_PLUGIN_ROOT}/references/issue-folding.md"));
  assert.match(pb, /issue-intake\.mjs" --repo <owner\/name> --scratch \.devcycle\/issue-intake\/<pass>`/);
  assert.doesNotMatch(pb, /--include-tracked/);
  assert.match(pb, /count-mismatch/);
  assert.match(pb, /coverage statement/);
  assert.match(pb, /counts\.excludedCulprit/);
});

test("the issue-folding reference issues no gh mutation", () => {
  assert.doesNotMatch(folding(), /gh\s+issue\s+(close|comment|edit|label|delete|reopen|create)\b/);
});

test("no gh issue mutation anywhere in the issue code path (playbook + script)", () => {
  const script = readFileSync(join(root, "scripts/issue-intake.mjs"), "utf8");
  assert.doesNotMatch(script, /"issue"\s*,\s*"(close|comment|edit|label|delete|reopen|transfer|pin|lock|unlock)"/);
  assert.doesNotMatch(pb, /gh\s+issue\s+(close|comment|edit|label|delete|reopen)\b/);
});

test("the pre-pass also runs the dead-export and xref checks, as advisory facts", () => {
  assert.match(pb, /dead-export-check\.mjs/);
  assert.match(pb, /xref-check\.mjs/);
  assert.match(pb, /advisory/i);
});
