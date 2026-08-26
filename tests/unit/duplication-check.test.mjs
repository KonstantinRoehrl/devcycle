import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/duplication-check.mjs");

function makeFixture(files) {
  // realpath: on macOS the temp dir is a symlink, and the child's cwd is the resolved
  // path, which would otherwise make every reported path a chain of `../`.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dup-check-")));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}

// stderr is piped so a failure's own message lands in the thrown error instead of the
// test runner's console; asserting on that message is what keeps `throws` from passing
// on an unrelated crash. Each call also runs from the fixture directory, which keeps the
// reported paths relative to it so an assertion can name the exact pair.
const PIPE = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };

test("flags a near-duplicate paragraph across two different files", () => {
  const paragraph =
    "The coordinator commits from wave one onward using an explicit pathspec that " +
    "covers only the task's own source files, never a bare git commit and never git " +
    "add -A, because concurrent implementers have in-flight edits elsewhere in the tree.";
  const dir = makeFixture({
    "a.md": `# A\n\n${paragraph}\n`,
    "b.md": `# B\n\n${paragraph}\n`,
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, "--dir", dir], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*a\.md:paragraph 1 ~= b\.md:paragraph 1 \(shingle 100%, content-word 100%\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes a corpus with no near-duplicate paragraphs across files", () => {
  // Both paragraphs clear MIN_PARAGRAPH_WORDS (33 and 30) so the pair actually reaches the
  // comparison: a fixture under the floor is filtered out first and passes no matter what
  // the comparison does.
  const dir = makeFixture({
    "a.md":
      "# A\n\nThis paragraph is entirely about how a wave's tasks are dispatched in one " +
      "message so that they all run at the same time, and it shares no real overlap with " +
      "the next file.\n",
    "b.md":
      "# B\n\nThis paragraph covers a completely different subject: the version bump belongs " +
      "in the release pull request, so the tagged commit is one that a check suite has " +
      "already reported on.\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], { ...PIPE, cwd: dir });
    assert.match(out, /duplication-check: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scans commands/ and agents/, not only playbooks and references", () => {
  const shared =
    "The coordinator owns every commit in the cycle and the implementer never runs " +
    "git add or git commit itself, leaving all of its work unstaged in the working " +
    "tree for the coordinator to review.\n";
  const dir = makeFixture({
    "commands/cycle.md": `---\ndescription: "c"\n---\n\n${shared}`,
    "agents/implementer.md": `---\nname: implementer\n---\n\n${shared}`,
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*agents\/implementer\.md:paragraph 1 ~= commands\/cycle\.md:paragraph 1 \(shingle 100%, content-word 100%\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scans docs/design/README.md and CONTRIBUTING.md, not only the four surface dirs", () => {
  const shared =
    "The coordinator owns every commit in the cycle and the implementer never runs " +
    "git add or git commit itself, leaving all of its work unstaged in the working " +
    "tree for the coordinator to review.\n";
  const dir = makeFixture({
    "docs/design/README.md": `# Design\n\n${shared}`,
    "references/delegation.md": `# D\n\n${shared}`,
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*references\/delegation\.md:paragraph 1 ~= docs\/design\/README\.md:paragraph 1/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catches a same-file restatement", () => {
  const p =
    "The green gate is re-run by the coordinator after every wave and its exit status " +
    "is read explicitly, because a suite that prints a failure and still exits zero is " +
    "not a gate at all.\n";
  const dir = makeFixture({ "playbooks/executing-waves.md": `# X\n\n${p}\n## Later\n\n${p}` });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*executing-waves\.md:paragraph 1 ~= playbooks\/executing-waves\.md:paragraph 2 \(shingle 100%, content-word 100%\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flags one rule restated in different words, below the shingle threshold", () => {
  const dir = makeFixture({
    "a.md":
      "# A\n\nThe coordinator re-runs the green gate itself after every wave and reads " +
      "the exit status explicitly, recording the wave complete in the ledger only when " +
      "that status is zero.\n",
    "b.md":
      "# B\n\nOnly when the green gate exit status comes back zero does the coordinator " +
      "record the wave complete in the ledger, and the coordinator re-runs that gate " +
      "itself after every wave.\n",
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, "--dir", dir], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*a\.md:paragraph 1 ~= b\.md:paragraph 1 \(shingle 2%, content-word 68%\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("passes two paragraphs stating different rules in the same vocabulary", () => {
  const dir = makeFixture({
    "a.md":
      "# A\n\nThe coordinator re-runs the green gate itself after every wave and reads " +
      "the exit status explicitly, recording the wave complete in the ledger only when " +
      "that status is zero.\n",
    "b.md":
      "# B\n\nA reviewer reads the diff against the brief and writes one verdict line per " +
      "finding, quoting the source file and line number so the coordinator can route each " +
      "finding without opening it.\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], { ...PIPE, cwd: dir });
    assert.match(out, /duplication-check: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Both fixtures below carry a frontmatter description and a body that restates it, each
// well over the 20-word floor, so neither can pass by being filtered out.
const DESCRIPTION =
  "Profile every devcycle-tagged session for token cost, context depth, and model routing, " +
  "then rank what a maintainer should fix first, or flag stale config references in a target file.";
const BODY =
  "Profile token cost, context depth, and model routing across every devcycle-tagged session, " +
  "then rank what a maintainer should fix first, or flag the stale config references a target file still carries.";

test("does not compare a command's frontmatter description against its own body", () => {
  const dir = makeFixture({
    "commands/doctor.md": `---\ndescription: "${DESCRIPTION}"\n---\n\n${BODY}\n`,
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir });
    assert.match(out, /duplication-check: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still flags two command bodies that duplicate each other, frontmatter aside", () => {
  const dir = makeFixture({
    "commands/doctor.md": `---\ndescription: "${DESCRIPTION}"\n---\n\n${BODY}\n`,
    "commands/audit.md": `---\ndescription: "Audit a branch against the quality criteria."\n---\n\n${BODY}\n`,
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*commands\/audit\.md:paragraph 1 ~= commands\/doctor\.md:paragraph 1 \(shingle 100%, content-word 100%\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The declared convention: "The single owner of <subject>. <Consumer> names this file and
// does not restate it." Each is over the 20-word floor and the two differ only in subject,
// which is what makes them score above the content-word threshold on their boilerplate.
const PREAMBLE_CONFIG =
  "The single owner of how devcycle resolves configuration for a run. A skill, command, or " +
  "agent that needs any of this names this file and does not restate it.";
const PREAMBLE_EVIDENCE =
  "The single owner of how devcycle proves a task did what it claims about its own work. A " +
  "skill, command, or agent that needs any of this names this file and does not restate it.";

test("exempts the declared shared-preamble convention on both sides of a pair", () => {
  const dir = makeFixture({
    "references/config.md": `# Configuration\n\n${PREAMBLE_CONFIG}\n`,
    "references/evidence.md": `# Evidence\n\n${PREAMBLE_EVIDENCE}\n`,
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir });
    assert.match(out, /duplication-check: ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A corpus this run never read is not a clean corpus. Each case below would have printed
// `duplication-check: ok` and exited 0 while comparing nothing.
const runCheck = (args, cwd) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });

test("a --dir that does not exist fails instead of reporting a clean corpus", () => {
  const dir = makeFixture({ "a.md": "# A\n" });
  try {
    const res = runCheck(["--dir", join(dir, "typo")], dir);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.doesNotMatch(res.stdout, /duplication-check: ok/);
    assert.match(res.stderr, /duplication-check: cannot scan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a --dir with no value fails instead of reporting a clean corpus", () => {
  const dir = makeFixture({ "a.md": "# A\n" });
  try {
    const res = runCheck(["--dir"], dir);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.doesNotMatch(res.stdout, /duplication-check: ok/);
    assert.match(res.stderr, /--dir requires a path argument/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable subdirectory fails instead of being skipped in silence", () => {
  const dir = makeFixture({ "a.md": "# A\n", "sub/b.md": "# B\n" });
  chmodSync(join(dir, "sub"), 0o000);
  try {
    const res = runCheck(["--dir", dir], dir);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /duplication-check: cannot scan/);
  } finally {
    chmodSync(join(dir, "sub"), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corpus with no markdown in it fails instead of passing on nothing", () => {
  const dir = makeFixture({ "notes.txt": "not markdown\n" });
  try {
    const res = runCheck(["--dir", dir], dir);
    assert.notEqual(res.status, 0, `stdout: ${res.stdout}`);
    assert.match(res.stderr, /no \.md files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ok line states how much was actually compared", () => {
  const dir = makeFixture({
    "a.md":
      "# A\n\nThis paragraph is entirely about how a wave's tasks are dispatched in one " +
      "message so that they all run at the same time, and it shares no real overlap with " +
      "the next file.\n",
  });
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--dir", dir], { ...PIPE, cwd: dir });
    assert.match(out, /duplication-check: ok \(1 paragraph\(s\) across 1 file\(s\)\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still flags a duplicated paragraph in two reference files that both open with the exempt preamble", () => {
  const shared =
    "A finding names the file and the line it was found at, states the symptom before the " +
    "mechanism, and carries one severity drawn from the catalog rather than a phrase the " +
    "reviewer invented on the spot.\n";
  const dir = makeFixture({
    "references/config.md": `# Configuration\n\n${PREAMBLE_CONFIG}\n\n${shared}`,
    "references/evidence.md": `# Evidence\n\n${PREAMBLE_EVIDENCE}\n\n${shared}`,
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED:\n - references\/config\.md:paragraph 2 ~= references\/evidence\.md:paragraph 2 \(shingle 100%, content-word 100%\)\n?$/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A regression fixture drawn from the corpus, not invented for the test. Every other fixture
// here is synthetic prose written to exercise a threshold, which shows the passes work on
// contrived input but not that they would have caught anything real. This pair is the actual
// violation this cycle's widened checker found: `commands/learn.md` restated the mode list
// that `playbooks/learning-from-sessions.md` owns, at `ba48a46`, measured at content-word
// 0.783 — the highest real score in the corpus and the reason the threshold stays at 0.55.
// Both sides are verbatim from that commit. If a future change stops flagging this, the
// checker has stopped catching the class of violation it was widened to catch.
const REAL_LEARN_COMMAND =
  "- `/devcycle:learn` — the whole loop. Every promotion is batched for confirmation before it\n" +
  "  lands; each memory is deleted only once its promotion has landed.\n" +
  "- `/devcycle:learn --preview` — mine and propose, write the dated artifact, land nothing,\n" +
  "  delete no memory.";

const REAL_LEARN_PLAYBOOK =
  "- default — the whole loop; every promotion is batched for confirmation before it lands.\n" +
  "- `--preview` — mine and propose, write the dated artifact, land nothing, delete no memory.";

test("flags the real learn.md/learning-from-sessions.md restatement the audit found", () => {
  const dir = makeFixture({
    "commands/learn.md": `# /devcycle:learn\n\n${REAL_LEARN_COMMAND}\n`,
    "playbooks/learning-from-sessions.md": `# Learning from sessions\n\n## Modes\n\n${REAL_LEARN_PLAYBOOK}\n`,
  });
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, "--dir", dir], { ...PIPE, cwd: dir }),
      /DUPLICATION CHECK FAILED[\s\S]*commands\/learn\.md[\s\S]*playbooks\/learning-from-sessions\.md/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unrecognised flag is an error, not a silent scan of the default corpus", () => {
  const dir = makeFixture({ "references/a.md": "# A\n" });
  assert.throws(
    () => execFileSync("node", [SCRIPT, "--dirr", dir], { cwd: dir, ...PIPE }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /duplication-check: unrecognised flag --dirr/);
      return true;
    },
  );
});

test("--dir with no value is a usage error", () => {
  const dir = makeFixture({ "references/a.md": "# A\n" });
  assert.throws(
    () => execFileSync("node", [SCRIPT, "--dir"], { cwd: dir, ...PIPE }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /duplication-check: --dir requires a path argument/);
      return true;
    },
  );
});

// Dropping the flag name leaves a bare token with nothing misspelled to notice: the token used
// to be discarded, so the run scanned the cwd instead of the directory the caller named and
// reported that unrelated corpus clean.
test("a bare path is an error, not a silent scan of the cwd", () => {
  const dir = makeFixture({ "references/a.md": "# A\n" });
  assert.throws(
    () => execFileSync("node", [SCRIPT, dir], { cwd: dir, ...PIPE }),
    (err) => {
      assert.equal(err.status, 1);
      assert.ok(
        err.stderr.includes(`duplication-check: unexpected argument "${dir}"`),
        `stderr must name the token it refused, got: ${err.stderr}`,
      );
      return true;
    },
  );
});
