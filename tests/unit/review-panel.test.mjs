import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import panel from "../../workflows/review-panel.js";
import { makeRepo, commitAll, makeFakeBin, runScript } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "..", "workflows", "review-panel.js");

// ---------- pure helpers ----------

test("dedupFindings merges same file+claim, keeps the stronger one, annotates the other lens", () => {
  const weak = { file: "f.js", claim: "Broken  loop", severity: "medium", lens: "spec", verified: false, verification: "v1" };
  const strong = { file: "f.js", claim: "broken loop", severity: "high", lens: "correctness", verified: true, verification: "v2" };
  const out = panel.dedupFindings([weak, strong]);
  assert.equal(out.length, 1);
  assert.equal(out[0].lens, "correctness");
  assert.equal(out[0].verified, true);
  assert.match(out[0].verification, /also reported by the spec lens/);
});

test("dedupFindings keeps distinct claims apart", () => {
  const a = { file: "f.js", claim: "claim one", severity: "low", lens: "spec", verified: false, verification: "" };
  const b = { file: "f.js", claim: "claim two", severity: "low", lens: "spec", verified: false, verification: "" };
  assert.equal(panel.dedupFindings([a, b]).length, 2);
});

test("rankFindings orders verified first, then by severity, then by file", () => {
  const f = (file, severity, verified) => ({ file, severity, verified, claim: "", lens: "", verification: "" });
  const ranked = panel.rankFindings([
    f("z.js", "high", false),
    f("b.js", "low", true),
    f("a.js", "low", true),
    f("c.js", "high", true),
  ]);
  assert.deepEqual(
    ranked.map((x) => x.file),
    ["c.js", "a.js", "b.js", "z.js"]
  );
});

test("truncate passes short text through and caps long text with a note", () => {
  assert.deepEqual(panel.truncate("short", 100, "spec"), { text: "short", note: null });
  const long = panel.truncate("x".repeat(101), 100, "spec");
  assert.match(long.text, /truncated at 100 chars/);
  assert.match(long.note, /spec truncated to 100 chars/);
});

test("fallbackSummary counts confirmed vs unverified and appends notes", () => {
  const s = panel.fallbackSummary(
    [
      { verified: true, severity: "high" },
      { verified: false, severity: "medium" },
    ],
    ["diff truncated"]
  );
  assert.match(s, /2 finding\(s\), 1 confirmed/);
  assert.match(s, /1 high/);
  assert.match(s, /1 unverified/);
  assert.match(s, /Notes: diff truncated/);
});

// ---------- end-to-end against a stubbed claude CLI ----------

test("panel end-to-end: lenses find, verifier confirms, dedup collapses, report on stdout", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, "spec.md"), "# Spec\nThe module must export 2.\n");
  commitAll(repo, "base");
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 3;\n"); // the diff under review

  const bin = makeFakeBin(
    "claude",
    `
const prompt = process.argv[process.argv.length - 1];
let out;
if (prompt.includes("You are one lens")) {
  out = { findings: [{ file: "src/a.js", line: 1, claim: "exports 3 where the spec requires 2", severity: "high" }] };
} else if (prompt.includes("adversarial verifier")) {
  out = { verified: true, verification: "read src/a.js; the claim stands" };
} else {
  out = { summary: "One confirmed high-severity spec deviation." };
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out }));
`
  );

  const res = runScript(SCRIPT, { ref: "HEAD", specPath: "spec.md" }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  // three lenses reported the identical claim -> dedup collapses to one
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verified, true);
  assert.equal(report.findings[0].severity, "high");
  assert.match(report.findings[0].verification, /also reported by/);
  assert.ok(report.summary.length > 0);
});

test("panel exits 1 when every lens reviewer fails (unusable CLI output)", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "spec.md"), "# Spec\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", `process.stdout.write("this is not json");`);
  const res = runScript(SCRIPT, { ref: "HEAD", specPath: "spec.md" }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /all lens reviewers failed/);
});
