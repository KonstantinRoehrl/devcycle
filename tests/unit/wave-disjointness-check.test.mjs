import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(process.cwd(), "scripts/wave-disjointness-check.mjs");

// realpath: on macOS the temp dir is a symlink, which would otherwise make every
// reported path a chain of `../` when the script echoes back the plan path.
function makeFixture(planText) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wave-disjointness-")));
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, "plan.md");
  writeFileSync(planPath, planText, "utf8");
  return { dir, planPath };
}

const PIPE = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };

test("two same-wave tasks that declare the same file: exits 1 and names both tasks and the file", () => {
  const { dir, planPath } = makeFixture(
    `# Fixture Plan

### Task 1: First
**Files:**
- Create: scripts/shared.mjs

**Interfaces:** none

### Task 2: Second
**Files:**
- Modify: scripts/shared.mjs

**Interfaces:** none

## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
`
  );
  try {
    let stderr = "";
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    }, (err) => {
      stderr = (err.stdout ?? "") + (err.stderr ?? "");
      return err.status === 1;
    });
    assert.match(stderr, /Wave 1/);
    assert.match(stderr, /Task 1/);
    assert.match(stderr, /Task 2/);
    assert.match(stderr, /scripts\/shared\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("genuinely disjoint same-wave tasks: exits 0", () => {
  const { dir, planPath } = makeFixture(
    `# Fixture Plan

### Task 1: First
**Files:**
- Create: scripts/one.mjs

**Interfaces:** none

### Task 2: Second
**Files:**
- Create: scripts/two.mjs

**Interfaces:** none

## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
`
  );
  try {
    const out = execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two tasks in different waves sharing a file: exits 0 (disjointness is a same-wave invariant only)", () => {
  const { dir, planPath } = makeFixture(
    `# Fixture Plan

### Task 1: First
**Files:**
- Create: scripts/shared.mjs

**Interfaces:** none

### Task 2: Second
**Files:**
- Modify: scripts/shared.mjs

**Interfaces:** none

## Dispatch Map
- Wave 1: Task 1 (no dependencies)
- Wave 2: Task 2 (needs Task 1 committed)
`
  );
  try {
    const out = execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan with no Dispatch Map section: reports the problem rather than silently passing", () => {
  const { dir, planPath } = makeFixture(
    `# Fixture Plan

### Task 1: First
**Files:**
- Create: scripts/one.mjs

**Interfaces:** none
`
  );
  try {
    const out = execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    assert.match(out, /Dispatch Map/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line-range suffix and surrounding punctuation on a Files entry does not break file matching", () => {
  const { dir, planPath } = makeFixture(
    "# Fixture Plan\n\n" +
      "### Task 1: First\n" +
      "**Files:**\n" +
      "- Modify: \`scripts/shared.mjs:12-40\`\n\n" +
      "**Interfaces:** none\n\n" +
      "### Task 2: Second\n" +
      "**Files:**\n" +
      "- Modify: scripts/shared.mjs (touches the same helper)\n\n" +
      "**Interfaces:** none\n\n" +
      "## Dispatch Map\n" +
      "- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)\n"
  );
  try {
    let stderr = "";
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    }, (err) => {
      stderr = (err.stdout ?? "") + (err.stderr ?? "");
      return err.status === 1;
    });
    assert.match(stderr, /scripts\/shared\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan with no task headings is an error, not an ok", () => {
  const { dir, planPath } = makeFixture("# Prose only\n\n## Dispatch Map\n- Wave 1: Task 1\n");
  assert.throws(
    () => execFileSync("node", [SCRIPT, planPath], { cwd: dir, ...PIPE }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /no "### Task N" blocks found/);
      return true;
    },
  );
});

test("a plan whose tasks carry no **Files:** block is an error naming that condition", () => {
  const { dir, planPath } = makeFixture(
    "### Task 1: No files block\n\n**Interfaces:** none\n\n## Dispatch Map\n- Wave 1: Task 1\n",
  );
  assert.throws(
    () => execFileSync("node", [SCRIPT, planPath], { cwd: dir, ...PIPE }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /no "\*\*Files:\*\*" blocks found/);
      return true;
    },
  );
});

test("a Files field written inline on its own label line is read, not reported as missing", () => {
  const { dir, planPath } = makeFixture(
    `# Fixture Plan

### Task 1: First
**Files:** Create \`scripts/one.mjs\`, Test: \`tests/unit/one.test.mjs\`

**Interfaces:** none

### Task 2: Second
**Files:** Create \`scripts/two.mjs\`

**Interfaces:** none

## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
`
  );
  try {
    const out = execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    assert.match(out, /ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-wave overlap is still caught when both tasks declare their files inline", () => {
  const { dir, planPath } = makeFixture(
    `# Fixture Plan

### Task 1: First
**Files:** Create \`scripts/shared.mjs\`

**Interfaces:** none

### Task 2: Second
**Files:** Modify \`scripts/shared.mjs\`

**Interfaces:** none

## Dispatch Map
- Wave 1: Task 1, Task 2 (file-disjoint, no dependencies)
`
  );
  try {
    let stderr = "";
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    }, (err) => {
      stderr = (err.stdout ?? "") + (err.stderr ?? "");
      return err.status === 1;
    });
    assert.match(stderr, /Wave 1 -- Task 1 and Task 2 both list scripts\/shared\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a period-terminated declaration is the same file as its bare twin: the collision still exits 1", () => {
  // "Modify `x`. Test: `y`" ends its first clause with a period. While that period survived
  // normalization the two tasks looked like different files and this gate printed ok.
  const { dir, planPath } = makeFixture(
    `### Task 1: A
**Files:** Modify \`scripts/shared.mjs\`. Test: \`tests/unit/a.test.mjs\`

### Task 2: B
**Files:** Modify \`scripts/shared.mjs\`

## Dispatch Map
- Wave 1: Task 1, Task 2
`
  );
  try {
    let stderr = "";
    assert.throws(() => {
      execFileSync(process.execPath, [SCRIPT, planPath], PIPE);
    }, (err) => {
      stderr = (err.stdout ?? "") + (err.stderr ?? "");
      return err.status === 1;
    });
    assert.match(stderr, /Wave 1 -- Task 1 and Task 2 both list scripts\/shared\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan whose Files fields are present but name no file is an error, not an ok", () => {
  // The guard used to count tasks carrying the field, not the files it yielded, so
  // "**Files:** none" passed here while blast-radius -- which counts tokens -- hard-failed.
  const { dir, planPath } = makeFixture(
    `### Task 1: A
**Files:** none

### Task 2: B
**Files:** none

## Dispatch Map
- Wave 1: Task 1, Task 2
`
  );
  try {
    assert.throws(
      () => execFileSync(process.execPath, [SCRIPT, planPath], PIPE),
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /no "\*\*Files:\*\*" blocks found/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
