import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { assemblePlan, batchEdges } from "../../scripts/plan-assemble.mjs";

const SCRIPT = new URL("../../scripts/plan-assemble.mjs", import.meta.url).pathname;
const HEADER = "# P Implementation Plan\n\n**Verification gate:** `npm test`\n";
const MAP = "## Dispatch Map\n\n- Wave 1: Task 1\n- Wave 2: Task 2 (needs Task 1 committed)\n";
const t = (n, deps = "none (completely independent)") => `### Task ${n}: T${n}\n\n**Dependencies:** ${deps}\n\n- [ ] step\n\n\n`;

test("assemblePlan writes the header, the tasks in task order and the map, one blank line apart", () => {
  const r = assemblePlan({ header: HEADER, tasks: [{ name: "task-2.md", text: t(2, "Task 1 (x)") }, { name: "task-1.md", text: t(1) }], dispatchMap: MAP });
  assert.deepEqual(r.errors, []);
  assert.equal(r.plan, `${HEADER.trimEnd()}\n\n${t(1).trimEnd()}\n\n${t(2, "Task 1 (x)").trimEnd()}\n\n${MAP.trimEnd()}\n`);
});

test("assemblePlan names every id defect and returns no plan", () => {
  const r = assemblePlan({
    header: HEADER,
    tasks: [
      { name: "task-1.md", text: t(1) },
      { name: "task-3.md", text: t(4) },
      { name: "task-5.md", text: "no heading\n" },
      { name: "task-6.md", text: t(6) + t(7) },
      { name: "task-8.md", text: t(1) },
    ],
    dispatchMap: "## Dispatch Map\n\n- Wave 1: Task 1, Task 2\n",
  });
  assert.equal(r.plan, null);
  assert.deepEqual(r.errors, [
    "task-3.md holds Task 4, expected Task 3",
    "task-5.md holds no \"### Task N:\" heading",
    "task-6.md holds 2 task headings, expected one",
    "task-8.md holds Task 1, expected Task 8",
    "Task 1 is in both task-1.md and task-8.md",
    "Task 2 is in the Dispatch Map but has no task file",
    "Task 4 has a task file but no Dispatch Map wave",
  ]);
  assert.deepEqual(assemblePlan({ header: HEADER, tasks: [{ name: "task-1.md", text: t(1) }], dispatchMap: "- Wave 1: Task 1\n" }).errors,
    ["dispatch-map.md has no \"## Dispatch Map\" heading"]);
});

function workDir() {
  const dir = realpathSync(makeTempDir("plan-assemble-"));
  writeInto(dir, "plan-header.md", HEADER);
  writeInto(dir, "dispatch-map.md", MAP);
  writeInto(dir, "tasks/task-1.md", t(1));
  writeInto(dir, "tasks/task-2.md", t(2, "Task 1 (consumes x)"));
  writeInto(dir, "tasks/notes.txt", "ignored");
  return dir;
}
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("the CLI writes the assembled plan and reports its counts", () => {
  const dir = workDir();
  const out = join(dir, "plan.md");
  const r = cli(dir, "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `plan-assemble: wrote ${out} — 2 task(s), 2 wave(s)`);
  assert.equal(readFileSync(out, "utf8"), assemblePlan({ header: HEADER, tasks: [{ name: "task-1.md", text: t(1) }, { name: "task-2.md", text: t(2, "Task 1 (consumes x)") }], dispatchMap: MAP }).plan);
});

test("the CLI fails on a defect or a missing work file and writes nothing", () => {
  const dir = workDir();
  writeInto(dir, "tasks/task-3.md", t(3));
  const r = cli(dir, "--out", join(dir, "plan.md"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan-assemble: Task 3 has a task file but no Dispatch Map wave/);
  assert.equal(existsSync(join(dir, "plan.md")), false, "no plan is written");
  const bare = realpathSync(makeTempDir("plan-assemble-bare"));
  const missing = cli(bare, "--out", join(bare, "plan.md"));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /plan-assemble: missing .*plan-header\.md/);
  assert.equal(cli().status, 2);
});

test("edges lists each producer→consumer pair with both task files", () => {
  const r = cli("edges", workDir());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "Task 1 → Task 2 · tasks/task-1.md · tasks/task-2.md");
  const lone = workDir();
  writeInto(lone, "tasks/task-2.md", t(2));
  assert.equal(cli("edges", lone).stdout.trim(), "plan-assemble: no edges");
});

test("the CLI refuses a usage it does not define with exit 2", () => {
  const dir = workDir();
  assert.equal(cli(dir).status, 2, "--out is required to assemble");
  assert.equal(cli("edges").status, 2, "edges needs a work directory");
  assert.equal(cli("edges", dir, "--out", join(dir, "plan.md")).status, 2, "edges writes nothing");
  assert.equal(cli(dir, "--bogus", "x").status, 2, "an unknown flag is a usage error");
});

test("batchEdges splits the edges into batches of at most N and names each batch's tasks", () => {
  const edges = [[1, 2], [1, 3], [2, 4], [3, 4], [4, 5]].map(([producer, consumer]) => ({ producer, consumer }));
  assert.deepEqual(batchEdges(edges, 2), [
    { edges: edges.slice(0, 2), tasks: [1, 2, 3] },
    { edges: edges.slice(2, 4), tasks: [2, 3, 4] },
    { edges: edges.slice(4), tasks: [4, 5] },
  ]);
  assert.deepEqual(batchEdges([], 2), []);
  assert.throws(() => batchEdges(edges, 0), /positive integer/);
});

test("edges --batch groups the pairs, each batch naming the task files it reads", () => {
  const dir = workDir();
  for (const [n, deps] of [[1, "none (completely independent)"], [2, "Task 1 (x)"], [3, "Task 1 (x)"], [4, "Tasks 2+3 committed"]])
    writeInto(dir, `tasks/task-${n}.md`, t(n, deps));
  const r = cli("edges", dir, "--batch", "3");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), [
    "batch 1 · 3 edges · tasks/task-1.md tasks/task-2.md tasks/task-3.md tasks/task-4.md",
    "Task 1 → Task 2", "Task 1 → Task 3", "Task 2 → Task 4",
    "batch 2 · 1 edge · tasks/task-3.md tasks/task-4.md",
    "Task 3 → Task 4",
  ].join("\n"));
  assert.equal(cli("edges", dir, "--batch", "0").status, 2, "a batch size is a positive integer");
  assert.equal(cli(dir, "--out", join(dir, "plan.md"), "--batch", "3").status, 2, "--batch belongs to edges");
});

test("edges --batch takes only a digits-only positive integer", () => {
  const dir = workDir();
  for (const value of ["0x10", "1e1"]) {
    const r = cli("edges", dir, "--batch", value);
    assert.equal(r.status, 2, `--batch ${value} is a usage error`);
    assert.match(r.stderr, /^plan-assemble: --batch takes a positive integer$/m);
  }
});
