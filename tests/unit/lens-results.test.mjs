import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import store from "../../workflows/lib/result-store.js";
import { makeRepo, commitAll, sh } from "./helpers.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "lens-results.mjs");
const DIR = ".devcycle/review/round-1";
const LENSES = [
  { key: "alpha", charter: "alpha review." },
  { key: "beta", charter: "beta review." },
];
const FINDING = { file: "src/a.js", line: 1, claim: "wrong value", severity: "high", measuredAgainst: "docs/spec.md" };

// A repo one commit past its root, the reviewed range being that commit, with the spec in it.
function fixture() {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "docs", "spec.md"), "# Spec\n");
  commitAll(repo, "feature");
  const payloads = makeTempDir("devcycle-lens-payloads-");
  let n = 0;
  const payload = (value) => {
    const path = join(payloads, `${n++}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  };
  const save = (lenses = LENSES) =>
    run("save-lenses", "--dir", DIR, "--ref", "HEAD~1..HEAD", "--from", payload({ lenses, specPath: "docs/spec.md", lessons: "- lesson one" }));
  return { repo, payload, run, save };
}

test("with no saved lens set, lenses and missing exit non-zero and name the file", () => {
  const { run } = fixture();
  for (const command of ["lenses", "missing"]) {
    const r = run(command, "--dir", DIR);
    assert.equal(r.status, 3, command);
    assert.match(r.out.error, /no saved lens set at .*_lenses\.json/);
  }
});

test("save-lenses then lenses round-trips the lens set, the spec path and the lessons", () => {
  const { repo, run, save } = fixture();
  const saved = save();
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual([saved.out.saved, saved.out.lenses], [true, ["alpha", "beta"]]);
  const loaded = run("lenses", "--dir", DIR);
  assert.equal(loaded.status, 0);
  assert.deepEqual(
    { ref: loaded.out.ref, specPath: loaded.out.specPath, lessons: loaded.out.lessons, lenses: loaded.out.lenses },
    { ref: "HEAD~1..HEAD", specPath: "docs/spec.md", lessons: "- lesson one", lenses: LENSES },
  );
  assert.ok(existsSync(join(repo, DIR, "_lenses.json")));
  assert.equal(existsSync(join(repo, DIR, "_args.json")), false, "the panel's saved-arguments file is never written");
});

test("a recorded lens leaves missing and comes back in its results, in the panel's stored shape", () => {
  const { repo, run, save, payload } = fixture();
  save();
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["alpha", "beta"]);
  const rec = run("record", "--dir", DIR, "--lens", "alpha", "--from", payload({ findings: [FINDING], strengths: [] }));
  assert.equal(rec.status, 0, rec.stderr);
  assert.deepEqual([rec.out.recorded, rec.out.stored, rec.out.findings], ["alpha", true, 1]);
  const after = run("missing", "--dir", DIR).out;
  assert.deepEqual(after.missing, ["beta"]);
  const stored = { ...FINDING, needsExecution: false, lens: "alpha" };
  assert.deepEqual(after.results, [{ lens: "alpha", findings: [stored], strengths: [] }]);
  const file = JSON.parse(readFileSync(join(repo, DIR, "alpha.json"), "utf8"));
  assert.deepEqual(Object.values(file), [{ findings: [stored], strengths: [] }]);
});

test("a moved branch, a changed charter or an edited spec makes a recorded lens missing again", () => {
  const { repo, run, save, payload } = fixture();
  save();
  run("record", "--dir", DIR, "--lens", "alpha", "--from", payload({ findings: [] }));
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["beta"]);

  writeFileSync(join(repo, "docs", "spec.md"), "# Spec, edited\n");
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["alpha", "beta"], "an edited spec");
  writeFileSync(join(repo, "docs", "spec.md"), "# Spec\n");
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["beta"], "the spec restored");

  save([{ key: "alpha", charter: "alpha review, sharper." }, LENSES[1]]);
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["alpha", "beta"], "a changed charter");
  save();
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["beta"], "the charter restored");

  writeFileSync(join(repo, "src", "a.js"), "module.exports = 2;\n");
  commitAll(repo, "move the branch");
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["alpha", "beta"], "a moved branch");
});

test("an invalid payload exits non-zero and stores nothing, so the lens stays missing", () => {
  const { repo, run, save, payload } = fixture();
  save();
  const bad = [
    { strengths: [] },
    { findings: [{ ...FINDING, severity: "urgent" }] },
    { findings: [{ ...FINDING, measuredAgainst: "" }] },
    { findings: [{ ...FINDING, line: 0 }] },
    { findings: [], strengths: [{ file: "src/a.js", claim: "good" }] },
  ];
  for (const body of bad) {
    const r = run("record", "--dir", DIR, "--lens", "alpha", "--from", payload(body));
    assert.equal(r.status, 2, JSON.stringify(body));
    assert.equal(r.out.ok, false);
  }
  assert.equal(existsSync(join(repo, DIR, "alpha.json")), false);
  assert.deepEqual(run("missing", "--dir", DIR).out.missing, ["alpha", "beta"]);
});

test("record refuses a lens that is not in the saved lens set", () => {
  const { run, save, payload } = fixture();
  save();
  const r = run("record", "--dir", DIR, "--lens", "gamma", "--from", payload({ findings: [] }));
  assert.equal(r.status, 2);
  assert.match(r.out.error, /"gamma" is not in the saved lens set/);
});

test("record-refutation stores each verdict under the panel's refutation key", () => {
  const { repo, run, save, payload } = fixture();
  save();
  const finding = { ...FINDING, needsExecution: false, lens: "alpha" };
  const r = run("record-refutation", "--dir", DIR, "--from", payload({ verdicts: [{ finding, verified: true, verification: "read src/a.js" }] }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.out.recorded, r.out.stored], [1, 1]);
  const commits = ["HEAD~1", "HEAD"].map((rev) => sh("git", ["rev-parse", rev], { cwd: repo }).trim());
  const key = store.refutationKey(store.contentKey(...commits), finding);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, DIR, "_refutation.json"), "utf8")), {
    [key]: { verified: true, verification: "read src/a.js" },
  });
  const bad = run("record-refutation", "--dir", DIR, "--from", payload({ verdicts: [{ finding, verified: "yes", verification: "x" }] }));
  assert.equal(bad.status, 2);
});

test("a directory outside .devcycle/review/ and a ref git would read as an option are refused", () => {
  const { run, payload } = fixture();
  for (const dir of ["src", ".devcycle/review", ".devcycle/review/a/b"]) {
    assert.equal(run("missing", "--dir", dir).status, 2, dir);
  }
  const from = payload({ lenses: LENSES });
  for (const ref of ["--output=x..HEAD", "HEAD~1..-x", "HEAD", "HEAD~1..HEAD..x"]) {
    assert.equal(run("save-lenses", "--dir", DIR, "--ref", ref, "--from", from).status, 2, ref);
  }
});
