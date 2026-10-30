// references/stage-log.md owns which keys each stage logs; everything else only points at it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const OWNER = "references/stage-log.md";
const owner = () => (existsSync(join(ROOT, OWNER)) ? read(OWNER) : "");

test("the table has one row for every stage in commands/cycle.md's enum except done", () => {
  const stages = read("commands/cycle.md").match(/stage:\s*<([a-z|-]+)>/)[1].split("|").filter((s) => s !== "done");
  const firstCells = owner().split("\n").filter((l) => l.startsWith("| ")).map((l) => l.split("|")[1]);
  for (const stage of stages)
    assert.ok(firstCells.some((cell) => cell.split(",").map((s) => s.trim()).includes(stage)), `no row names ${stage}`);
});

test("every pinned key shape is in the owner, and the read-on-entry rule names the CLI", () => {
  const text = owner();
  for (const key of ["interview-batch-<n>", "research-map", "scope-written", "question-batch-<n>", "section-approved-<slug>", "builder-check",
    "feasibility-verdict", "plan-section-<slug>", "self-review-<item>", "refutation-<round>", "batch-answer", "item-<id>", "criteria-confirmed", "reproduction", "hypothesis-<n>"])
    assert.ok(text.includes(`\`${key}\``), `the owner no longer names ${key}`);
  assert.ok(text.includes('scripts/stage-log.mjs" read --state .devcycle/state.md --stage <stage>'), "no read-on-entry command");
  assert.ok(text.includes('scripts/stage-log.mjs" log --state .devcycle/state.md --stage <stage> --key <key>'), "no log command");
});

test("the apostrophe rule prescribes the JSON escape, since a literal apostrophe closes --data's single quotes", () => {
  const escape = "\\" + "u0027";
  assert.ok(owner().includes(`with no apostrophe (write \`${escape}\`)`), `the owner does not prescribe ${escape} for an apostrophe`);
  assert.equal(JSON.parse(`"don${escape}t"`), "don't");
});

test("stages without a playbook of their own get the rule from their note, and the playbooks point with one line", () => {
  const stages = JSON.parse(read("references/stages.json"));
  for (const stage of ["audit", "diagnosis", "brainstorm"]) assert.ok(stages[stage].note.includes(OWNER), `${stage}'s note does not name ${OWNER}`);
  assert.ok(stages.audit.note.includes("never assume criteria a previous session did not record"), "the audit note lost its criteria rule");
  const cite = "${CLAUDE_PLUGIN_ROOT}/references/stage-log.md";
  for (const path of ["commands/cycle.md", "playbooks/scoping-the-request.md", "playbooks/planning-waves.md"])
    assert.equal(read(path).split(cite).length - 1, 1, `${path} must read the owner exactly once`);
  assert.ok(read("references/README.md").includes("`stage-log.md`"), "the references index lacks stage-log.md");
});
