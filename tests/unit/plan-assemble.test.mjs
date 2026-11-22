import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { assemblePlan, batchEdges, edgeBatches, sha256Hex } from "../../scripts/plan-assemble.mjs";
import { readStage } from "../../scripts/stage-log.mjs";

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

test("edgeBatches reads a work directory's task files into the batches edges --batch prints", () => {
  const dir = workDir();
  for (const [n, deps] of [[3, "Task 1 (x)"], [4, "Tasks 2+3 committed"]]) writeInto(dir, `tasks/task-${n}.md`, t(n, deps));
  const edge = (producer, consumer) => ({ producer, consumer });
  assert.deepEqual(edgeBatches(dir, 3), [
    { edges: [edge(1, 2), edge(1, 3), edge(2, 4)], tasks: [1, 2, 3, 4] },
    { edges: [edge(3, 4)], tasks: [3, 4] },
  ]);
  assert.equal(edgeBatches(dir, 8).length, 1);
});

test("sha256Hex is the hex SHA-256 of the text", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

const RUN = "00000000000000a5";
// A checkout whose state file names RUN, its work directory and a nested plan directory.
function stateRoot(stateText = `# devcycle state\n- stage: planning\n- run: ${RUN}\n- plan: none\n- spec: s.md\n`) {
  const root = realpathSync(makeTempDir("plan-assemble-state-"));
  const work = join(root, `.devcycle/plan-work/${RUN}`);
  writeInto(work, "plan-header.md", HEADER);
  writeInto(work, "dispatch-map.md", MAP);
  writeInto(work, "tasks/task-1.md", t(1));
  writeInto(work, "tasks/task-2.md", t(2, "Task 1 (consumes x)"));
  writeInto(root, ".devcycle/state.md", stateText);
  mkdirSync(join(root, "docs/plans"), { recursive: true });
  return { root, work, state: join(root, ".devcycle/state.md"), out: join(root, "docs/plans/p.md") };
}

test("--state logs plan-assembled with the plan's repo-relative path and hash, and writes the state's plan: row", () => {
  const { root, work, state, out } = stateRoot();
  const r = cli(work, "--out", out, "--state", state);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `plan-assemble: wrote ${out} — 2 task(s), 2 wave(s)`);
  const plan = readFileSync(out, "utf8");
  const rows = readStage(join(root, ".devcycle"), { run: RUN, stage: "planning" });
  assert.deepEqual(rows.map(({ key, ref, data }) => ({ key, ref, data })), [{ key: "plan-assembled", ref: "docs/plans/p.md", data: { sha256: sha256Hex(plan) } }]);
  assert.match(rows[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(readFileSync(state, "utf8"), `# devcycle state\n- stage: planning\n- run: ${RUN}\n- plan: docs/plans/p.md\n- spec: s.md\n`);
});

test("without --state nothing is logged and the state file is untouched", () => {
  const { root, work, state, out } = stateRoot();
  const before = readFileSync(state, "utf8");
  assert.equal(cli(work, "--out", out).status, 0);
  assert.equal(existsSync(join(root, ".devcycle/stage-log")), false, "no stage log is written");
  assert.equal(readFileSync(state, "utf8"), before);
});

test("--state refuses a missing state file or one naming no run, before writing the plan", () => {
  const missing = stateRoot();
  let r = cli(missing.work, "--out", missing.out, "--state", join(missing.root, ".devcycle/gone.md"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-assemble: no state file at .*gone\.md$/m);
  assert.equal(existsSync(missing.out), false, "no plan is written");
  const runless = stateRoot("# devcycle state\n- stage: planning\n");
  r = cli(runless.work, "--out", runless.out, "--state", runless.state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^plan-assemble: .*state\.md names no run, so the assembly cannot be logged$/m);
  assert.equal(existsSync(runless.out), false, "no plan is written");
  assert.equal(cli("edges", runless.work, "--state", runless.state).status, 2, "edges logs nothing");
});
