import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
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
  assert.deepEqual(panel.truncate("short", 100, "spec"), { text: "short", note: null, truncated: false });
  const long = panel.truncate("x".repeat(200), 100, "spec");
  assert.match(long.text, /truncated at 100 chars/);
  assert.equal(long.truncated, true);
  // The note has to carry how much was dropped: "truncated" alone reads like a detail.
  assert.match(long.note, /spec truncated to 100 of 200 chars \(50\.0% reached the reviewers\)/);
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

test("the severity vocabulary is the four values findings.md defines, in rank order", () => {
  assert.deepEqual(panel.SEVERITIES, ["critical", "high", "medium", "low"]);
});

test("rankFindings orders all four severities", () => {
  const f = (file, severity) => ({ file, severity, verified: true, claim: "", lens: "", verification: "" });
  const ranked = panel.rankFindings([f("d.js", "low"), f("b.js", "high"), f("a.js", "critical"), f("c.js", "medium")]);
  assert.deepEqual(ranked.map((x) => x.file), ["a.js", "b.js", "c.js", "d.js"]);
});

test("dedupFindings carries measuredAgainst through the merge", () => {
  const weak = { file: "f.js", claim: "same claim", severity: "medium", lens: "spec", verified: false, verification: "v1", measuredAgainst: "CONTRIBUTING.md" };
  const strong = { file: "f.js", claim: "Same  Claim", severity: "critical", lens: "correctness", verified: true, verification: "v2", measuredAgainst: "OWASP Top Ten" };
  const out = panel.dedupFindings([weak, strong]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "critical");
  assert.equal(out[0].measuredAgainst, "OWASP Top Ten");
});

test("fallbackSummary counts critical findings", () => {
  const s = panel.fallbackSummary([{ verified: true, severity: "critical" }], []);
  assert.match(s, /1 critical/);
});

// ---------- chunkDiff (#65) ----------

// Build a diff segment for one file with `hunks` hunks of roughly `hunkLen` chars each.
function fileDiff(name, hunks, hunkLen) {
  const header = `diff --git a/${name} b/${name}\nindex 000..111 100644\n--- a/${name}\n+++ b/${name}\n`;
  let body = "";
  for (let h = 0; h < hunks; h++) {
    body += `@@ -${h * 10},3 +${h * 10},3 @@ ctx\n`;
    body += `+${"x".repeat(hunkLen)}\n`;
  }
  return header + body;
}

test("chunkDiff returns a single chunk when the diff is within the cap", () => {
  const diff = fileDiff("a.js", 1, 20);
  const { chunks, notes } = panel.chunkDiff(diff, 10_000);
  assert.deepEqual(chunks, [diff]);
  assert.deepEqual(notes, []);
});

test("chunkDiff packs multiple files into cap-sized chunks with no truncation", () => {
  const a = fileDiff("a.js", 1, 300);
  const b = fileDiff("b.js", 1, 300);
  const c = fileDiff("c.js", 1, 300);
  const cap = 500;
  const { chunks, notes } = panel.chunkDiff(a + b + c, cap);
  assert.ok(chunks.length >= 2, `expected packing into multiple chunks, got ${chunks.length}`);
  for (const ch of chunks) assert.ok(ch.length <= cap, `chunk over cap: ${ch.length}`);
  const joined = chunks.join("\n");
  for (const f of ["a.js", "b.js", "c.js"]) assert.match(joined, new RegExp(f));
  assert.deepEqual(notes, []);
});

test("chunkDiff splits one oversize file at hunk boundaries without truncating", () => {
  const big = fileDiff("big.js", 6, 150); // one file, several hunks, over the cap below
  const cap = 400;
  const { chunks, notes } = panel.chunkDiff(big, cap);
  assert.ok(chunks.length >= 2, "oversize file should split across chunks");
  for (const ch of chunks) assert.ok(ch.length <= cap, `chunk over cap: ${ch.length}`);
  assert.deepEqual(notes, [], "hunk-splitting alone must not truncate");
});

test("chunkDiff truncates only a single hunk that alone exceeds the cap, and notes it", () => {
  const huge = fileDiff("huge.js", 1, 2_000); // one hunk larger than the cap
  const cap = 300;
  const { chunks, notes } = panel.chunkDiff(huge, cap);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /hunk truncated at 300 chars/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /single diff hunk exceeded 300 chars/);
});

// #5: when one file splits across chunks, EVERY chunk carrying hunk bodies must name its
// file, or a lens reviewing a later chunk cannot attribute its finding to the right path.
test("chunkDiff keeps every split chunk self-describing with its file header (#5)", () => {
  const big = fileDiff("big.js", 6, 150); // one file, several hunks, over the cap below
  const cap = 400;
  const { chunks } = panel.chunkDiff(big, cap);
  assert.ok(chunks.length >= 2, "oversize file should split across chunks");
  for (const ch of chunks) {
    if (/@@ /.test(ch)) {
      assert.match(ch, /--- a\/big\.js/, "a chunk carrying hunk bodies must name its file");
    }
  }
});

// #5, truncation path: a later hunk that alone exceeds the cap is still truncated, but the
// truncated chunk must keep the file header so the finding stays attributable.
test("chunkDiff keeps the file header on a truncated later hunk (#5)", () => {
  const header = `diff --git a/g.js b/g.js\nindex 000..111 100644\n--- a/g.js\n+++ b/g.js\n`;
  const smallHunk = `@@ -1,3 +1,3 @@ a\n+small\n`;
  const hugeHunk = `@@ -50,3 +50,3 @@ b\n+${"y".repeat(2_000)}\n`; // alone larger than the cap
  const cap = 300;
  const { chunks, notes } = panel.chunkDiff(header + smallHunk + hugeHunk, cap);
  const truncated = chunks.find((c) => /hunk truncated at 300 chars/.test(c));
  assert.ok(truncated, "the oversize later hunk should be truncated");
  assert.match(truncated, /--- a\/g\.js/, "a truncated later hunk must still carry its file header");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /single diff hunk exceeded 300 chars/);
});

// #6: two hunks truncated must yield ONE consolidated note, not the same sentence twice, so
// the COVERAGE WARNING banner and the report's notes array do not repeat it N times.
test("chunkDiff consolidates multiple truncations into one note (#6)", () => {
  const two = fileDiff("f1.js", 1, 2_000) + fileDiff("f2.js", 1, 2_000);
  const cap = 300;
  const { chunks, notes } = panel.chunkDiff(two, cap);
  assert.equal(notes.length, 1, `expected a single consolidated note, got ${notes.length}: ${JSON.stringify(notes)}`);
  assert.match(notes[0], /2 diff hunks exceeded 300 chars and were truncated/);
  // both truncated chunks still name their file (guards #5 on the truncation path too)
  const joined = chunks.join("\n");
  assert.match(joined, /--- a\/f1\.js/);
  assert.match(joined, /--- a\/f2\.js/);
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
  out = { findings: [{ file: "src/a.js", line: 1, claim: "exports 3 where the spec requires 2", severity: "high", measuredAgainst: "the spec" }] };
} else if (prompt.includes("adversarial verifier")) {
  out = { verified: true, verification: "read src/a.js; the claim stands" };
} else {
  out = { summary: "One confirmed high-severity spec deviation." };
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out }));
`
  );

  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, specPath: "spec.md" }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  // three lenses reported the identical claim -> dedup collapses to one
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].verified, true);
  assert.equal(report.findings[0].severity, "high");
  assert.match(report.findings[0].verification, /also reported by/);
  assert.ok(report.summary.length > 0);
});

// A fake claude for the multi-chunk fan-out test: it attributes one finding to each file
// present in ITS chunk's diff, tagging the finding with the chunk's file signature so the
// test can count how many distinct chunks were reviewed. A chunk that carries hunk bodies
// but no "diff --git" file header (the #5 failure mode) yields an UNATTRIBUTED finding.
const multiChunkClaude = `
const prompt = process.argv[process.argv.length - 1];
let out;
if (prompt.includes("You are one lens")) {
  const i = prompt.indexOf("## Diff");
  const diff = i >= 0 ? prompt.slice(i) : "";
  const files = [...diff.matchAll(/diff --git a\\/(\\S+) b\\//g)].map((m) => m[1]);
  if (files.length) {
    const sig = files.join("+");
    out = { findings: files.map((f) => ({
      file: f, line: 1,
      claim: "finding in " + f + " chunk<" + sig + ">",
      severity: "medium", measuredAgainst: "repo convention",
    })) };
  } else if (/@@ /.test(diff)) {
    out = { findings: [{ file: "UNATTRIBUTED", line: 1, claim: "orphan hunk with no file header", severity: "medium", measuredAgainst: "repo convention" }] };
  } else {
    out = { findings: [] };
  }
} else if (prompt.includes("adversarial verifier")) {
  out = { verified: true, verification: "confirmed" };
} else {
  out = { summary: "multi-chunk fan-out summary." };
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out }));
`;

// #4: exercise main()'s diffChunks fan-out, its totalClaudeLensJobs guard, and cross-chunk
// finding flattening in their n>1 form. The diff is many files, each well under the cap but
// together over it, so whole-file packing yields >=2 chunks with no single-hunk truncation.
test("panel fans out over a multi-chunk diff: all findings merge, correctly attributed, no coverage warning (#4)", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  const names = ["f1.js", "f2.js", "f3.js", "f4.js"];
  for (const n of names) writeFileSync(join(repo, "src", n), "// base\n");
  commitAll(repo, "base");
  // Each file's diff is well under DIFF_CHAR_CAP (60k); together they exceed it.
  for (const n of names) writeFileSync(join(repo, "src", n), "// x\n".repeat(3_800));

  const bin = makeFakeBin("claude", multiChunkClaude);
  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, lenses: ["correctness"] }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);

  // (a) more than one chunk was actually reviewed
  const sigs = new Set(report.findings.map((f) => (f.claim.match(/chunk<([^>]*)>/) || [])[1]));
  assert.ok(sigs.size >= 2, `expected >=2 chunks reviewed, got ${sigs.size}: ${[...sigs]}`);

  // (b) fully chunked, so no coverage reduction is disclosed anywhere
  assert.doesNotMatch(report.summary, /COVERAGE WARNING/);
  assert.ok(!report.notes.some((n) => /truncat/i.test(n)), `unexpected truncation note: ${JSON.stringify(report.notes)}`);

  // (c) findings from every chunk reached the merged report, each attributed to its own file
  const foundFiles = new Set(report.findings.map((f) => f.file));
  assert.ok(!foundFiles.has("UNATTRIBUTED"), "every reviewed chunk must name its file");
  for (const n of names) assert.ok(foundFiles.has("src/" + n), `missing finding for src/${n}`);
  for (const f of report.findings) assert.ok(f.claim.includes(f.file), `finding misattributed: ${JSON.stringify(f)}`);
});

test("panel exits 1 when every lens reviewer fails (unusable CLI output)", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "spec.md"), "# Spec\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", `process.stdout.write("this is not json");`);
  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, specPath: "spec.md" }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /all lens reviewers failed/);
});

// A fake claude that answers every stage and reports back what its prompt contained.
const echoingClaude = `
const prompt = process.argv[process.argv.length - 1];
let out;
if (prompt.includes("You are one lens")) {
  out = { findings: [{
    file: "src/a.js", line: 1,
    claim: prompt.includes("CUSTOM-CHARTER-TOKEN") ? "custom charter reached the lens" : "built-in charter only",
    severity: "critical",
    measuredAgainst: prompt.includes("## Spec") ? "the spec" : "repo convention",
  }] };
} else if (prompt.includes("adversarial verifier")) {
  out = { verified: true, verification: "read the file; the claim stands" };
} else {
  out = { summary: "one confirmed finding." };
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out }));
`;

test("scope {paths} reviews a file list with no spec and no diff", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", echoingClaude);
  const res = runScript(SCRIPT, { scope: { paths: ["src/a.js"] }, lenses: ["correctness"] }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].severity, "critical");
  // no specPath given -> no spec block reached the lens prompt
  assert.equal(report.findings[0].measuredAgainst, "repo convention");
});

test("a custom {key, charter} lens runs alongside a built-in key", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", echoingClaude);
  const res = runScript(
    SCRIPT,
    { scope: { paths: ["src/a.js"] }, lenses: [{ key: "conventions", charter: "CUSTOM-CHARTER-TOKEN: check repo conventions." }] },
    { cwd: repo, binDirs: [bin] }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.findings[0].claim, "custom charter reached the lens");
  assert.equal(report.findings[0].lens, "conventions");
});

test("scope rejects carrying both ref and paths", () => {
  const repo = makeRepo();
  const res = runScript(SCRIPT, { scope: { ref: "HEAD", paths: ["a.js"] } }, { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /exactly one of ref .* or paths/);
});

test("scope rejects carrying neither ref nor paths", () => {
  const repo = makeRepo();
  const res = runScript(SCRIPT, { scope: {} }, { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /exactly one of ref .* or paths/);
});

test("the spec lens is unselectable without a specPath", () => {
  const repo = makeRepo();
  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, lenses: ["spec"] }, { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"spec" lens requires args\.specPath/);
});

test("an explicit lens list naming spec without a specPath still fails, even beside other lenses", () => {
  const repo = makeRepo();
  const res = runScript(SCRIPT, { scope: { paths: ["a.js"] }, lenses: ["correctness", "spec"] }, { cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"spec" lens requires args\.specPath/);
});

test("with lenses omitted and no specPath, the spec lens is dropped and the other built-ins run", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", echoingClaude);
  const res = runScript(SCRIPT, { scope: { paths: ["src/a.js"] } }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.doesNotMatch(res.stderr, /lens "spec" reviewing/);
  assert.match(res.stderr, /lens "correctness" reviewing/);
  const report = JSON.parse(res.stdout);
  assert.equal(report.findings.length, 1);
});

// A fake claude whose summarizer reports back the panel notes its prompt carried.
const noteEchoingClaude = `
const prompt = process.argv[process.argv.length - 1];
let out;
if (prompt.includes("You are one lens")) {
  out = { findings: [{ file: "src/a.js", line: 1, claim: "a finding", severity: "low", measuredAgainst: "repo convention" }] };
} else if (prompt.includes("adversarial verifier")) {
  out = { verified: true, verification: "read the file; the claim stands" };
} else {
  const m = prompt.match(/Panel notes to mention: (.*)/);
  out = { summary: m ? "notes reaching the summary: " + m[1] : "no notes reached the summarizer" };
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out }));
`;

test("dropping the spec lens from a defaulted set is disclosed as a note that reaches the summary", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", noteEchoingClaude);
  const res = runScript(SCRIPT, { scope: { paths: ["src/a.js"] } }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.match(report.summary, /spec lens skipped: no specPath given/);
});

// A fake claude whose lens reports no line at all, and whose verifier reports back
// whether a line reached its prompt.
const linelessClaude = `
const prompt = process.argv[process.argv.length - 1];
let out;
if (prompt.includes("You are one lens")) {
  out = { findings: [{ file: "src/a.js", claim: "no line reported", severity: "medium", measuredAgainst: "repo convention" }] };
} else if (prompt.includes("adversarial verifier")) {
  // Only the prompt's own "file:" line may carry a line number; the spliced
  // red-team charter must not be able to decide this assertion.
  const fileLine = (prompt.match(/^\\s*file: .*$/m) || [""])[0];
  out = { verified: true, verification: fileLine.includes("(line") ? "a line reached the verifier" : "no line reached the verifier" };
} else {
  out = { summary: "one confirmed finding." };
}
process.stdout.write(JSON.stringify({ is_error: false, structured_output: out }));
`;

test("a truncated diff is disclosed in the panel's own output, not only in the reviewer prompts", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "// base\n");
  commitAll(repo, "base");
  // Well past DIFF_CHAR_CAP, so the reviewers see a sample of this diff, not all of it.
  writeFileSync(join(repo, "src", "a.js"), "// x\n".repeat(30_000));

  const bin = makeFakeBin("claude", echoingClaude);
  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, lenses: ["correctness"] }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  // The stubbed reconciler returns its own summary, so a disclosure that depends on the
  // reconciler repeating a note would be missing here. This fixture's whole diff is one
  // file changed in one hunk, so chunking alone can't help — it's the one path chunkDiff
  // still truncates.
  assert.match(report.summary, /COVERAGE WARNING/);
  assert.match(report.summary, /a single diff hunk exceeded 60000 chars and was truncated/);
  assert.ok(Array.isArray(report.notes), "the panel's notes must reach the caller as a field");
  assert.ok(
    report.notes.some((n) => /a single diff hunk exceeded 60000 chars and was truncated/.test(n)),
    `notes did not carry the truncation: ${JSON.stringify(report.notes)}`
  );
  assert.match(res.stderr, /a single diff hunk exceeded 60000 chars and was truncated/);
});

test("an untruncated panel run carries no coverage warning", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "// base\n");
  commitAll(repo, "base");
  writeFileSync(join(repo, "src", "a.js"), "// changed\n");

  const bin = makeFakeBin("claude", echoingClaude);
  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, lenses: ["correctness"] }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.doesNotMatch(report.summary, /COVERAGE WARNING/);
});

test("the red-team charter reaches the verifier with its plugin-root pointers resolved", () => {
  const charter = panel.loadRedTeamCharter();
  assert.ok(charter, "the shipped red-team charter must be readable");
  assert.ok(
    !charter.includes("CLAUDE_PLUGIN_ROOT"),
    "the charter must carry no unresolved ${CLAUDE_PLUGIN_ROOT} placeholder"
  );
  // The pointers it carries have to name a path that exists from where the verifier runs.
  const pluginRoot = join(here, "..", "..");
  for (const ref of ["references/findings.md", "references/output.md"])
    assert.ok(
      charter.includes(join(pluginRoot, ref)),
      `the charter must point at the resolved ${ref}`
    );
});

test("a finding with no integer line round-trips as line: null, and no line reaches the verifier", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  commitAll(repo, "base");

  const bin = makeFakeBin("claude", linelessClaude);
  const res = runScript(SCRIPT, { scope: { paths: ["src/a.js"] }, lenses: ["correctness"] }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.ok("line" in report.findings[0], "the line key is emitted, per references/findings.md");
  assert.equal(report.findings[0].line, null);
  assert.equal(report.findings[0].verification, "no line reached the verifier");
});

// F49: stage 2's per-finding verification has been capped at VERIFY_CONCURRENCY
// since it was written, while stage 1 passed `lensJobs.length` as its own limit
// — so a large branch review, the case chunking was added to serve, spawned the
// most processes. Eight lens jobs each dwelling 150 ms make an uncapped fan-out
// record eight concurrent processes; a capped one cannot exceed the cap.
test("stage 1 caps concurrent lens subprocesses instead of spawning one per job", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 1;\n");
  commitAll(repo, "base");
  writeFileSync(join(repo, "src", "a.js"), "module.exports = 3;\n"); // the diff under review

  const eventLog = join(mkdtempSync(join(tmpdir(), "devcycle-lens-conc-")), "events.log");
  const bin = makeFakeBin(
    "claude",
    `
const fs = require("node:fs");
const prompt = process.argv[process.argv.length - 1];
if (prompt.includes("You are one lens")) {
  // Small O_APPEND writes are atomic, so the file's line order IS the event order.
  fs.appendFileSync(${JSON.stringify(eventLog)}, "S\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  fs.appendFileSync(${JSON.stringify(eventLog)}, "E\\n");
  process.stdout.write(JSON.stringify({ is_error: false, structured_output: { findings: [] } }));
} else {
  process.stdout.write(JSON.stringify({ is_error: false, structured_output: { summary: "no findings" } }));
}
`
  );

  const lenses = Array.from({ length: 8 }, (_, i) => ({ key: `l${i}`, charter: `Charter ${i}.` }));
  const res = runScript(SCRIPT, { scope: { ref: "HEAD" }, lenses }, { cwd: repo, binDirs: [bin] });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const events = readFileSync(eventLog, "utf8").trim().split("\n");
  assert.equal(events.filter((e) => e === "S").length, 8, "every lens still runs — a cap is not a drop");

  let live = 0;
  let peak = 0;
  for (const e of events) {
    live += e === "S" ? 1 : -1;
    if (live > peak) peak = live;
  }
  assert.ok(peak <= 4, `stage 1 peaked at ${peak} concurrent lens processes; the cap is 4`);
  assert.equal(panel.LENS_CONCURRENCY, 4, "the cap is the VERIFY_CONCURRENCY value it follows");
});
