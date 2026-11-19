import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { writeInto } from "./helpers.mjs";
import { sizeOf, parseLedgerHeader, dispatchMapTaskCount, pairSpec, proposeCorpus } from "../../scripts/plan-bench-corpus.mjs";
import { validateManifest } from "../../scripts/plan-bench.mjs";

const SCRIPT = new URL("../../scripts/plan-bench-corpus.mjs", import.meta.url).pathname;
const tasks = (n) => Array.from({ length: n }, (_, i) => `Task ${i + 1}`);
const plan = (n) => `# Plan\n\n### Task 1: x\n\n## Dispatch Map\n\n- Wave 1: ${tasks(n).join(", ")} (file-disjoint)\n`;
const ledger = (planRel, branchLine) => `Plan: \`${planRel}\`\nRun: \`0123456789abcdef\`\n${branchLine}\nProfile: \`standard\`\n`;

test("sizeOf: up to 4 planned tasks is small, 5-8 medium, 9 and more large", () => {
  assert.deepEqual([1, 4, 5, 8, 9, 15].map(sizeOf), ["small", "small", "medium", "medium", "large", "large"]);
});

test("parseLedgerHeader reads the plan and the cut sha, backticked or not, and nulls a header without one", () => {
  assert.deepEqual(parseLedgerHeader(ledger("docs/p.md", "Branch: `feat/x` (cut from `dev` at `a4848b1`)")), { plan: "docs/p.md", base: "dev", cutSha: "a4848b1" });
  assert.deepEqual(parseLedgerHeader(ledger("docs/p.md", "Branch: `feat/y` (cut from `dev` at 00292ad, 2026-08-14T20:44Z)")), { plan: "docs/p.md", base: "dev", cutSha: "00292ad" });
  assert.deepEqual(parseLedgerHeader(ledger("docs/p.md", "Branch: fix/z (cut from dev at 58e5611)")), { plan: "docs/p.md", base: "dev", cutSha: "58e5611" });
  assert.equal(parseLedgerHeader(ledger("docs/p.md", "Branch: `feat/x`")), null);
  assert.equal(parseLedgerHeader("Branch: x (cut from dev at 58e5611)\n"), null);
});

test("dispatchMapTaskCount counts the last Dispatch Map's task ids", () => {
  assert.equal(dispatchMapTaskCount(`Quote: \`## Dispatch Map\`\n\n${plan(7)}`), 7);
  assert.equal(dispatchMapTaskCount("# no map\n"), 0);
});

test("pairSpec prefers a spec the plan names, else the newest same-topic spec no later than the plan", () => {
  const specs = ["2026-10-30-devcycle-stop-design.md", "2026-10-29-devcycle-stop.md", "2026-11-02-devcycle-stop-design.md", "2026-10-24-other-design.md"];
  assert.equal(pairSpec("docs/superpowers/plans/2026-10-30-devcycle-stop.md", "", specs), "docs/superpowers/specs/2026-10-30-devcycle-stop-design.md");
  assert.equal(pairSpec("docs/superpowers/plans/2026-10-30-x.md", "see docs/superpowers/specs/2026-10-24-other-design.md", specs), "docs/superpowers/specs/2026-10-24-other-design.md");
  assert.equal(pairSpec("docs/superpowers/plans/2026-10-30-x.md", "see docs/superpowers/specs/2026-01-01-gone.md", specs), null);
  assert.equal(pairSpec("docs/superpowers/plans/2026-10-30-unknown.md", "", specs), null);
});

// A repo whose .devcycle archives hold three replayable cycles, a duplicate archive and two that cannot be replayed.
function corpusRepo() {
  const root = makeTempDir("plan-bench-corpus-");
  const cycle = (archive, date, topic, n, sha, { spec = true } = {}) => {
    const planRel = `docs/superpowers/plans/${date}-${topic}.md`;
    writeInto(root, planRel, plan(n));
    if (spec) writeInto(root, `docs/superpowers/specs/${date}-${topic}-design.md`, "# spec\n");
    writeInto(root, `.devcycle/${archive}/ledger.md`, ledger(planRel, `Branch: \`feat/${topic}\` (cut from \`dev\` at \`${sha}\`)`));
  };
  cycle("archive-2026-10-01-feat-tiny", "2026-10-01", "tiny", 3, "1111111");
  cycle("archive-2026-10-02-feat-mid", "2026-10-02", "mid", 7, "2222222");
  cycle("archive-2026-10-03-feat-mid", "2026-10-02", "mid", 7, "3333333");
  cycle("archive-2026-10-04-feat-big", "2026-10-04", "big", 12, "4444444");
  cycle("archive-2026-10-05-feat-nospec", "2026-10-05", "nospec", 6, "5555555", { spec: false });
  writeInto(root, ".devcycle/archive-2026-10-06-feat-noplan/ledger.md", ledger("docs/superpowers/plans/gone.md", "Branch: x (cut from dev at 6666666)"));
  return root;
}

test("proposeCorpus lists replayable cycles by size, keeps the newest archive of a plan, and picks one per size", () => {
  const root = corpusRepo();
  const { candidates, picks, manifest } = proposeCorpus({ repoRoot: root });
  assert.deepEqual(candidates.map((c) => [c.id, c.size, c.tasks, c.baseSha]), [
    ["tiny", "small", 3, "1111111"], ["nospec", "medium", 6, "5555555"], ["mid", "medium", 7, "3333333"], ["big", "large", 12, "4444444"],
  ]);
  assert.equal(candidates.find((c) => c.id === "nospec").specPath, null);
  assert.deepEqual(picks, { small: "tiny", medium: "mid", large: "big" });
  assert.deepEqual(manifest.entries.map((e) => [e.id, e.repoPath, e.specPath, e.tasks]), [
    ["tiny", root, "docs/superpowers/specs/2026-10-01-tiny-design.md", 3],
    ["mid", root, "docs/superpowers/specs/2026-10-02-mid-design.md", 7],
    ["big", root, "docs/superpowers/specs/2026-10-04-big-design.md", 12],
  ]);
  assert.deepEqual(validateManifest(manifest).errors, []);
});

test("cli writes the proposal beside, never over, manifest.json and prints the candidate table", () => {
  const root = corpusRepo();
  const r = spawnSync(process.execPath, [SCRIPT, "--repo", root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\| Id \| Size \| Tasks \| Base \| Spec \| Pick \|$/m);
  assert.match(r.stdout, /^\| nospec \| medium \| 6 \| 5555555 \| no spec found \|  \|$/m);
  assert.match(r.stdout, /^\| big \| large \| 12 \| 4444444 \| docs\/superpowers\/specs\/2026-10-04-big-design\.md \| yes \|$/m);
  const proposed = join(root, ".devcycle/plan-bench/manifest.proposed.json");
  assert.equal(JSON.parse(readFileSync(proposed, "utf8")).entries.length, 3);
  const refused = spawnSync(process.execPath, [SCRIPT, "--repo", root, "--out", join(root, ".devcycle/plan-bench/manifest.json")], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to write manifest\.json/);
  assert.equal(existsSync(join(root, ".devcycle/plan-bench/manifest.json")), false);
});
