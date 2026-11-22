import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { readTriageData, renderDelta } from "../../scripts/issue-triage.mjs";

const SCRIPT = join(process.cwd(), "scripts/issue-triage.mjs");
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
const block = (data) => "# Triage\n\nprose\n\n```issue-triage-data\n" + JSON.stringify(data, null, 2) + "\n```\n";
const issue = (number, impact, severity, extra = {}) => ({ number, title: `t${number}`, impact, severity, cluster: null, fixedBy: null, ...extra });
const data = (issues, clusters = []) => ({ version: 1, repo: "o/r", branch: "dev", commit: "abc", total: issues.length, fetched: issues.length, roadmap: "none", issues, clusters });

test("previous with no config and no docs/audits reports nothing recorded", () => {
  const dir = makeTempDir("triage-");
  const r = run(dir, "previous");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { reportDir: null, roadmap: null, previous: null });
});

test("previous falls back to docs/audits and picks the newest triage report by name", () => {
  const dir = makeTempDir("triage-");
  mkdirSync(join(dir, "docs/audits"), { recursive: true });
  for (const f of ["2026-11-01-issue-triage.md", "2026-11-20-issue-triage.md", "2026-11-25-repo-maintenance.md"])
    writeFileSync(join(dir, "docs/audits", f), "x\n");
  const r = run(dir, "previous");
  assert.deepEqual(JSON.parse(r.stdout), { reportDir: "docs/audits", roadmap: null, previous: "docs/audits/2026-11-20-issue-triage.md" });
});

test("previous orders same-day reports by their numeric suffix, not by file name", () => {
  const dir = makeTempDir("triage-");
  mkdirSync(join(dir, "docs/audits"), { recursive: true });
  for (const f of ["2026-11-22-issue-triage.md", "2026-11-22-issue-triage-2.md", "2026-11-22-issue-triage-10.md", "2026-11-21-issue-triage-3.md"])
    writeFileSync(join(dir, "docs/audits", f), "x\n");
  assert.equal(JSON.parse(run(dir, "previous").stdout).previous, "docs/audits/2026-11-22-issue-triage-10.md");
});

test("next hands out the date-named file, then -2, -3 once a same-day report exists", () => {
  const dir = makeTempDir("triage-");
  const reports = join(dir, "reports");
  const next = () => run(dir, "next", "--dir", "reports", "--date", "2026-11-22");
  assert.equal(next().stdout, join("reports", "2026-11-22-issue-triage.md") + "\n", "a missing directory still names the first file");
  mkdirSync(reports);
  assert.equal(next().stdout, join("reports", "2026-11-22-issue-triage.md") + "\n");
  writeFileSync(join(reports, "2026-11-22-issue-triage.md"), "x\n");
  assert.equal(next().stdout, join("reports", "2026-11-22-issue-triage-2.md") + "\n");
  writeFileSync(join(reports, "2026-11-22-issue-triage-2.md"), "x\n");
  assert.equal(next().stdout, join("reports", "2026-11-22-issue-triage-3.md") + "\n");
  writeFileSync(join(reports, "2026-11-23-issue-triage.md"), "x\n");
  assert.equal(next().stdout, join("reports", "2026-11-22-issue-triage-3.md") + "\n", "another day's report does not move today's name");
});

test("next without --date uses today's UTC date, and a malformed --date is refused", () => {
  const dir = makeTempDir("triage-");
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(run(dir, "next", "--dir", "r").stdout, join("r", `${today}-issue-triage.md`) + "\n");
  const bad = run(dir, "next", "--dir", "r", "--date", "yesterday");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /issue-triage: --date must be YYYY-MM-DD/);
});

test("previous never returns the path next hands out, and a same-day pair shows a real delta", () => {
  const dir = makeTempDir("triage-");
  const reports = join(dir, "reports");
  mkdirSync(reports);
  writeFileSync(join(reports, "2026-11-22-issue-triage.md"), block(data([issue(1, "high", "low")])));
  assert.equal(run(dir, "remember", "--report-dir", "reports", "--roadmap", "none").status, 0);
  const earlier = JSON.parse(run(dir, "previous").stdout).previous;
  const fresh = run(dir, "next", "--dir", "reports", "--date", "2026-11-22").stdout.trim();
  assert.equal(earlier, join("reports", "2026-11-22-issue-triage.md"));
  assert.notEqual(fresh, earlier);
  writeFileSync(join(dir, fresh), block(data([issue(1, "high", "low"), issue(2, "low", "low")])));
  assert.equal(JSON.parse(run(dir, "previous").stdout).previous, fresh, "once written, the second run is the newest");
  const out = run(dir, "delta", "--previous", earlier, "--current", fresh).stdout;
  assert.match(out, /### New \(1\)\n- #2 t2\n/);
});

test("an issue entry's optional tracked flag is tolerated and never changes the delta", () => {
  const prev = data([issue(1, "high", "low", { tracked: true })]);
  const curr = data([issue(1, "high", "low", { tracked: false, extra: "ignored" })]);
  assert.equal(readTriageData(block(prev)).issues[0].tracked, true);
  assert.match(renderDelta("p.md", prev, curr), /### Re-ranked \(0\)\n- none\n/);
});

test("remember records the report dir and roadmap, and previous reads them back", () => {
  const dir = makeTempDir("triage-");
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "notes/2026-10-02-issue-triage.md"), "x\n");
  assert.equal(run(dir, "remember", "--report-dir", "notes", "--roadmap", "none").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ".devcycle/issue-triage.json"), "utf8")), { reportDir: "notes", roadmap: "none" });
  assert.deepEqual(JSON.parse(run(dir, "previous").stdout), { reportDir: "notes", roadmap: "none", previous: "notes/2026-10-02-issue-triage.md" });
});

test("--config points both verbs at another file", () => {
  const dir = makeTempDir("triage-");
  assert.equal(run(dir, "remember", "--report-dir", "r", "--roadmap", "ROADMAP.md", "--config", "c.json").status, 0);
  assert.equal(JSON.parse(run(dir, "previous", "--config", "c.json").stdout).roadmap, "ROADMAP.md");
});

test("readTriageData reads the fenced block and rejects a missing one or another version", () => {
  assert.equal(readTriageData(block(data([issue(1, "high", "low")]))).issues[0].number, 1);
  assert.equal(readTriageData("# no block\n"), null);
  assert.equal(readTriageData(block({ ...data([]), version: 2 })), null);
});

test("renderDelta reports new, closed, re-ranked, finished clusters and newly fixed issues", () => {
  const prev = data([issue(1, "high", "high", { cluster: "C1" }), issue(2, "low", "low", { cluster: "C1" }), issue(3, "medium", "low"), issue(4, "low", "medium")], [{ id: "C1", title: "first", issues: [1, 2] }]);
  const curr = data([issue(3, "high", "low"), issue(4, "low", "medium", { fixedBy: "abc1234" }), issue(5, "medium", "medium")]);
  const out = renderDelta("2026-11-01-issue-triage.md", prev, curr);
  assert.match(out, /^## Delta since 2026-11-01-issue-triage\.md\n/);
  assert.match(out, /### New \(1\)\n- #5 t5\n/);
  assert.match(out, /### Closed \(2\)\n- #1 t1\n- #2 t2\n/);
  assert.match(out, /### Re-ranked \(1\)\n- #3 t3: impact medium → high, severity low → low\n/);
  assert.match(out, /### Clusters finished \(1\)\n- C1 first\n/);
  assert.match(out, /### Now fixed \(1\)\n- #4 t4 — fixed by abc1234\n/);
  const order = ["New", "Closed", "Re-ranked", "Clusters finished", "Now fixed"].map((s) => out.indexOf(`### ${s} (`));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("an empty section says none", () => {
  const same = data([issue(1, "high", "low")]);
  const out = renderDelta("p.md", same, same);
  for (const s of ["New", "Closed", "Re-ranked", "Clusters finished", "Now fixed"]) assert.match(out, new RegExp(`### ${s} \\(0\\)\\n- none\\n`));
});

test("delta reads both files, and a report with no block fails loudly", () => {
  const dir = makeTempDir("triage-");
  writeFileSync(join(dir, "p.md"), block(data([issue(1, "high", "low")])));
  writeFileSync(join(dir, "c.md"), block(data([issue(2, "low", "low")])));
  writeFileSync(join(dir, "bad.md"), "# prose only\n");
  const ok = run(dir, "delta", "--previous", "p.md", "--current", "c.md");
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /### New \(1\)\n- #2 t2/);
  const bad = run(dir, "delta", "--previous", "bad.md", "--current", "c.md");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /issue-triage: bad\.md has no readable issue-triage-data block/);
});

test("an unknown subcommand is an error, and the script never calls gh", () => {
  const r = run(makeTempDir("triage-"), "close");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown subcommand close \(previous \| next \| remember \| delta\)/);
  assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /node:child_process/, "the script spawns nothing, gh least of all");
});
