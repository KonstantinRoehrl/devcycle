import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, writeFileSync, mkdirSync, rmSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitToplevel, hashSession, repoSlug } from "../../scripts/run-record.mjs";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { checkState, ownershipOf } from "../../scripts/resume-check.mjs";
import { makeRepo, sh, writeInto } from "./helpers.mjs";

const SCRIPT = join(process.cwd(), "scripts/resume-check.mjs");
const run = (statePath) => spawnSync("node", [SCRIPT, "--state", statePath], { encoding: "utf8" });

function makeState(dir, lines) {
  const p = join(dir, "state.md");
  writeFileSync(p, "# devcycle state\n" + lines.join("\n") + "\n", "utf8");
  return p;
}

test("passes when stage is valid and every named artifact exists", () => {
  const dir = makeTempDir("resume-check-");
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
  const dir = makeTempDir("resume-check-");
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
  const dir = makeTempDir("resume-check-");
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
  const dir = makeTempDir("resume-check-");
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
  const foreign = makeTempDir("resume-check-foreign-");
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
    assert.ok(out.includes(realpathSync.native(foreign)), `recorded root missing from:\n${out}`);
    assert.ok(out.includes(realpathSync.native(repo)), `actual root missing from:\n${out}`);
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

// The 8.3 short spelling of a directory (RUNNER~1 for runneradmin), or null where the volume has none.
function windowsShortPath(dir) {
  const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SHORTEN_DIR).ShortPath`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, SHORTEN_DIR: dir } });
  const short = r.status === 0 ? r.stdout.trim() : "";
  return short && short.toLowerCase() !== dir.toLowerCase() ? short : null;
}

test("a matching root: passes when it is written in Windows 8.3 short form, which git prints in full", (t) => {
  if (process.platform !== "win32") return t.skip("Windows only: 8.3 short names exist nowhere else");
  const repo = makeRepo();
  try {
    const long = join(realpathSync.native(repo), "a-directory-name-longer-than-eight-characters");
    mkdirSync(join(long, ".devcycle"), { recursive: true });
    sh("git", ["init", "-q"], { cwd: long });
    const short = windowsShortPath(long);
    if (short === null) return t.skip("this volume has 8.3 short names disabled");
    const state = join(long, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        ["- stage: planning", `- root: ${short}`, "- spec: none", "- plan: none", "- checklist: none"].join("\n") +
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
  const foreign = makeTempDir("resume-check-foreign-");
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

test("a foreign-root state file with a blank request prints empty, not '(none recorded)'", () => {
  // Component-2 delta (design doc migration table): resume-check now reads `- request:` through
  // the shared parser's `field`, which returns "" (not null) for a present-but-blank field. So the
  // `?? "(none recorded)"` fallback on the ownership-mismatch print line no longer fires for a
  // blank request — it prints empty. This locks the delta at the resume-check level; the parser
  // level is covered in md-field.test.mjs.
  const repo = makeRepo();
  const foreign = makeTempDir("resume-check-foreign-");
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: planning",
          `- root: ${foreign}`, // foreign → reaches the ownership-mismatch print path
          "- request:", // present but blank → must print "" not "(none recorded)"
          "- spec: none",
          "- plan: none",
          "- checklist: none",
        ].join("\n") +
        "\n",
      "utf8"
    );
    const r = run(state);
    assert.notEqual(r.status, 0); // foreign root still stops the resume
    assert.match(r.stderr, /its request:/); // the print path was reached
    assert.doesNotMatch(r.stderr, /\(none recorded\)/); // blank read as "" → fallback did not fire
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("a state file in a non-git directory skips the ownership check rather than failing", () => {
  const dir = makeTempDir("resume-check-");
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

test("a blank field on its own line does not swallow the next field", () => {
  // Drift regression: the old local `field` used `\s*`, so a blank `- root:` on its own line
  // read the following `- request:` line back as its value — making resume-check reject an
  // ownerless state file as belonging to a foreign checkout. The shared md-field parser's
  // `[ \t]*` stops at the newline, so a blank root reads "" and the ownership check is skipped.
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: planning",
          "- root:", // blank on its own line
          "- request: build the thing", // must NOT be read back as root:'s value
          "- spec: none",
          "- plan: none",
          "- checklist: none",
        ].join("\n") +
        "\n",
      "utf8"
    );
    const r = run(state);
    assert.equal(r.status, 0, `blank root: was misparsed as foreign:\n${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /another checkout|its root:/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
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

// Dropping the flag name leaves a bare token with nothing misspelled to notice: it used to be
// discarded, so the run validated `.devcycle/state.md` while the caller had named a different
// state file, and /devcycle:continue trusted the answer.
test("a bare path is an error, not a silent fallback to the default state file", () => {
  const r = spawnSync("node", [SCRIPT, "somewhere.md"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /resume-check: unexpected argument "somewhere\.md"/);
});

// --- #138: the branch-existence check ---

test("fails when the recorded branch no longer exists (leftover from a different cycle)", () => {
  const repo = makeRepo(); // on main
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: execution",
          `- root: ${repo}`,
          "- branch: feat/long-gone (cut from main at abc1234)",
          "- spec: none",
          "- plan: none",
          "- checklist: none",
        ].join("\n") + "\n",
      "utf8"
    );
    const r = run(state);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /feat\/long-gone/);
    assert.match(r.stdout + r.stderr, /no longer exists|leftover/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("passes when the recorded branch still exists, even with HEAD on another branch", () => {
  const repo = makeRepo(); // on main
  try {
    sh("git", ["branch", "feat/topic"], { cwd: repo }); // exists; HEAD stays on main
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: execution",
          `- root: ${repo}`,
          "- branch: feat/topic (cut from main at abc1234)",
          "- spec: none",
          "- plan: none",
          "- checklist: none",
        ].join("\n") + "\n",
      "utf8"
    );
    const r = run(state);
    assert.equal(r.status, 0, r.stdout + r.stderr); // silent on the resume-drift case
    assert.doesNotMatch(r.stdout + r.stderr, /branch/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch: none skips the branch-existence check", () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        ["- stage: planning", `- root: ${repo}`, "- branch: none", "- spec: none", "- plan: none", "- checklist: none"].join("\n") +
        "\n",
      "utf8"
    );
    const r = run(state);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a recorded branch in a non-git directory skips the branch check rather than failing", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const state = makeState(dir, [
      "- stage: planning",
      "- branch: feat/whatever (cut from main at abc1234)",
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

test("a stale branch and a missing artifact are both reported in one exit-1 run", () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, ".devcycle"), { recursive: true });
    const state = join(repo, ".devcycle", "state.md");
    writeFileSync(
      state,
      "# devcycle state\n" +
        [
          "- stage: execution",
          `- root: ${repo}`,
          "- branch: feat/long-gone (cut from main at abc1234)",
          "- spec: docs/missing-spec.md",
          "- plan: none",
          "- checklist: none",
        ].join("\n") + "\n",
      "utf8"
    );
    const r = run(state);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /feat\/long-gone/);
    assert.match(r.stdout + r.stderr, /missing-spec\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const runWithEnv = (statePath, env) =>
  spawnSync("node", [SCRIPT, "--state", statePath], { encoding: "utf8", env: { ...process.env, ...env } });

test("on success it prints the stage's entry and note lines from references/stages.json", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const state = makeState(dir, ["- stage: planning", `- root: ${dir}`]);
    const r = run(state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^entry: .*playbooks\/planning-waves\.md$/m);
    assert.match(r.stdout, /^note: none$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken stages table prints no entry line, says why, and leaves the verdict at ok", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const state = makeState(dir, ["- stage: planning", `- root: ${dir}`]);
    const broken = join(dir, "stages.json");
    writeFileSync(broken, "{ nope");
    const r = runWithEnv(state, { DEVCYCLE_STAGES_PATH: broken });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /^entry:/m);
    const fallback = join(process.cwd(), "references", "resume.md");
    assert.ok(r.stdout.includes(`fall back to ${fallback} § Resuming at the recorded stage`), r.stdout);
    assert.match(r.stdout, /resume-check: no entry line — .*is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a done cycle is reported as closed, not as a missing entry", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const state = makeState(dir, ["- stage: done", `- root: ${dir}`]);
    const r = run(state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^closed: this cycle is done — nothing to resume/m);
    assert.doesNotMatch(r.stdout, /no entry line|fall back/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports the handoff row: pending and ready with their stamp, and no row as ready", () => {
  const dir = makeTempDir("resume-check-");
  const base = ["- stage: planning", `- root: ${dir}`, "- spec: none", "- plan: none", "- checklist: none"];
  const out = (lines) => {
    const r = run(makeState(dir, lines));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout.trim().split("\n").at(-1);
  };
  assert.equal(out([...base, "- handoff: pending 2026-10-16T10:00:00Z"]), "handoff: pending 2026-10-16T10:00:00Z");
  assert.equal(out([...base, "- handoff: ready 2026-10-16T11:00:00Z"]), "handoff: ready 2026-10-16T11:00:00Z");
  assert.equal(out(base), "handoff: ready (no row)");
  rmSync(dir, { recursive: true, force: true });
});

test("a stopped: row prints the stop record's stage, position, left and uncommitted lines before the handoff line", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const base = ["- stage: planning", `- root: ${dir}`, "- spec: none", "- plan: none", "- checklist: none", "- handoff: ready 2026-10-30T10:00:00Z"];
    const state = makeState(dir, [...base, "- stopped: 2026-10-30T10:00:00Z .devcycle/stop.json"]);
    writeFileSync(join(dir, "stop.json"), JSON.stringify({
      stage: "planning", position: { done: ["feasibility-verdict"] },
      left: [{ id: "b1", kind: "shell", reason: "owned by another session" }], uncommitted: ["docs/plan.md"],
    }));
    const r = run(state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const lines = r.stdout.trim().split("\n");
    assert.ok(lines.includes('stopped: 2026-10-30T10:00:00Z in planning: {"done":["feasibility-verdict"]} (.devcycle/stop.json)'), r.stdout);
    assert.ok(lines.includes("stopped-left: b1 (shell): owned by another session"), r.stdout);
    assert.ok(lines.includes("stopped-uncommitted: docs/plan.md"), r.stdout);
    assert.equal(lines.at(-1), "handoff: ready 2026-10-30T10:00:00Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stopped: row with its record gone still prints, naming the state file's stage", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const state = makeState(dir, ["- stage: planning", `- root: ${dir}`, "- stopped: 2026-10-30T10:00:00Z .devcycle/stop.json"]);
    const r = run(state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^stopped: 2026-10-30T10:00:00Z in planning: position not recorded \(\.devcycle\/stop\.json\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop record that belongs to another run is not announced", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const state = makeState(dir, [
      "- stage: planning", `- root: ${dir}`, "- run: 0123456789abcdef", "- stopped: 2026-10-30T10:00:00Z .devcycle/stop.json",
    ]);
    writeFileSync(join(dir, "stop.json"), JSON.stringify({ stage: "execution", run: "ffffffffffffffff", position: { summary: "old" }, left: [], uncommitted: [] }));
    const r = run(state);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /^stopped/m);

    writeFileSync(join(dir, "stop.json"), JSON.stringify({ stage: "planning", run: "0123456789abcdef", position: { summary: "mine" }, left: [], uncommitted: [] }));
    assert.match(run(state).stdout, /^stopped: 2026-10-30T10:00:00Z in planning: mine /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no stopped: row prints no stopped line", () => {
  const dir = makeTempDir("resume-check-");
  try {
    const r = run(makeState(dir, ["- stage: planning", `- root: ${dir}`]));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stdout, /^stopped/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const runWith = (statePath, ...args) => spawnSync("node", [SCRIPT, "--state", statePath, ...args], { encoding: "utf8" });

test("a state file newer than the plugin stops, naming the update command", () => {
  const dir = makeTempDir("resume-check-");
  const state = makeState(dir, ["- format: 999", "- stage: planning"]);
  const r = run(state);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claude plugin update devcycle@devcycle/);
  assert.match(readFileSync(state, "utf8"), /^- format: 999$/m);
});

test("an unparseable format row stops and quotes it", () => {
  const dir = makeTempDir("resume-check-");
  const r = run(makeState(dir, ["- format: one", "- stage: planning"]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"one"/);
});

test("an older state file gains the row and prints nothing extra when nothing else changed", () => {
  const dir = makeTempDir("resume-check-");
  const state = makeState(dir, ["- stage: planning"]);
  const r = run(state);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /format-/);
  assert.match(readFileSync(state, "utf8"), /^- format: 1$/m);
});

test("a stale older file is reported as stale and never stamped", () => {
  const dir = makeTempDir("resume-check-");
  const state = makeState(dir, ["- stage: planning", "- spec: docs/gone.md"]);
  assert.equal(run(state).status, 1);
  assert.doesNotMatch(readFileSync(state, "utf8"), /^- format:/m);
});

test("a headerless ledger prints the question, no entry line, and --format-answer settles it", () => {
  const dir = makeTempDir("resume-check-");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "plan.md"), "x");
  writeFileSync(join(dir, "ledger.md"), "- [2026-08-01T00:00:00Z] task=1 event=committed outcome=accepted ref=abc1234\n");
  const state = makeState(dir, ["- stage: branch-review", `- root: ${dir}`, "- plan: docs/plan.md"]);
  const asked = run(state);
  assert.equal(asked.status, 0, asked.stderr);
  assert.match(asked.stdout, /^format-question: /m);
  assert.doesNotMatch(asked.stdout, /^entry:/m);
  const answered = runWith(state, "--format-answer", "yes");
  assert.equal(answered.status, 0, answered.stderr);
  assert.match(answered.stdout, /^entry:/m);
  assert.match(readFileSync(join(dir, "ledger.md"), "utf8"), /^Plan: `docs\/plan\.md`$/m);
});

test("--format-answer takes only yes or no", () => {
  const dir = makeTempDir("resume-check-");
  const r = runWith(makeState(dir, ["- stage: planning"]), "--format-answer", "maybe");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--format-answer/);
});

test("a newer-format file that names a stage this plugin lacks gets the update message, not the stale one", () => {
  const dir = makeTempDir("resume-check-");
  const r = run(makeState(dir, ["- format: 999", "- stage: a-stage-from-the-future"]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /claude plugin update devcycle@devcycle/);
  assert.match(r.stderr, /[Rr]estart/);
  assert.doesNotMatch(r.stderr, /stale|not a valid devcycle stage/);
});

test("an unparseable format row with an unknown stage gets the row message, not the stale one", () => {
  const dir = makeTempDir("resume-check-");
  const r = run(makeState(dir, ["- format: one", "- stage: a-stage-from-the-future"]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"one"/);
  assert.doesNotMatch(r.stderr, /stale|not a valid devcycle stage/);
});

test("a stage nothing explains still reads as stale under a current format row", () => {
  const dir = makeTempDir("resume-check-");
  const r = run(makeState(dir, ["- format: 1", "- stage: a-stage-from-the-future"]));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale/);
  assert.match(r.stderr, /not a valid devcycle stage/);
});

test("a newer-format file whose plan or branch is gone is still reported stale first", () => {
  const dir = makeTempDir("resume-check-");
  const missing = run(makeState(dir, ["- format: 999", "- stage: a-stage-from-the-future", "- plan: docs/gone.md"]));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /stale/);
  assert.match(missing.stderr, /docs\/gone\.md/);
  assert.doesNotMatch(missing.stderr, /claude plugin update/);

  const repo = makeRepo();
  const branchGone = run(makeState(repo, ["- format: 999", "- stage: planning", "- branch: feat/never-existed (cut from main at 0000000)"]));
  assert.equal(branchGone.status, 1);
  assert.match(branchGone.stderr, /stale/);
  assert.match(branchGone.stderr, /feat\/never-existed/);
  assert.doesNotMatch(branchGone.stderr, /claude plugin update/);
});

// A cycle under <repo>/.devcycle whose run record names an earlier session, then this one, and a fixture
// Claude config dir holding the earlier session's main transcript: a copy of a dispatch-health fixture
// last written at `mtime`, or none. The child gets both fixture dirs, so it never reads the real ~/.claude.
const UNCONTROLLED_RUN = "0123456789abcdef";
const FIXTURE = (name) => new URL(`../fixtures/dispatch-health/${name}.jsonl`, import.meta.url).pathname;
function interrupted({ stage = "planning", handoff = "pending 2026-10-30T08:00:00Z", transcript = "api-error", mtime = Date.now() - 60 * 60_000 } = {}) {
  const repo = realpathSync.native(makeRepo());
  mkdirSync(join(repo, ".devcycle"));
  const state = join(repo, ".devcycle", "state.md");
  writeFileSync(state, ["# devcycle state", `- stage: ${stage}`, `- root: ${repo}`, `- run: ${UNCONTROLLED_RUN}`,
    "- updated: 2026-10-30T09:00:00Z", `- handoff: ${handoff}`, ""].join("\n"));
  const runs = makeTempDir("resume-check-runs-");
  mkdirSync(join(runs, repoSlug(gitToplevel(repo))), { recursive: true });
  for (const id of ["sess-last", "sess-me"])
    appendFileSync(join(runs, repoSlug(gitToplevel(repo)), `${UNCONTROLLED_RUN}.jsonl`), `${JSON.stringify({ kind: "session", sessionHash: hashSession(id) })}\n`);
  const config = makeTempDir("resume-check-config-");
  mkdirSync(join(config, "projects", "-repo"), { recursive: true });
  if (transcript) {
    const file = join(config, "projects", "-repo", "sess-last.jsonl");
    copyFileSync(FIXTURE(transcript), file);
    utimesSync(file, new Date(mtime), new Date(mtime));
  }
  return runWithEnv(state, { DEVCYCLE_RUNS_DIR: runs, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "sess-me" });
}
const linesOf = (r) => {
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout.trim().split("\n");
};
// The fixture's last record's stamp, to the second: what the uncontrolled: line reports for it.
const lastStampOf = (name) =>
  new Date(JSON.parse(readFileSync(FIXTURE(name), "utf8").trim().split("\n").at(-1)).timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");

test("an uncontrolled stop prints its stage, the last transcript's stamp and the label just before the handoff line", () => {
  const lines = linesOf(interrupted());
  assert.equal(lines.at(-2), `uncontrolled: planning since ${lastStampOf("api-error")} (usage-limit)`);
  assert.equal(lines.at(-1), "handoff: pending 2026-10-30T08:00:00Z");
});

test("with no transcript found the uncontrolled: line is labelled unknown and dated by the updated: row", () => {
  assert.equal(linesOf(interrupted({ transcript: null })).at(-2), "uncontrolled: planning since 2026-10-30T09:00:00Z (unknown)");
});

test("no uncontrolled: line for a running last session, a ready handoff or a done cycle", () => {
  for (const [what, opts] of [
    ["a running last session", { transcript: "pending-bash", mtime: Date.now() }],
    ["a ready handoff", { handoff: "ready 2026-10-30T08:00:00Z" }],
    ["a done cycle", { stage: "done" }],
  ]) {
    const lines = linesOf(interrupted(opts));
    assert.ok(!lines.some((line) => line.startsWith("uncontrolled:")), `${what}: ${lines.join("\n")}`);
    assert.match(lines.at(-1), /^handoff: /, what);
  }
});

const runIn = (statePath, cwd, env = process.env) =>
  spawnSync("node", [SCRIPT, "--state", statePath], { cwd, env, encoding: "utf8" });
const writeCycle = (checkout, branch) => writeInto(checkout, ".devcycle/state.md", [
  "# devcycle state", "- stage: execution", `- root: ${checkout}`, `- branch: ${branch} (cut from main at 0000000)`,
  "- spec: none", "- plan: none", "- checklist: none", "",
].join("\n"));
// The main checkout on main, and a sibling worktree on feat/b.
function withSibling() {
  const repo = realpathSync(makeRepo());
  const parent = makeTempDir("resume-check-wt-");
  const wt = join(parent, "wt");
  sh("git", ["worktree", "add", "-q", "-b", "feat/b", wt], { cwd: repo });
  return { repo, parent, wt: realpathSync(wt), done: () => [repo, parent].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

test("ownershipOf reports a foreign root with errors, and passes an own or unreadable file", () => {
  const repo = realpathSync(makeRepo());
  try {
    const own = writeCycle(repo, "feat/b");
    assert.deepEqual(ownershipOf(own), { ok: true });
    assert.deepEqual(ownershipOf(join(repo, "missing.md")), { ok: true });
    writeFileSync(own, readFileSync(own, "utf8").replace(`- root: ${repo}`, "- root: /somewhere/else"));
    const foreign = ownershipOf(own);
    assert.deepEqual([foreign.ok, foreign.kind, foreign.actualRoot], [false, "foreign", repo]);
    assert.ok(foreign.errors.length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("branch-held: the recorded branch is checked out in a sibling worktree (R2)", () => {
  const s = withSibling();
  try {
    const state = writeCycle(s.repo, "feat/b");
    const checked = checkState(state, { cwd: s.repo });
    assert.deepEqual([checked.ok, checked.kind, checked.rule, checked.worktree], [false, "elsewhere", "branch-held", s.wt]);
    assert.ok(checked.errors.length > 0);
    const allowed = checkState(state, { cwd: s.repo, allowBranchHeld: true });
    assert.deepEqual([allowed.ok, allowed.branchHeld], [true, { worktree: s.wt }]);
    const r = runIn(state, s.repo);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /this cycle belongs to another checkout/);
    assert.match(r.stderr, /branch-held/);
    assert.ok(r.stderr.includes(s.wt), r.stderr);
  } finally {
    s.done();
  }
});

test("other-checkout: run from the sibling worktree that holds the branch (R2')", () => {
  const s = withSibling();
  try {
    const state = writeCycle(s.repo, "feat/b");
    const checked = checkState(state, { cwd: s.wt });
    assert.deepEqual([checked.kind, checked.rule, checked.stateCheckout, checked.callerCheckout, checked.holdsBranch],
      ["elsewhere", "other-checkout", s.repo, s.wt, true]);
    const r = runIn(state, s.wt);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /other-checkout/);
    assert.ok(r.stderr.includes(s.repo), r.stderr);
  } finally {
    s.done();
  }
});

test("other-checkout: a nested worktree's state file read from the main checkout (R3)", () => {
  const repo = realpathSync(makeRepo());
  try {
    const nested = join(repo, ".worktrees", "n");
    sh("git", ["worktree", "add", "-q", "-b", "feat/n", nested], { cwd: repo });
    const state = writeCycle(realpathSync(nested), "feat/n");
    const checked = checkState(state, { cwd: repo });
    assert.deepEqual([checked.rule, checked.stateCheckout, checked.holdsBranch], ["other-checkout", realpathSync(nested), false]);
    assert.equal(runIn(state, repo).status, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a state file in an unrelated repository is not elsewhere", () => {
  const a = realpathSync(makeRepo());
  const b = realpathSync(makeRepo());
  try {
    sh("git", ["branch", "feat/b"], { cwd: a });
    const r = runIn(writeCycle(a, "feat/b"), b);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    [a, b].forEach((d) => rmSync(d, { recursive: true, force: true }));
  }
});

test("a worktree whose directory is gone does not hold the branch", () => {
  const s = withSibling();
  try {
    rmSync(s.wt, { recursive: true, force: true });
    const r = runIn(writeCycle(s.repo, "feat/b"), s.repo);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    s.done();
  }
});

test("a cycle in the worktree that holds its own branch passes", () => {
  const s = withSibling();
  try {
    const r = runIn(writeCycle(s.wt, "feat/b"), s.wt);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    s.done();
  }
});
