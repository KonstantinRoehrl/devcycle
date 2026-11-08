import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_SIGNALS } from "../../scripts/risk-signals.mjs";
import {
  MAX_SIGNAL_PATHS, RISK_FILE, RiskFileError, loadRepoRisk, matchSignals, pathChanges, rangeChanges, scanRisk,
} from "../../scripts/review-depth.mjs";
import { commitAll, makeRepo, sh, writeInto } from "./helpers.mjs";

const REQUIRED = ["auth-security", "hooks-guards", "ci-release", "data-migrations", "secrets-config", "dependencies", "dangerous-calls", "test-weakening"];
const file = (path, { status = "M", added = [], removed = [] } = {}) => ({ path, status, added, removed });
const ids = (files, opts) => matchSignals(files, opts).matched.map((h) => h.id);

test("every required signal class is built in, with a label, and no pattern carries g or y", () => {
  assert.deepEqual(BUILTIN_SIGNALS.map((s) => s.id), REQUIRED);
  for (const s of BUILTIN_SIGNALS) {
    assert.ok(s.label && s.matchers.length, s.id);
    for (const m of s.matchers) if (m.pattern) assert.doesNotMatch(m.pattern.flags, /[gy]/, `${s.id} ${m.pattern}`);
  }
});

// One hit and one near miss per class: the near miss is what a too-broad pattern would catch.
const CASES = {
  "auth-security": [file("src/auth/session.ts"), file("docs/auth/overview.md")],
  "hooks-guards": [file("hooks/block-destructive-git.mjs"), file("docs/hooks.md")],
  "ci-release": [file(".github/workflows/ci.yml"), file("docs/ci.md")],
  "data-migrations": [file("db/migrations/001_init.sql"), file("src/migrator-notes.txt")],
  "secrets-config": [file(".env.production"), file("src/env.ts")],
  "dependencies": [file("package.json", { added: ['    "left-pad": "^1.3.0",'] }), file("package.json", { added: ['  "version": "1.2.3",'] })],
  "dangerous-calls": [
    file("src/run.mjs", { added: ['  spawnSync("git", ["status"]);'] }),
    file("src/run.mjs", { added: ['  spawnSync("git", ["status", "-s"]);'], removed: ['  spawnSync("git", ["status"]);'] }),
  ],
  "test-weakening": [file("tests/unit/a.test.mjs", { status: "D" }), file("tests/unit/a.test.mjs", { added: ["  assert.equal(a, 1);"] })],
};

for (const [id, [hit, miss]] of Object.entries(CASES))
  test(`signal ${id}: matches its case and not its near miss`, () => {
    assert.ok(ids([hit]).includes(id), `${id} missed ${hit.path}`);
    assert.ok(!ids([miss]).includes(id), `${id} matched its near miss ${miss.path}`);
  });

test("test-weakening also catches skip markers and removed assertions", () => {
  assert.ok(ids([file("tests/unit/b.test.mjs", { added: ['test.skip("x", () => {});'] })]).includes("test-weakening"));
  assert.ok(ids([file("tests/unit/b.test.mjs", { removed: ["  assert.ok(x);", "  assert.ok(y);"], added: ["  assert.ok(x);"] })]).includes("test-weakening"));
});

// Narrowed after calibrating against past branches: each pair is a change that asks, then one that must not.
const NARROWED = {
  "auth-security": [
    [file("src/sessions/store.ts"), file("src/core/session_store.py")],
    [file("src/login.ts"), file("src/login.test.ts")],
  ],
  "ci-release": [[file("scripts/release.sh"), file("tests/test_release_notes.py")]],
  "data-migrations": [[file("db/schema.sql"), file("supabase/tests/access_test.sql")]],
  "secrets-config": [
    [file(".env"), file(".env.example")],
    [file("src/cfg.ts", { added: ['  apiKey: "abcdefgh12345678",'] }), file("src/cfg.ts", { added: ['  apiKey: "env(API_KEY_VALUE)",'] })],
  ],
  "dependencies": [
    [file("Cargo.toml", { added: ['serde = "1.0"'] }), file("pyproject.toml", { added: ['requires-python = ">=3.12"'] })],
    [file("package.json", { removed: ['    "left-pad": "^1.3.0",'] }), file("package.json", { added: ['    "left-pad": "^1.3.1",'], removed: ['    "left-pad": "^1.3.0",'] })],
    [file("package.json", { added: ['    "left-pad": "^1.3.1",', '    "is-odd": "^3.0.0",'], removed: ['    "left-pad": "^1.3.0",'] }), file("package.json", { added: ['    "node": ">=26",'] })],
  ],
  "dangerous-calls": [
    [file("src/run.js", { added: ['  child_process.exec(cmd);'] }), file("src/run.js", { added: ["  const m = PATTERN.exec(text);"] })],
    [file("src/run.py", { added: ["  subprocess.run(cmd)"] }), file("src/ui.py", { added: ["  menu.exec(point)", "  def exec(self):"] })],
    [file("scripts/clean.sh", { added: ["rm -rf build"] }), file("tests/unit/clean.test.mjs", { added: ["assert.match(out, /rm -rf build/);"] })],
    [file("src/run.mjs", { added: ['  execSync("ls");'] }), file("src/run.mjs", { added: ["// execSync(\"ls\") is gone"] })],
    [file("src/view.ts", { added: ["  el.innerHTML = html;"] }), file("src/view.spec.ts", { added: ["  el.innerHTML = html;"] })],
  ],
  "test-weakening": [
    [file("tests/test_a.py", { status: "D" }), file("docs/specs/a.md", { status: "D" })],
    [file("tests/unit/a.test.mjs", { removed: ["  assert.equal(a, 1);"] }), file("tests/unit/a.test.mjs", { removed: ["  expect(a).toBe(1);", "  assert a == 2"] })],
  ],
};

for (const [id, pairs] of Object.entries(NARROWED))
  pairs.forEach(([hit, miss], i) =>
    test(`signal ${id} after calibration, case ${i + 1}: asks on ${hit.path} and not on ${miss.path}`, () => {
      assert.ok(ids([hit]).includes(id), `${id} missed ${hit.path}`);
      assert.ok(!ids([miss]).includes(id), `${id} matched ${miss.path}`);
    }));

test("matchSignals reports at most three paths per signal and keeps quieted signals visible", () => {
  const files = ["hooks/a.mjs", "hooks/b.mjs", "hooks/c.mjs", "hooks/d.mjs"].map((p) => file(p));
  const { matched } = matchSignals(files);
  assert.equal(matched.find((h) => h.id === "hooks-guards").paths.length, MAX_SIGNAL_PATHS);
  const quiet = new Map([["hooks-guards", "hooks are this repo's core"]]);
  const out = matchSignals(files, { quiet });
  assert.ok(!out.matched.some((h) => h.id === "hooks-guards"));
  assert.deepEqual(out.quieted.map((h) => [h.id, h.reason]), [["hooks-guards", "hooks are this repo's core"]]);
});

test("loadRepoRisk: a missing file is no signal, a valid one adds repo: signals and quiets built-ins", () => {
  const dir = makeRepo();
  assert.deepEqual(loadRepoRisk(dir), { signals: [], quiet: new Map() });
  writeInto(dir, RISK_FILE, JSON.stringify({
    paths: [{ glob: "src/billing/**", label: "billing" }],
    content: [{ pattern: "stripe\\.", label: "payment calls" }],
    quiet: [{ signal: "hooks-guards", reason: "every branch touches hooks" }],
  }));
  const { signals, quiet } = loadRepoRisk(dir);
  assert.deepEqual(signals.map((s) => s.id), ["repo:billing", "repo:payment calls"]);
  assert.equal(quiet.get("hooks-guards"), "every branch touches hooks");
  assert.deepEqual(ids([file("src/billing/charge.ts"), file("src/pay.ts", { added: ["stripe.charges.create()"] })], { signals }), ["repo:billing", "repo:payment calls"]);
});

test("loadRepoRisk: an invalid file throws RiskFileError naming the file and the problem", () => {
  const cases = [
    ["{not json", /does not parse/],
    [JSON.stringify({ extra: [] }), /unknown key "extra"/],
    [JSON.stringify({ paths: [{ glob: "", label: "x" }] }), /paths\[0\]\.glob must be a non-empty string/],
    [JSON.stringify({ content: [{ pattern: "(", label: "x" }] }), /content\[0\]\.pattern is not a valid regular expression/],
    [JSON.stringify({ quiet: [{ signal: "hooks-guards", reason: " " }] }), /quiet\[0\]\.reason must be a non-empty string/],
    [JSON.stringify({ quiet: [{ signal: "nope", reason: "r" }] }), /quiet\[0\]\.signal "nope" is not a built-in signal/],
  ];
  for (const [text, why] of cases) {
    const dir = makeRepo();
    writeInto(dir, RISK_FILE, text);
    assert.throws(() => loadRepoRisk(dir), (e) => e instanceof RiskFileError && e.message.startsWith(RISK_FILE) && why.test(e.message), text);
  }
});

test("rangeChanges: added and removed lines per file from the merge base, renames followed, lockfiles left out", () => {
  const dir = makeRepo();
  writeInto(dir, "src/old.js", "keep\n");
  writeInto(dir, "tests/unit/gone.test.mjs", "assert.ok(1);\n");
  writeInto(dir, "src/edit.js", "-- leading dashes\nsame\n");
  commitAll(dir, "base");
  sh("git", ["checkout", "-qb", "topic"], { cwd: dir });
  sh("git", ["mv", "src/old.js", "src/new.js"], { cwd: dir });
  sh("git", ["rm", "-q", "tests/unit/gone.test.mjs"], { cwd: dir });
  writeInto(dir, "src/edit.js", "--- three dashes now\nsame\n");
  writeInto(dir, "package-lock.json", "{}\n");
  commitAll(dir, "topic");
  sh("git", ["checkout", "-q", "main"], { cwd: dir });
  writeInto(dir, "main-only.js", "x\n");
  commitAll(dir, "main moves on");
  const byPath = Object.fromEntries(rangeChanges({ base: "main", branch: "topic", cwd: dir }).map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ["src/edit.js", "src/new.js", "tests/unit/gone.test.mjs"]);
  assert.equal(byPath["src/new.js"].status, "R");
  assert.equal(byPath["tests/unit/gone.test.mjs"].status, "D");
  assert.deepEqual(byPath["tests/unit/gone.test.mjs"].removed, ["assert.ok(1);"]);
  assert.deepEqual(byPath["src/edit.js"].added, ["--- three dashes now"]);
  assert.deepEqual(byPath["src/edit.js"].removed, ["-- leading dashes"]);
});

test("pathChanges: every tracked file under a named path, its current lines as added", () => {
  const dir = makeRepo();
  writeInto(dir, "src/a.js", "one\ntwo\n");
  writeInto(dir, "src/deep/b.js", "three\n");
  commitAll(dir, "base");
  const files = pathChanges({ paths: ["src"], cwd: dir });
  assert.deepEqual(files.map((f) => [f.path, f.added]), [["src/a.js", ["one", "two"]], ["src/deep/b.js", ["three"]]]);
});

test("scanRisk: branch and files scope, the repo file read from the working-tree root", () => {
  const dir = makeRepo();
  writeInto(dir, "README.md", "x\n");
  commitAll(dir, "base");
  sh("git", ["checkout", "-qb", "topic"], { cwd: dir });
  writeInto(dir, "hooks/guard.mjs", "export {};\n");
  commitAll(dir, "topic");
  assert.deepEqual(scanRisk({ scope: "branch", base: "main", branch: "topic", cwd: dir }).matched.map((h) => h.id), ["hooks-guards"]);
  writeInto(dir, RISK_FILE, JSON.stringify({ quiet: [{ signal: "hooks-guards", reason: "core" }] }));
  const quieted = scanRisk({ scope: "files", paths: ["hooks"], cwd: dir });
  assert.deepEqual([quieted.matched, quieted.quieted.map((h) => h.id)], [[], ["hooks-guards"]]);
  writeInto(dir, RISK_FILE, "{broken");
  assert.throws(() => scanRisk({ scope: "files", paths: ["hooks"], cwd: dir }), RiskFileError);
});
