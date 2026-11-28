import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { findingId, maintDir, recordMaintenanceFinding } from "../../scripts/maintenance-findings.mjs";

const SCRIPT = new URL("../../scripts/hygiene-sweep.mjs", import.meta.url).pathname;
const source = (name) => `export function ${name}(value) {\n  return value + 1;\n}\n`;

// A committed repo whose history makes `b` the biggest cluster by blast radius and `a` the one that changes together most:
// a1 and a2 are committed together twice, b1, b2 and b3 once.
function gitRepo(files, commits) {
  const repo = makeTempDir("hyg-cli-");
  const vcs = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a]);
  vcs("init", "-q");
  const write = (rel, text) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  vcs("add", ".");
  vcs("commit", "-q", "-m", "init");
  commits.forEach((touched, i) => {
    for (const rel of touched) write(rel, `${files[rel]}// change ${i}\n`);
    vcs("add", ".");
    vcs("commit", "-q", "-m", `change ${i}`);
  });
  return repo;
}

const FILES = {
  "src/a1.js": `export const A_LIMIT = 5000;\n${source("fetchA1")}`,
  "src/a2.js": `export const A_LIMIT = 5000;\n${source("fetchA2")}`,
  "src/b1.js": `export const B_LIMIT = 7000;\n${source("fetchB1")}`,
  "src/b2.js": `export const B_LIMIT = 7000;\n${source("fetchB2")}`,
  "src/b3.js": `export const B_LIMIT = 7000;\n${source("fetchB3")}`,
};
const COMMITS = [["src/a1.js", "src/a2.js"], ["src/a1.js", "src/a2.js"], ["src/b1.js", "src/b2.js", "src/b3.js"]];

const run = (repo, ...extra) => {
  const out = join(makeTempDir("hyg-cli-out-"), "sweep");
  const r = spawnSync("node", [SCRIPT, "run", "--out", out, "--repo", repo, ...extra], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { out, summary: JSON.parse(r.stdout) };
};
const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const listFile = (lines) => {
  const file = join(makeTempDir("hyg-cli-list-"), "list.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
};
const material = (out) => read(out, "judgment-inputs.json").items.filter((i) => i.type === "material").map((i) => i.id);

test("run --hotspots hands the listed files, and only those, to the semantic index", () => {
  const repo = gitRepo(FILES, COMMITS);
  const listed = run(repo, "--hotspots", listFile(["src/b2.js"]));
  assert.deepEqual(material(listed.out), ["material:semantic-index:src/b2.js"]);
  assert.deepEqual(read(listed.out, "coverage.json").hotspots, { source: "list", files: ["src/b2.js"] });
  const churned = run(repo);
  assert.equal(read(churned.out, "coverage.json").hotspots.source, "churn");
});

test("finalize --judgments carries the judgment into the entries and the completeness of its kind", () => {
  const repo = gitRepo(FILES, COMMITS);
  const verdicts = join(makeTempDir("hyg-cli-verdicts-"), "verdicts.json");
  writeFileSync(verdicts, "[]\n");
  // finalize rewrites coverage.json, so each finalize gets its own run.
  const finalized = (withJudgments) => {
    const { out } = run(repo, "--hotspots", listFile(["src/a1.js"]));
    const judgments = join(makeTempDir("hyg-cli-judgments-"), "judgments.json");
    writeFileSync(judgments, JSON.stringify({ reached: read(out, "judgment-inputs.json").items.map((i) => i.id), verdicts: [], added: [
      { kind: "semantic-duplicate", sweep: "duplication", file: "src/a1.js", symbol: "fetchA1", clusterKey: "pair fetchA1,fetchA2",
        anchor: "pair fetchA1,fetchA2", outcome: "verified", note: "fetchA1 and fetchA2 add one to their input" }] }));
    const r = spawnSync("node", [SCRIPT, "finalize", "--dir", out, "--verdicts", verdicts, "--repo", repo, ...(withJudgments ? ["--judgments", judgments] : [])],
      { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { entries: read(out, "entries.json").map((e) => e.culpritKind), fullKinds: read(out, "coverage.json").fullKinds };
  };
  const without = finalized(false);
  assert.ok(!without.entries.includes("semantic-duplicate") && !without.fullKinds.includes("semantic-duplicate"));
  const judged = finalized(true);
  assert.ok(judged.entries.includes("semantic-duplicate"));
  assert.ok(judged.fullKinds.includes("semantic-duplicate"));
});

test("finalize --depth thorough orders clusters by co-change before blast radius, and standard by blast radius", () => {
  const repo = gitRepo(FILES, COMMITS);
  const { out } = run(repo);
  const verdicts = join(makeTempDir("hyg-cli-verdicts-"), "verdicts.json");
  writeFileSync(verdicts, "[]\n");
  const order = (depth) => {
    const r = spawnSync("node", [SCRIPT, "finalize", "--dir", out, "--verdicts", verdicts, "--repo", repo, ...(depth ? ["--depth", depth] : [])], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const section = readFileSync(join(out, "section-duplication.md"), "utf8");
    return { statement: /Findings: \d+, in ([a-z -]+) order/.exec(section)?.[1],
      anchors: [...section.matchAll(/^### \d+ duplicate-constant items? in constant (\w+)=/gm)].map((m) => m[1]) };
  };
  assert.deepEqual(order(), { statement: "blast-radius", anchors: ["B_LIMIT", "A_LIMIT"] });
  assert.deepEqual(order("thorough"), { statement: "co-change then blast-radius", anchors: ["A_LIMIT", "B_LIMIT"] });
  assert.equal(spawnSync("node", [SCRIPT, "finalize", "--dir", out, "--verdicts", verdicts, "--depth", "deep"], { encoding: "utf8" }).status, 1);
});

test("run --ref reads the findings store as committed at the ref, and a ref that does not resolve reads as an unreadable store", () => {
  const repo = makeTempDir("hyg-cli-ref-");
  const vcs = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a1.js"), source("fetchA1"));
  const id = findingId("semantic-duplicate", "pair fetchA1,fetchA2");
  recordMaintenanceFinding(repo, { findingKind: "maintenance-finding", findingId: id, culpritKind: "semantic-duplicate", title: "fetchA1 and fetchA2",
    severity: "low", confidence: "verified", affectedFiles: ["src/a1.js"], firstSeen: "2026-11-01", lastSeen: "2026-11-01", passes: 1, verify: "none" });
  vcs("init", "-q"); vcs("add", "."); vcs("commit", "-q", "-m", "base"); vcs("branch", "base");
  rmSync(maintDir(repo), { recursive: true });
  const records = (extra) => read(run(repo, ...extra).out, "judgment-inputs.json").items.filter((i) => i.type === "record").map((i) => i.id);
  assert.deepEqual(records([]), []);
  assert.deepEqual(records(["--ref", "base"]), [`record:${id}`]);
  const broken = run(repo, "--ref", "no-such-ref");
  const coverage = read(broken.out, "coverage.json");
  assert.match(coverage.degraded.join("\n"), /findings store unreadable \(.*no-such-ref/);
  assert.ok(!coverage.fullKinds.includes("semantic-duplicate"));
});
