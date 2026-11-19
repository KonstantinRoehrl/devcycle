import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_CLAIMS_PATH, checkClaims, parseClaims, parseVerified, renderClaims } from "../../scripts/spec-claims.mjs";
import { commitAll, makeRepo, writeInto } from "./helpers.mjs";

const SCRIPT = new URL("../../scripts/spec-claims.mjs", import.meta.url).pathname;
const SPEC = "docs/spec.md";
const VERIFIED = [
  "Verified:",
  "- plan-check runs eight legs · paths: lib/legs.mjs · cmd: `grep -n LEGS lib/legs.mjs`",
  "- the sensor and the probe share a reader · paths: hooks/sensor.mjs, scripts/probe.mjs · cmd: `grep -n import hooks/sensor.mjs`",
  "- Node is pinned · paths: none · cmd: `cat .nvmrc`",
  "not a claim line",
].join("\n");

// A repo whose spec and cited files are committed, with the reviewer's Verified list saved beside it.
function reviewedRepo() {
  const repo = makeRepo();
  writeInto(repo, SPEC, "# Spec\n");
  writeInto(repo, "lib/legs.mjs", "export const LEGS = {};\n");
  writeInto(repo, "hooks/sensor.mjs", "import x from '../scripts/probe.mjs';\n");
  writeInto(repo, "scripts/probe.mjs", "export default 1;\n");
  commitAll(repo, "base");
  writeInto(repo, ".devcycle/spec-verified.md", VERIFIED);
  return repo;
}
const cli = (repo, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
const writeClaims = (repo) => cli(repo, "write", "--spec", SPEC, "--verified", ".devcycle/spec-verified.md");

test("parseVerified: one entry per claim line, paths none is empty, other lines ignored", () => {
  assert.deepEqual(parseVerified(VERIFIED), [
    { claim: "plan-check runs eight legs", paths: ["lib/legs.mjs"], cmd: "grep -n LEGS lib/legs.mjs" },
    { claim: "the sensor and the probe share a reader", paths: ["hooks/sensor.mjs", "scripts/probe.mjs"], cmd: "grep -n import hooks/sensor.mjs" },
    { claim: "Node is pinned", paths: [], cmd: "cat .nvmrc" },
  ]);
});

test("renderClaims and parseClaims round-trip; a file of another shape parses to null", () => {
  const stamp = { specPath: SPEC, specSha256: "a".repeat(64), head: "b".repeat(40), written: "2026-11-19T10:00:00Z", claims: parseVerified(VERIFIED) };
  const text = renderClaims(stamp);
  assert.match(text, /^# Spec claims\n- spec: docs\/spec\.md\n- spec-sha256: a{64}\n- head: b{40}\n- written: 2026-11-19T10:00:00Z\n\n## Verified\n- plan-check runs eight legs · paths: lib\/legs\.mjs · cmd: `grep -n LEGS lib\/legs\.mjs`\n/);
  assert.match(text, /^- Node is pinned · paths: none · cmd: `cat \.nvmrc`$/m);
  assert.deepEqual(parseClaims(text), stamp);
  assert.equal(parseClaims("# Something else\n"), null);
  assert.equal(parseClaims(text.replace("b".repeat(40), "HEAD")), null);
});

test("write stamps the spec hash and HEAD into .devcycle/spec-claims.md", () => {
  const repo = reviewedRepo();
  const r = writeClaims(repo);
  assert.equal(r.status, 0, r.stderr);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  assert.match(r.stdout, new RegExp(`^spec-claims: wrote 3 claims to \\.devcycle/spec-claims\\.md \\(spec [0-9a-f]{12}, head ${head.slice(0, 12)}\\)\\n$`));
  const stamped = parseClaims(readFileSync(join(repo, DEFAULT_CLAIMS_PATH), "utf8"));
  assert.equal(stamped.head, head);
  assert.equal(stamped.claims.length, 3);
});

test("check: unchanged paths are verified; a claim citing no path is always re-verified", () => {
  const repo = reviewedRepo();
  writeClaims(repo);
  const r = cli(repo, "check", "--spec", SPEC);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "spec-claims: 2 verified, 1 to re-verify\n"
    + "verified: plan-check runs eight legs · paths: lib/legs.mjs\n"
    + "verified: the sensor and the probe share a reader · paths: hooks/sensor.mjs, scripts/probe.mjs\n"
    + "reverify: Node is pinned · paths: none\n");
  assert.deepEqual(checkClaims({ specPath: SPEC, root: repo }).verified.map((c) => c.claim),
    ["plan-check runs eight legs", "the sensor and the probe share a reader"]);
});

test("check: a cited path changed since the review HEAD, committed or not, re-verifies its claim", () => {
  const repo = reviewedRepo();
  writeClaims(repo);
  writeInto(repo, "scripts/probe.mjs", "export default 2;\n");
  assert.equal(cli(repo, "check", "--spec", SPEC).stdout,
    "spec-claims: 1 verified, 2 to re-verify\nverified: plan-check runs eight legs · paths: lib/legs.mjs\nreverify: the sensor and the probe share a reader · paths: hooks/sensor.mjs, scripts/probe.mjs\nreverify: Node is pinned · paths: none\n");
  commitAll(repo, "move the probe");
  assert.equal(checkClaims({ specPath: SPEC, root: repo }).reverify.length, 2);
});

test("check: an edited spec, a missing file and an unknown HEAD each send every claim back", () => {
  const repo = reviewedRepo();
  assert.equal(cli(repo, "check", "--spec", SPEC).stdout, "spec-claims: none — verify every claim\n");
  assert.equal(checkClaims({ specPath: SPEC, root: repo }).status, "absent");
  writeClaims(repo);
  const claimsFile = join(repo, DEFAULT_CLAIMS_PATH);
  const text = readFileSync(claimsFile, "utf8");
  writeInto(repo, DEFAULT_CLAIMS_PATH, text.replace(/^- head: [0-9a-f]{40}$/m, `- head: ${"0".repeat(40)}`));
  assert.equal(cli(repo, "check", "--spec", SPEC).stdout, "spec-claims: review HEAD unknown — verify every claim\n");
  assert.equal(checkClaims({ specPath: SPEC, root: repo }).reverify.length, 3);
  writeInto(repo, DEFAULT_CLAIMS_PATH, text);
  writeInto(repo, SPEC, "# Spec, revised\n");
  const r = cli(repo, "check", "--spec", SPEC);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "spec-claims: spec changed since review — verify every claim\n");
  assert.equal(checkClaims({ specPath: SPEC, root: repo }).status, "stale-spec");
});

test("check --in and write --out name another claims file", () => {
  const repo = reviewedRepo();
  const w = cli(repo, "write", "--spec", SPEC, "--verified", ".devcycle/spec-verified.md", "--out", "elsewhere/claims.md");
  assert.match(w.stdout, /wrote 3 claims to elsewhere\/claims\.md/);
  assert.equal(cli(repo, "check", "--spec", SPEC, "--in", "elsewhere/claims.md").stdout.split("\n")[0], "spec-claims: 2 verified, 1 to re-verify");
});

test("a usage error exits 2: no subcommand, an unknown flag, a missing --spec or input file", () => {
  const repo = reviewedRepo();
  for (const args of [[], ["read"], ["check"], ["check", "--spec", SPEC, "--bogus", "x"], ["write", "--spec", SPEC],
    ["write", "--spec", SPEC, "--verified", "missing.md"]]) {
    const r = cli(repo, ...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^spec-claims: /);
  }
});

// Re-points the reviewer's Verified list at `lines` and stamps it, returning the write result.
const writeVerified = (repo, lines) => {
  writeInto(repo, ".devcycle/spec-verified.md", lines.join("\n"));
  return writeClaims(repo);
};
const claimOn = (claim, paths) => `- ${claim} · paths: ${paths} · cmd: \`true\``;
const checkLines = (repo) => cli(repo, "check", "--spec", SPEC).stdout.split("\n").slice(1).filter(Boolean);

test("check: a does-not-exist claim stays verified only while the path is absent", () => {
  const repo = reviewedRepo();
  writeVerified(repo, [claimOn("new.mjs does not exist", "scripts/new.mjs")]);
  assert.deepEqual(checkLines(repo), ["verified: new.mjs does not exist · paths: scripts/new.mjs"]);
  writeInto(repo, "scripts/new.mjs", "export {};\n");
  assert.deepEqual(checkLines(repo), ["reverify: new.mjs does not exist · paths: scripts/new.mjs"]);
});

test("check: a gitignored file appearing at a cited path re-verifies the claim", () => {
  const repo = reviewedRepo();
  writeInto(repo, ".gitignore", "out/\n");
  commitAll(repo, "ignore out");
  writeVerified(repo, [claimOn("no build output", "out/bundle.js")]);
  assert.deepEqual(checkLines(repo), ["verified: no build output · paths: out/bundle.js"]);
  writeInto(repo, "out/bundle.js", "x\n");
  assert.deepEqual(checkLines(repo), ["reverify: no build output · paths: out/bundle.js"]);
});

test("check: a new untracked file under a cited directory re-verifies the claim", () => {
  const repo = reviewedRepo();
  writeVerified(repo, [claimOn("lib holds one module", "lib")]);
  assert.deepEqual(checkLines(repo), ["verified: lib holds one module · paths: lib"]);
  writeInto(repo, "lib/extra.mjs", "export {};\n");
  assert.deepEqual(checkLines(repo), ["reverify: lib holds one module · paths: lib"]);
});

test("check: a claim on a tracked file re-verifies while edited and reads verified again once reverted", () => {
  const repo = reviewedRepo();
  writeVerified(repo, [claimOn("legs exported", "lib/legs.mjs")]);
  writeInto(repo, "lib/legs.mjs", "export const LEGS = { a: 1 };\n");
  assert.deepEqual(checkLines(repo), ["reverify: legs exported · paths: lib/legs.mjs"]);
  writeInto(repo, "lib/legs.mjs", "export const LEGS = {};\n");
  assert.deepEqual(checkLines(repo), ["verified: legs exported · paths: lib/legs.mjs"]);
});

test("write: a claim whose cited file is dirty is dropped, so reverting the file cannot make it read verified", () => {
  const repo = reviewedRepo();
  writeInto(repo, "lib/legs.mjs", "export const LEGS = { dirty: true };\n");
  const r = writeVerified(repo, [claimOn("legs are dirty", "lib/legs.mjs"), claimOn("probe is stable", "scripts/probe.mjs")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^spec-claims: wrote 1 claims to /);
  assert.match(r.stderr, /legs are dirty/);
  assert.doesNotMatch(r.stderr, /probe is stable/);
  assert.deepEqual(parseClaims(readFileSync(join(repo, DEFAULT_CLAIMS_PATH), "utf8")).claims.map((c) => c.claim), ["probe is stable"]);
  writeInto(repo, "lib/legs.mjs", "export const LEGS = {};\n");
  assert.deepEqual(checkLines(repo), ["verified: probe is stable · paths: scripts/probe.mjs"]);
});

test("write: a claim whose cited file is untracked or gitignored while present is dropped", () => {
  const repo = reviewedRepo();
  writeInto(repo, ".gitignore", "out/\n");
  commitAll(repo, "ignore out");
  writeInto(repo, "scripts/fresh.mjs", "export {};\n");
  writeInto(repo, "out/bundle.js", "x\n");
  const r = writeVerified(repo, [claimOn("fresh is small", "scripts/fresh.mjs"), claimOn("bundle is small", "out/bundle.js"), claimOn("probe is stable", "scripts/probe.mjs")]);
  assert.match(r.stdout, /^spec-claims: wrote 1 claims to /);
  assert.match(r.stderr, /fresh is small/);
  assert.match(r.stderr, /bundle is small/);
  assert.deepEqual(parseClaims(readFileSync(join(repo, DEFAULT_CLAIMS_PATH), "utf8")).claims.map((c) => c.claim), ["probe is stable"]);
});
