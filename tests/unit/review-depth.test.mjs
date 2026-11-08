import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { commitAll, makeRepo, sh, writeInto } from "./helpers.mjs";
import { DECISION_FILES, MAX_CHUNKS, PANEL_USD_PER_LENS_JOB, decide, estimate, isExcluded, rangeChanges } from "../../scripts/review-depth.mjs";

const SCRIPT = join(process.cwd(), "scripts/review-depth.mjs");
const run = (args, cwd) => spawnSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8" });
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

// main gains a file after topic is cut, so a diff taken from main itself rather than the merge
// base would count that file as a deletion on topic.
function branchRepo(topicFiles) {
  const dir = makeRepo();
  writeInto(dir, "old.txt", lines(5));
  commitAll(dir, "base");
  sh("git", ["checkout", "-qb", "topic"], { cwd: dir });
  for (const [path, text] of Object.entries(topicFiles)) writeInto(dir, path, text);
  commitAll(dir, "topic work");
  sh("git", ["checkout", "-q", "main"], { cwd: dir });
  writeInto(dir, "main-only.txt", lines(10));
  commitAll(dir, "main moves on");
  return dir;
}

test("isExcluded: lockfiles by basename and generated files by name or directory", () => {
  for (const path of ["package-lock.json", "web/yarn.lock", "go.sum", "Cargo.lock", "app.min.js", "site.min.css",
    "bundle.js.map", "api/schema.generated.ts", "dist/index.js", "pkg/build/out.o", "vendor/lib.rb", "node_modules/x/i.js"])
    assert.equal(isExcluded(path), true, path);
  for (const path of ["src/index.js", "src/builder.ts", "docs/dist.md", "lockfile.md", "minimal.js", "build.gradle"])
    assert.equal(isExcluded(path), false, path);
});

const json = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const record = (dir, caller = "cycle") => JSON.parse(readFileSync(join(dir, DECISION_FILES[caller]), "utf8"));
const RUN = "0123456789abcdef";
const select = (dir, ...extra) => run(["select", "--scope", "branch", "--base", "main", "--branch", "topic",
  "--profile", "standard", "--caller", "cycle", "--run", RUN, "--lenses", "5", ...extra], dir);

test("select --reviewDepth single over a range past the old thresholds prints single (the pinned failing test)", () => {
  const dir = branchRepo({ "src/big.js": lines(13000), "hooks/guard.mjs": "export {};\n" });
  const out = json(select(dir, "--reviewDepth", "single"));
  assert.equal(out.verdict, "single");
  assert.equal(out.depthLine, "Depth: single (set)");
  assert.match(out.note, /hooks and guards/, "single still names the matched signal, and never escalates");
  assert.deepEqual([record(dir).engine, record(dir).consent, record(dir).run], ["single", "none", RUN]);
});

test("select --reviewDepth panel is panel with no scan and no question", () => {
  const dir = branchRepo({ "src/a.js": lines(3) });
  const out = json(select(dir, "--reviewDepth", "panel"));
  assert.deepEqual([out.verdict, out.depthLine, out.signals, out.maxChunks], ["panel", "Depth: panel (set)", [], 4]);
  assert.equal(record(dir).engine, "panel");
});

test("select auto: no signal on a large range is single, at every profile", () => {
  for (const profile of ["lean", "standard", "thorough"]) {
    const dir = branchRepo({ "src/big.js": lines(5000) });
    const out = json(run(["select", "--reviewDepth", "auto", "--scope", "branch", "--base", "main", "--branch", "topic",
      "--profile", profile, "--caller", "standalone", "--lenses", "5"], dir));
    assert.deepEqual([out.verdict, out.depthLine], ["single", "Depth: auto → single (no risk signal)"], profile);
    assert.ok(existsSync(join(dir, DECISION_FILES.standalone)), profile);
  }
});

test("select auto: a signal is ask, naming it, with a labelled estimate and the unreviewed chunk count", () => {
  const dir = branchRepo({ "hooks/guard.mjs": "export {};\n" });
  const out = json(select(dir, "--reviewDepth", "auto"));
  assert.equal(out.verdict, "ask");
  assert.equal(out.depthLine, null);
  assert.deepEqual(out.signals.map((s) => [s.id, s.paths]), [["hooks-guards", ["hooks/guard.mjs"]]]);
  assert.deepEqual(out.estimate, { chunks: 1, reviewedChunks: 1, unreviewedChunks: 0, lenses: 5,
    lowUsd: 2.35, highUsd: 3.55 });
  assert.deepEqual([record(dir).engine, record(dir).consent], ["ask", "none"]);
});

// The risk file is read from the working tree, which is the branch under review in a real run.
const onTopic = (dir) => { sh("git", ["checkout", "-q", "topic"], { cwd: dir }); return dir; };

test("select auto: a repo: signal from the risk file asks; a quieted one is single with the quieted note", () => {
  const extend = onTopic(branchRepo({ "src/billing/charge.ts": "x\n", ".claude/devcycle-risk.json": JSON.stringify({ paths: [{ glob: "src/billing/**", label: "billing" }] }) }));
  assert.deepEqual(json(select(extend, "--reviewDepth", "auto")).signals.map((s) => s.id), ["repo:billing"]);
  const quiet = onTopic(branchRepo({ "hooks/guard.mjs": "x\n", ".claude/devcycle-risk.json": JSON.stringify({ quiet: [{ signal: "hooks-guards", reason: "core" }] }) }));
  const out = json(select(quiet, "--reviewDepth", "auto"));
  assert.deepEqual([out.verdict, out.depthLine], ["single", "Depth: auto → single (no risk signal)"]);
  assert.match(out.note, /^quieted: hooks and guards — core$/);
});

test("select auto: an invalid risk file is single, naming the file", () => {
  const dir = branchRepo({ "hooks/guard.mjs": "x\n" });
  writeInto(dir, ".claude/devcycle-risk.json", "{broken");
  const out = json(select(dir, "--reviewDepth", "auto"));
  assert.equal(out.verdict, "single");
  assert.match(out.depthLine, /^Depth: auto → single \(scan failed: \.claude\/devcycle-risk\.json: does not parse/);
});

test("select auto at repo scope is single with the panel note and no scan", () => {
  const notARepo = makeTempDir("review-depth-repo-");
  sh("git", ["init", "-q"], { cwd: notARepo });
  const out = json(run(["select", "--reviewDepth", "auto", "--scope", "repo", "--profile", "standard", "--caller", "standalone"], notARepo));
  assert.deepEqual([out.verdict, out.depthLine, out.note],
    ["single", "Depth: auto → single (whole-repo scope; reviewDepth=panel available)", "reviewDepth=panel is available for a whole-repo review"]);
});

test("select auto at files scope scans the named files' current contents", () => {
  const dir = branchRepo({ "src/run.mjs": 'spawnSync("rm", ["-rf", "/"]);\n' });
  sh("git", ["checkout", "-q", "topic"], { cwd: dir });
  const out = json(run(["select", "--reviewDepth", "auto", "--scope", "files", "--paths", "src", "--profile", "standard",
    "--caller", "standalone", "--lenses", "3"], dir));
  assert.equal(out.verdict, "ask");
  assert.ok(out.signals.some((s) => s.id === "dangerous-calls"));
  assert.equal(out.estimate.chunks, 1);
});

test("consent records the answer once, and the depth line names the signals", () => {
  const dir = branchRepo({ "hooks/guard.mjs": "x\n" });
  json(select(dir, "--reviewDepth", "auto"));
  const yes = json(run(["consent", "--answer", "panel", "--caller", "cycle"], dir));
  assert.deepEqual([yes.engine, yes.depthLine], ["panel", "Depth: auto → panel (approved; signals: hooks and guards)"]);
  assert.deepEqual([record(dir).engine, record(dir).consent], ["panel", "panel"]);
  const again = run(["consent", "--answer", "single", "--caller", "cycle"], dir);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^review-depth: the cycle decision record is already answered/);
  json(select(dir, "--reviewDepth", "auto"));
  assert.equal(json(run(["consent", "--answer", "single", "--caller", "cycle"], dir)).depthLine,
    "Depth: auto → single (declined; signals: hooks and guards)");
});

test("decide and estimate: the pure rules", () => {
  const sig = { matched: [{ id: "x", label: "X", paths: ["a"] }], quieted: [] };
  assert.equal(decide({ knob: "auto", scope: "branch", signals: sig }).verdict, "ask");
  assert.equal(decide({ knob: "auto", scope: "branch", signals: sig, scanError: "boom" }).depthLine, "Depth: auto → single (scan failed: boom)");
  assert.equal(decide({ knob: "single", scope: "branch", signals: sig, scanError: "boom" }).note, null, "a failed scan just drops the note");
  assert.deepEqual(MAX_CHUNKS, { lean: 2, standard: 4, thorough: 8 });
  assert.deepEqual(PANEL_USD_PER_LENS_JOB, { low: 0.47, high: 0.71 });
  assert.deepEqual(estimate({ chunks: 16, lenses: 5, profile: "standard" }),
    { chunks: 16, reviewedChunks: 4, unreviewedChunks: 12, lenses: 5, lowUsd: 9.4, highUsd: 14.2 });
});

test("CLI: every usage error exits 1 with what failed and what to do, and writes no record", () => {
  const dir = branchRepo({ "src/a.js": lines(3) });
  const cases = [
    [["select", "--reviewDepth", "profile", "--scope", "branch", "--profile", "standard", "--caller", "standalone"], /--reviewDepth must be one of auto, single, panel, got "profile" — resolve profile first/],
    [["select", "--scope", "branch", "--profile", "standard", "--caller", "standalone"], /--reviewDepth must be one of auto, single, panel, got null/],
    [["select", "--reviewDepth", "auto", "--scope", "branch", "--profile", "standard", "--caller", "cycle", "--lenses", "3", "--base", "main", "--branch", "topic"], /--caller cycle needs --run <the state file's run: id>/],
    [["select", "--reviewDepth", "auto", "--scope", "branch", "--profile", "standard", "--caller", "standalone", "--lenses", "3"], /branch scope needs --base and --branch/],
    [["select", "--reviewDepth", "auto", "--scope", "files", "--profile", "standard", "--caller", "standalone", "--lenses", "3"], /files scope needs at least one --paths/],
    [["select", "--reviewDepth", "auto", "--scope", "branch", "--base", "main", "--branch", "topic", "--profile", "standard", "--caller", "standalone"], /auto needs --lenses <n> for the cost estimate/],
    [["select", "--reviewDepth", "auto", "--scope", "branch", "--base", "main;rm", "--branch", "topic", "--profile", "standard", "--caller", "standalone", "--lenses", "3"], /"main;rm" is not a valid ref name/],
    [["consent", "--answer", "maybe", "--caller", "standalone"], /--answer must be panel or single/],
    [["consent", "--answer", "panel", "--caller", "standalone"], /no standalone decision record at \.devcycle\/review\/standalone-decision\.json — run select first/],
    [["pick"], /unknown subcommand "pick" — run review-depth\.mjs select\|consent/],
  ];
  for (const [args, stderr] of cases) {
    const r = run(args, dir);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, new RegExp(`^review-depth: ${stderr.source}`), args.join(" "));
  }
  assert.ok(!existsSync(join(dir, DECISION_FILES.standalone)));
});

// -U0 stays under spawnSync's default 1 MB buffer while the -U3 diff the panel chunks does not.
test("select auto: a branch whose diff exceeds 1 MB still asks instead of failing", () => {
  const wide = (changed) => Array.from({ length: 40000 }, (_, i) => `${"x".repeat(40)} ${changed && i % 7 === 0 ? "changed" : i}`).join("\n") + "\n";
  const dir = makeRepo();
  writeInto(dir, "src/big.js", wide(false));
  commitAll(dir, "base");
  sh("git", ["checkout", "-qb", "topic"], { cwd: dir });
  writeInto(dir, "src/big.js", wide(true));
  writeInto(dir, "hooks/guard.mjs", "export {};\n");
  commitAll(dir, "topic work");
  sh("git", ["checkout", "-q", "main"], { cwd: dir });
  const out = json(select(dir, "--reviewDepth", "auto"));
  assert.equal(out.verdict, "ask");
  assert.ok(out.estimate.chunks > 1, "the 2 MB diff is more than one chunk");
  assert.equal(record(dir).engine, "ask");
});

test("rangeChanges: a -U0 patch over spawnSync's default 1 MB buffer is read, not thrown away", () => {
  const dir = makeRepo();
  writeInto(dir, "README.md", "base\n");
  commitAll(dir, "base");
  sh("git", ["checkout", "-qb", "topic"], { cwd: dir });
  writeInto(dir, "src/big.js", Array.from({ length: 30000 }, (_, i) => `${"x".repeat(40)} ${i}`).join("\n") + "\n");
  commitAll(dir, "topic work");
  sh("git", ["checkout", "-q", "main"], { cwd: dir });
  const [big, ...rest] = rangeChanges({ base: "main", branch: "topic", cwd: dir });
  assert.equal(rest.length, 0);
  assert.equal(big.path, "src/big.js");
  assert.equal(big.added.length, 30000);
  assert.equal(big.added[29999], `${"x".repeat(40)} 29999`);
});

test("select: a valid ref name that does not resolve is a single verdict with the reason and a record, never an exit", () => {
  for (const knob of ["auto", "single"]) {
    const dir = branchRepo({ "src/a.js": lines(3) });
    const out = json(run(["select", "--reviewDepth", knob, "--scope", "branch", "--base", "main", "--branch", "nope",
      "--profile", "standard", "--caller", "standalone", "--lenses", "3"], dir));
    assert.equal(out.verdict, "single", knob);
    if (knob === "auto") assert.match(out.depthLine, /^Depth: auto → single \(scan failed: .*"nope".*resolves in this clone.*fetch/);
    assert.equal(record(dir, "standalone").engine, "single", knob);
  }
});

test("select: a ref name that fails the name gate stays a usage error under every knob, with no record", () => {
  for (const knob of ["auto", "single", "panel"]) {
    const dir = branchRepo({ "src/a.js": lines(3) });
    const r = run(["select", "--reviewDepth", knob, "--scope", "branch", "--base", "main;rm", "--branch", "topic",
      "--profile", "standard", "--caller", "standalone", "--lenses", "3"], dir);
    assert.equal(r.status, 1, knob);
    assert.match(r.stderr, /^review-depth: "main;rm" is not a valid ref name/, knob);
    assert.ok(!existsSync(join(dir, DECISION_FILES.standalone)), knob);
  }
});
