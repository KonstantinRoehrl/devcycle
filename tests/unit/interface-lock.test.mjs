import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { extractLock, renderLock, parseLock, mergeLock, checkLock } from "../../scripts/interface-lock.mjs";
import { codeSpans } from "../../scripts/cross-task-check.mjs";

const SCRIPT = new URL("../../scripts/interface-lock.mjs", import.meta.url).pathname;
const block = (n, { consumes = [], produces = [] } = {}) => [
  `### Task ${n}: T${n}`, "", "**Interfaces:**",
  ...consumes.map(([from, text]) => `- Consumes (Task ${from}): ${text}`),
  ...produces.map((text) => `- Produces: ${text}`),
  "", "**Dependencies:** none", "",
].join("\n");
const blocks = (...specs) => specs.map(([num, opts]) => ({ num, text: block(num, opts) }));
const ONE = { produces: ["`planStrategy(cut) -> {strategy}`", "`LIMIT = 3`"] };
const LOCK = renderLock([{ num: 1, round: 1, produces: ONE.produces }]);

test("codeSpans returns each backticked span of a line", () => {
  assert.deepEqual(codeSpans("uses `a(b)` and `c`"), ["a(b)", "c"]);
});

test("extractLock takes the Produces items of the named tasks in task order", () => {
  const b = blocks([2, { produces: ["`g(x)` returns y"] }], [1, { produces: ["`f(a, b)`", "`K = 3`"] }]);
  assert.deepEqual(extractLock(b, 1), [
    { num: 1, round: 1, produces: ["`f(a, b)`", "`K = 3`"] },
    { num: 2, round: 1, produces: ["`g(x)` returns y"] },
  ]);
  assert.deepEqual(extractLock(b, 2, [2]), [{ num: 2, round: 2, produces: ["`g(x)` returns y"] }]);
});

test("a lock renders to markdown and parses back unchanged", () => {
  const entries = [{ num: 1, round: 1, produces: ["`f(a, b)`", "`K = 3`"] }, { num: 4, round: 2, produces: [] }];
  const text = renderLock(entries);
  assert.match(text, /^# Interface lock\n\n## Task 1 \(round 1\)\n- `f\(a, b\)`\n- `K = 3`\n\n## Task 4 \(round 2\)\n\(no Produces\)\n$/);
  assert.deepEqual(parseLock(text), entries);
});

test("mergeLock adds a round, accepts an identical re-lock and refuses a changed Produces without relock", () => {
  const r1 = [{ num: 1, round: 1, produces: ["`f(a)`"] }];
  assert.deepEqual(mergeLock(r1, [{ num: 2, round: 2, produces: ["`g()`"] }]).entries.map((e) => e.num), [1, 2]);
  assert.deepEqual(mergeLock(r1, [{ num: 1, round: 2, produces: ["`f(a)`"] }]).entries, r1);
  const changed = [{ num: 1, round: 2, produces: ["`f(a, b)`"] }];
  assert.deepEqual(mergeLock(r1, changed).errors, ["Task 1 is locked (round 1) with different Produces; pass --relock once the coordinator accepts the change"]);
  assert.deepEqual(mergeLock(r1, changed, { relock: true }).entries, changed);
});

test("checkLock passes a consumer that reproduces a locked signature verbatim", () => {
  const b = blocks([1, ONE], [2, { consumes: [[1, "calls `planStrategy(cut) -> {strategy}`"]] }]);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: b }), { findings: [] });
});

test("checkLock flags a consumed signature the lock does not carry verbatim", () => {
  const b = blocks([1, ONE], [2, { consumes: [[1, "calls `planStrategy(cut, knob) -> {strategy}`"]] }]);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: b }).findings, [
    "Task 2: consumes `planStrategy(cut, knob) -> {strategy}` from Task 1, which the interface lock's Task 1 entry does not carry verbatim",
  ]);
});

test("checkLock flags a consumed span that is only part of a locked signature", () => {
  const b = blocks([1, ONE], [2, { consumes: [[1, "calls `planStrategy(cut)`"]] }]);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: b }).findings, [
    "Task 2: consumes `planStrategy(cut)` from Task 1, which the interface lock's Task 1 entry does not carry verbatim",
  ]);
});

test("checkLock matches a consumed span to a locked span with whitespace collapsed, or to a whole Produces item", () => {
  const lockText = renderLock([{ num: 1, round: 1, produces: ["`planStrategy(cut) -> {strategy}`", "`LIMIT  =  3`", "the limit is three"] }]);
  const b = blocks([1, { produces: ["`planStrategy(cut) -> {strategy}`", "`LIMIT  =  3`", "the limit is three"] }],
    [2, { consumes: [[1, "calls `planStrategy(cut)   ->\t{strategy}`, reads ` LIMIT = 3 ` and `the limit is three`"]] }]);
  assert.deepEqual(checkLock({ lockText, blocks: b }), { findings: [] });
  const part = blocks([1, { produces: ["`planStrategy(cut) -> {strategy}`", "`LIMIT  =  3`", "the limit is three"] }],
    [2, { consumes: [[1, "reads `the limit`"]] }]);
  assert.equal(checkLock({ lockText, blocks: part }).findings.length, 1);
});

test("checkLock scoped to some tasks checks only their consumers, against every locked producer", () => {
  const b = blocks([1, ONE], [2, { consumes: [[1, "calls `planStrategy(cut) -> {strategy}`"]] }], [3, { consumes: [[1, "calls `planStrategy`"]] }]);
  assert.equal(checkLock({ lockText: LOCK, blocks: b }).findings.length, 1);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: b, tasks: [2] }), { findings: [] });
  const drifted = [...blocks([1, { produces: ["`LIMIT = 3`"] }]), ...b.slice(1)];
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: drifted, tasks: [2] }).findings, [
    "Task 1: Produces differ from the interface lock (round 1); a drafter that must change a pinned interface returns an interface-delta, and the coordinator relocks",
  ]);
});

test("checkLock flags a locked task whose Produces drifted, or whose file is gone", () => {
  const drifted = blocks([1, { produces: ["`planStrategy(cut, knob) -> {strategy}`", "`LIMIT = 3`"] }]);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: drifted }).findings, [
    "Task 1: Produces differ from the interface lock (round 1); a drafter that must change a pinned interface returns an interface-delta, and the coordinator relocks",
  ]);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: [] }).findings, ["Task 1: is locked but has no task file"]);
});

test("checkLock leaves a consumer of an unlocked producer to the plan gate", () => {
  const b = blocks([1, ONE], [2, { consumes: [[3, "calls `h()`"]] }]);
  assert.deepEqual(checkLock({ lockText: LOCK, blocks: b }), { findings: [] });
});

test("the CLI locks each round's drafts, checks them, and relocks only on request", () => {
  const dir = makeTempDir("interface-lock-");
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  writeInto(dir, "tasks/task-1.md", block(1, { produces: ["`f(a)`"] }));
  let r = run("write", dir, "--round", "1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /locked Task 1 \(round 1\)/);
  writeInto(dir, "tasks/task-2.md", block(2, { consumes: [[1, "calls `f(a)`"]], produces: ["`g()`"] }));
  r = run("write", dir, "--round", "2");
  assert.match(r.stdout, /locked Task 2 \(round 2\)/);
  assert.match(readFileSync(join(dir, "interfaces.lock.md"), "utf8"), /## Task 1 \(round 1\)\n- `f\(a\)`\n\n## Task 2 \(round 2\)\n- `g\(\)`\n/);
  assert.equal(run("check", dir).status, 0);
  assert.equal(run("write", dir, "--round", "3").status, 1, "nothing is left to lock");
  assert.match(run("write", dir, "--round", "3").stderr, /no unlocked task files/);

  writeInto(dir, "tasks/task-1.md", block(1, { produces: ["`f(a, b)`"] }));
  r = run("check", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Task 1: Produces differ from the interface lock \(round 1\)/);
  r = run("write", dir, "--round", "3", "--tasks", "1");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Task 1 is locked \(round 1\) with different Produces/);
  r = run("write", dir, "--round", "3", "--tasks", "1", "--relock");
  assert.equal(r.status, 0, r.stderr);
  r = run("check", dir);
  assert.equal(r.status, 1, "the relock surfaces the consumer that still names the old signature");
  assert.match(r.stderr, /Task 2: consumes `f\(a\)` from Task 1/);
  writeInto(dir, "tasks/task-2.md", block(2, { consumes: [[1, "calls `f(a, b)`"]], produces: ["`g()`"] }));
  assert.equal(run("check", dir).status, 0);
});

test("check --tasks limits the consumers checked, so an unlocked sibling's draft does not fail a drafter's self-check", () => {
  const dir = makeTempDir("interface-lock-scoped-");
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  writeInto(dir, "tasks/task-1.md", block(1, { produces: ["`f(a) -> b`"] }));
  assert.equal(run("write", dir, "--round", "1").status, 0);
  writeInto(dir, "tasks/task-2.md", block(2, { consumes: [[1, "calls `f(a) -> b`"]] }));
  writeInto(dir, "tasks/task-3.md", block(3, { consumes: [[1, "calls `f(a)`"]] }));
  let r = run("check", dir);
  assert.equal(r.status, 1, "the weaker pin in Task 3 fails an unscoped check");
  assert.match(r.stderr, /^interface-lock: Task 3: consumes `f\(a\)` from Task 1, which the interface lock's Task 1 entry does not carry verbatim$/m);
  r = run("check", dir, "--tasks", "2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^interface-lock: 1 locked task\(s\) match their task files$/m);
  assert.equal(run("check", dir, "--tasks", "2,3").status, 1);
  writeInto(dir, "tasks/task-1.md", block(1, { produces: ["`f(a, b) -> b`"] }));
  r = run("check", dir, "--tasks", "2");
  assert.equal(r.status, 1, "a scoped check still reads the producers from the lock");
  assert.match(r.stderr, /^interface-lock: Task 1: Produces differ from the interface lock \(round 1\)/m);
  assert.doesNotMatch(r.stderr, /Task 3:/);
});

test("the CLI refuses a bad round, a flag on check, an unknown task and a missing lock", () => {
  const dir = makeTempDir("interface-lock-guards-");
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
  writeInto(dir, "tasks/task-1.md", block(1, { produces: ["`f(a)`"] }));
  for (const round of [[], ["--round", "0"], ["--round", "x"], ["--round", "1.5"]]) {
    const r = run("write", dir, ...round);
    assert.equal(r.status, 2, `write ${round.join(" ")} is a usage error`);
    assert.match(r.stderr, /^interface-lock: --round takes a positive integer$/m);
  }
  let r = run("check", dir, "--relock");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^interface-lock: check takes only --tasks$/m);
  for (const tasks of ["x", "0", "1,,2", "1.5"]) {
    r = run("check", dir, "--tasks", tasks);
    assert.equal(r.status, 2, `check --tasks ${tasks} is a usage error`);
    assert.match(r.stderr, /^interface-lock: --tasks takes task numbers like 1,2$/m);
  }
  r = run("check", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`^interface-lock: no interfaces\\.lock\\.md in ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  r = run("write", dir, "--round", "1", "--tasks", "9");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^interface-lock: Task 9 has no task file$/m);
  assert.equal(run("write", dir, "--round", "1").status, 0);
  r = run("check", dir, "--tasks", "9");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^interface-lock: Task 9 has no task file$/m);
});
