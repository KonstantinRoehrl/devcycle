import { test } from "node:test";
import assert from "node:assert/strict";
import { crossTaskLeg } from "../../scripts/cross-task-check.mjs";

const task = (n, { consumes = [], produces = [], body = "- [ ] step" } = {}) => [
  `### Task ${n}: T${n}`, "",
  "**Files:**", `- Modify: src/t${n}.mjs`, "",
  "**Interfaces:**", ...consumes.map((c) => `- Consumes${c}`), ...produces.map((p) => `- Produces: ${p}`), "",
  "**Dependencies:** none (completely independent)", "**Evidence:** red-green", "", body, "",
].join("\n");
const plan = (...tasks) => `# P\n\n${tasks.join("\n")}\n## Dispatch Map\n\n- Wave 1: Task 1\n`;
const clean = { findings: [], notes: [] };

test("a consumed span the producer's Produces carries passes", () => {
  const p = plan(task(1, { produces: ["`export function f(a)` → `number`"] }), task(2, { consumes: [" (Task 1): `export function f(a)`"] }));
  assert.deepEqual(crossTaskLeg(p), clean);
});

test("a consumed span no Produces line carries fails, naming both tasks", () => {
  const p = plan(task(1, { produces: ["`export function f(a)`"] }), task(2, { consumes: [" (Task 1): `export function f(a, b)`"] }));
  assert.deepEqual(crossTaskLeg(p).findings, ["Task 2: consumes `export function f(a, b)` from Task 1, which no Produces line of Task 1 carries"]);
});

test("a consumer naming a task the plan lacks fails; an unlabelled Consumes is not checked", () => {
  const p = plan(task(1, { consumes: [": `now()` from `scripts/stamp.mjs`", " (Task 7): `x()`"] }));
  assert.deepEqual(crossTaskLeg(p).findings, ["Task 1: consumes from Task 7, which the plan does not define"]);
});

test("a Consumes (Task N) line with no code span is a note", () => {
  const p = plan(task(1, { produces: ["`f()`"] }), task(2, { consumes: [" (Task 1): the whole module"] }));
  assert.deepEqual(crossTaskLeg(p), { findings: [], notes: ["Task 2: a Consumes (Task 1) line pins no code span, so it cannot be checked"] });
});

test("placeholders and back-references in prose fail with their plan line; quoted or fenced ones do not", () => {
  const body = [
    "- [ ] Add validation here.",
    "- [ ] Do it similar to Task 2.",
    "- [ ] Never write `TBD` or `similar to Task 2`.",
    "```js",
    "// TODO later",
    "```",
  ].join("\n");
  // Plan lines 1–2 are "# P" and "", lines 3–12 are task()'s heading and fields, so the body starts at line 13.
  assert.deepEqual(crossTaskLeg(plan(task(1, { body }), task(2))).findings, [
    'Task 1: placeholder "Add validation" at plan line 13 — write the content, or quote the phrase in a code span',
    'Task 1: back-reference "similar to Task 2" at plan line 14 — repeat what it refers to; tasks are read alone',
  ]);
});

test("a definition two tasks pin with differing text is a note; identical text is silent", () => {
  const block = (code) => `\`\`\`js\n${code}\n\`\`\``;
  const same = plan(task(1, { body: block("export function k(a) {\n  return a;\n}") }), task(2, { body: block("export function k(a) {\n  return a;\n}") }));
  assert.deepEqual(crossTaskLeg(same), clean);
  const differs = plan(task(1, { body: block("const LIMIT = 5;") }), task(2, { body: block("const LIMIT = 6;") }), task(3, { body: "```text\nconst LIMIT = 7;\n```" }));
  assert.deepEqual(crossTaskLeg(differs), { findings: [], notes: ["mirrored definition `LIMIT` differs between Task 1 and Task 2"] });
});
