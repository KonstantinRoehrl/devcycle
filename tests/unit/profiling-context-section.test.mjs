import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const playbook = readFileSync(join(process.cwd(), "playbooks/profiling-sessions.md"), "utf8");
const items = playbook.split(/\n(?=\d+\. |#{2,3} )/);
const step = (n) => items.find((p) => p.startsWith(`${n}. `)) ?? "";

test("step 2 appends write-issue's context section, then screens the whole draft", () => {
  const s = step(2);
  assert.ok(s.includes("${CLAUDE_PLUGIN_ROOT}/playbooks/writing-issues.md` § The context section"), "step 2 reads no context section");
  assert.match(s, /## Agent context/);
  assert.ok(s.indexOf("writing-issues.md") < s.indexOf('redaction-check.mjs" --file <draft>'), "the screen must run after the section is appended");
  assert.match(s, /--repo <repo> --source-repo <this checkout's root>/);
  assert.match(s, /is not shown at all/);
});

test("only the script's block is never hand-composed", () => {
  assert.match(step(1), /its block is never hand-composed/);
  assert.doesNotMatch(step(1), /from the script, never hand-composed/);
});

test("the comment and the filed body are the script's body, then the appended section", () => {
  assert.match(step(3), /the script's body, then the appended section/);
  assert.match(step(7), /The title still comes only from the script/);
  assert.match(step(7), /the script's body, then the appended section/);
  assert.doesNotMatch(step(7), /exactly as `--issue-body` printed them/);
});

test("the section adds no gate phrase before the Drafted: marker", () => {
  const marker = playbook.indexOf("Drafted: [culprit:");
  assert.ok(playbook.indexOf("first gate") > marker && playbook.indexOf("second gate") > marker);
});
