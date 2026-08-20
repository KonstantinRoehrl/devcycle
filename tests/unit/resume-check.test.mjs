import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeRepo } from "./helpers.mjs";

const SCRIPT = join(process.cwd(), "scripts/resume-check.mjs");
const run = (statePath) => spawnSync("node", [SCRIPT, "--state", statePath], { encoding: "utf8" });

function makeState(dir, lines) {
  const p = join(dir, "state.md");
  writeFileSync(p, "# devcycle state\n" + lines.join("\n") + "\n", "utf8");
  return p;
}

test("passes when stage is valid and every named artifact exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "spec.md"), "x");
  const state = makeState(dir, [
    "- stage: planning",
    `- root: ${dir}`,
    "- spec: docs/spec.md",
    "- plan: <tbd>",
    "- checklist: none",
  ]);
  const r = run(state);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  rmSync(dir, { recursive: true, force: true });
});

test("fails when a named artifact path is missing on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  const state = makeState(dir, [
    "- stage: execution",
    `- root: ${dir}`,
    "- spec: docs/gone.md",
    "- plan: docs/also-gone.md",
    "- checklist: none",
  ]);
  const r = run(state);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /docs\/gone\.md/);
  rmSync(dir, { recursive: true, force: true });
});

test("accepts every stage in commands/cycle.md's enum (binds to the single source of truth)", () => {
  // resume-check derives its valid-stage set from cycle.md rather than keeping a hardcoded
  // copy. This locks that binding: paired with the "invalid stage enum value" test below
  // (which proves the set is genuinely loaded and non-empty), it fails the day resume-check's
  // accepted set drifts from cycle.md's declared enum.
  const enumMatch = readFileSync(join(process.cwd(), "commands/cycle.md"), "utf8").match(/stage:\s*<([a-z|-]+)>/);
  assert.ok(enumMatch, "commands/cycle.md must declare the stage enum");
  const stages = enumMatch[1].split("|");
  assert.ok(stages.length >= 10, `expected the full stage enum, got ${stages.length}`);
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  try {
    for (const stage of stages) {
      const state = makeState(dir, [
        `- stage: ${stage}`,
        `- root: ${dir}`,
        "- spec: none",
        "- plan: none",
        "- checklist: none",
      ]);
      const r = run(state);
      assert.equal(r.status, 0, `stage "${stage}" (from cycle.md) rejected: ${r.stderr}${r.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails on an invalid stage enum value", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  const state = makeState(dir, [
    "- stage: bogus",
    `- root: ${dir}`,
    "- spec: none",
    "- plan: none",
    "- checklist: none",
  ]);
  const r = run(state);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /stage/i);
  rmSync(dir, { recursive: true, force: true });
});

// --- C2: the ownership check (references/resume.md:41-47) ---

test("a state file whose root: names another checkout exits non-zero naming both paths", () => {
  const repo = makeRepo();
  const foreign = mkdtempSync(join(tmpdir(), "resume-check-foreign-"));
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: planning",
          `- root: ${foreign}`,
          "- request: build the thing",
          "- spec: none",
          "- plan: none",
          "- checklist: none",
        ].join("\n") +
        "\n",
      "utf8"
    );
    const r = run(state);
    assert.notEqual(r.status, 0);
    const out = r.stdout + r.stderr;
    assert.ok(out.includes(realpathSync(foreign)), `recorded root missing from:\n${out}`);
    assert.ok(out.includes(realpathSync(repo)), `actual root missing from:\n${out}`);
    assert.match(out, /build the thing/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("a matching root: passes, even when it is written in unresolved symlink form", () => {
  const repo = makeRepo(); // mkdtemp path: /var/... on macOS, whose realpath is /private/var/...
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        ["- stage: planning", `- root: ${repo}`, "- spec: none", "- plan: none", "- checklist: none"].join("\n") +
        "\n",
      "utf8"
    );
    const r = run(state);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the ownership check reports nothing else — a foreign root short-circuits artifact checks", () => {
  const repo = makeRepo();
  const foreign = mkdtempSync(join(tmpdir(), "resume-check-foreign-"));
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: planning",
          `- root: ${foreign}`,
          "- request: build the thing",
          "- spec: docs/definitely-gone.md",
          "- plan: none",
          "- checklist: none",
        ].join("\n") +
        "\n",
      "utf8"
    );
    const out = run(state).stdout + run(state).stderr;
    assert.ok(!out.includes("definitely-gone.md"), `artifact verdicts leaked through:\n${out}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("a state file in a non-git directory skips the ownership check rather than failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-check-"));
  try {
    const state = makeState(dir, [
      "- stage: planning",
      "- root: /somewhere/else/entirely",
      "- spec: none",
      "- plan: none",
      "- checklist: none",
    ]);
    const r = run(state);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a state file with no root: line is not treated as foreign", () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" + ["- stage: planning", "- spec: none", "- plan: none", "- checklist: none"].join("\n") + "\n",
      "utf8"
    );
    const r = run(state);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--state with no value is a usage error", () => {
  const r = spawnSync("node", [SCRIPT, "--state"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /usage/i);
});

test("an unrecognised flag is an error, not a silent fallback to the default state file", () => {
  const r = spawnSync("node", [SCRIPT, "--stat", "somewhere.md"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resume-check: unrecognised flag --stat/);
});
