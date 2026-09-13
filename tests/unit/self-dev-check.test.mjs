// #237: the finish gate could not tell devcycle's own source tree from the installed plugin cache,
// so a "deliverable" written into the cache read as a green cycle. These cases pin the guard's two
// directions — did the deliverable land in the repo, and was the installed copy written to — plus
// the inert path every other repo takes, and the two states in which the guard must refuse to
// report a pass because it could not run at all.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { makeRepo, commitAll, writeInto, sh } from "./helpers.mjs";
import { preflight, assertLanding, pluginDigest } from "../../scripts/self-dev-check.mjs";
import { hashTree, digest40 } from "../../scripts/tree-hash.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "self-dev-check.mjs");

const manifestJson = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`;

// A throwaway installed-plugin tree: the manifest that names it, plus two shipped files the
// divergence cases move.
function makePlugin({ name = "devcycle", version = "1.0.0" } = {}) {
  const dir = makeTempDir("sdc-plugin-");
  writeInto(dir, ".claude-plugin/plugin.json", manifestJson(name, version));
  writeInto(dir, "scripts/shipped.mjs", "export const shipped = 1;\n");
  writeInto(dir, "playbooks/p.md", "# p\n");
  return dir;
}

// A repo that IS the plugin's own source: same plugin name, on a topic branch cut from main, with
// the state file whose branch annotation the landing diff reads its base from.
function makeSourceRepo({ name = "devcycle", version = "1.0.0" } = {}) {
  const dir = makeRepo();
  writeInto(dir, ".claude-plugin/plugin.json", manifestJson(name, version));
  writeInto(dir, "scripts/shipped.mjs", "export const shipped = 1;\n");
  writeInto(dir, "playbooks/p.md", "# p\n");
  commitAll(dir, "base");
  const base = sh("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
  sh("git", ["checkout", "-q", "-b", "topic"], { cwd: dir });
  writeInto(dir, ".devcycle/state.md", `# devcycle state\n- branch: topic (cut from main at ${base})\n`);
  return dir;
}

// Claude Code writes one of these into the installed plugin root per live `claude` process and
// removes it when that process exits, so which ones exist changes for reasons that have nothing to
// do with the run under way.
const lock = (pluginRoot, pid) => writeInto(pluginRoot, `.in_use/${pid}`, `{"pid":${pid},"procStart":1}`);

function land(repo, path) {
  writeInto(repo, path, "export const landed = 1;\n");
  commitAll(repo, "feat: land the deliverable");
}

test("a repo whose plugin name differs from the installed plugin's is not self-development", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makePlugin({ name: "some-other-plugin" });
  const r = preflight({ pluginRoot, repoRoot });
  assert.equal(r.inert, true);
  assert.deepEqual(r.lines, []);
  assert.equal(existsSync(join(repoRoot, ".devcycle", "plugin-manifest.json")), false);
});

test("a repo with no plugin manifest at all is inert in both modes", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeTempDir("sdc-consumer-");
  writeInto(repoRoot, "src/app.js", "// an ordinary consumer repo\n");
  assert.equal(preflight({ pluginRoot, repoRoot }).inert, true);
  const r = assertLanding({ pluginRoot, repoRoot, expect: ["src/never-landed.js"] });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.deepEqual(r.lines, []);
});

test("plugin root and repo root being one tree means there is no installed copy to diverge from", () => {
  const root = makePlugin();
  assert.equal(preflight({ pluginRoot: root, repoRoot: root }).inert, true);
  const r = assertLanding({ pluginRoot: root, repoRoot: root, expect: ["scripts/never-landed.mjs"] });
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("preflight names every path the installed copy and the repo disagree on, and writes the baseline", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  writeInto(repoRoot, "scripts/shipped.mjs", "export const shipped = 2;\n"); // same path, moved content
  writeInto(repoRoot, "scripts/repo-only.mjs", "export const fresh = 1;\n"); // written since the install
  rmSync(join(repoRoot, "playbooks", "p.md"));                              // shipped, gone from the repo
  commitAll(repoRoot, "feat: the repo moved ahead of the installed copy");

  const r = preflight({ pluginRoot, repoRoot });
  assert.equal(r.inert, false);
  const out = r.lines.join("\n");
  assert.match(out, /differ[^\n]*scripts\/shipped\.mjs/);
  assert.match(out, /only in the repo[^\n]*scripts\/repo-only\.mjs/);
  assert.match(out, /only in the installed copy[^\n]*playbooks\/p\.md/);

  const manifest = JSON.parse(readFileSync(join(repoRoot, ".devcycle", "plugin-manifest.json"), "utf8"));
  assert.equal(manifest.pluginVersion, "1.0.0");
  assert.match(manifest.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    [".claude-plugin/plugin.json", "playbooks/p.md", "scripts/shipped.mjs"],
  );
});

test("preflight says the installed copy is behind only on repo-only paths a release would carry", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  writeInto(repoRoot, ".gitignore", "scripts/local-notes.md\n");
  writeInto(repoRoot, "scripts/local-notes.md", "local scaffolding, never installable\n");
  writeInto(repoRoot, "scripts/pending-release.mjs", "export const fresh = 1;\n");
  commitAll(repoRoot, "feat: a path the next release installs");
  writeInto(repoRoot, "scripts/scratch.mjs", "export const local = 1;\n"); // never added to the index

  const out = preflight({ pluginRoot, repoRoot }).lines.join("\n");
  assert.match(out, /only in the repo[^\n]*installed copy is behind[^\n]*scripts\/pending-release\.mjs/);
  assert.doesNotMatch(out, /local-notes\.md/);
  assert.doesNotMatch(out, /scratch\.mjs/);
});

test("a repo git cannot answer for keeps every repo-only path, under a claim that says so", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makePlugin(); // the plugin's own name, so the guard is live, but not a checkout
  writeInto(repoRoot, ".git", "gitdir: /nonexistent\n"); // git refuses to answer rather than answering
  writeInto(repoRoot, "scripts/repo-only.mjs", "export const fresh = 1;\n");

  const out = preflight({ pluginRoot, repoRoot }).lines.join("\n");
  assert.match(out, /scripts\/repo-only\.mjs/);
  assert.doesNotMatch(out, /installed copy is behind/);
});

test("preflight says so when the installed copy matches the repo", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  const out = preflight({ pluginRoot, repoRoot }).lines.join("\n");
  assert.match(out, /matches the repo/);
  assert.doesNotMatch(out, /differ|only in/);
});

test("--assert names the deliverable that never reached the repo", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  preflight({ pluginRoot, repoRoot });
  land(repoRoot, "scripts/landed.mjs");

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs", "scripts/never.mjs"] });
  assert.equal(r.ok, false);
  const out = r.lines.join("\n");
  assert.match(out, /did not land in the repo/);
  assert.match(out, /scripts\/never\.mjs/);
  assert.doesNotMatch(out, /scripts\/landed\.mjs/);
});

test("--assert passes when every expected path is in the branch diff and the cache is untouched", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  preflight({ pluginRoot, repoRoot });
  land(repoRoot, "scripts/landed.mjs");

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs"] });
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("--assert names the cache file that was edited during the run", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  preflight({ pluginRoot, repoRoot });
  land(repoRoot, "scripts/landed.mjs");
  writeInto(pluginRoot, "scripts/shipped.mjs", "export const shipped = 99;\n"); // written into the cache

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs"] });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /installed plugin was modified during this run[^\n]*scripts\/shipped\.mjs/);
});

test("a Claude Code session opening or closing mid-run is not a modification of the installed plugin", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  lock(pluginRoot, 5463); // one session was already live when the cycle started
  preflight({ pluginRoot, repoRoot });
  land(repoRoot, "scripts/landed.mjs");
  lock(pluginRoot, 99999); // a second session opened while the cycle ran
  rmSync(join(pluginRoot, ".in_use", "5463")); // and the first one exited

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs"] });
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("the baseline records the files the plugin ships, never the host's lock files", () => {
  const pluginRoot = makePlugin();
  lock(pluginRoot, 5463);
  const repoRoot = makeSourceRepo();

  const out = preflight({ pluginRoot, repoRoot }).lines.join("\n");
  const manifest = JSON.parse(readFileSync(join(repoRoot, ".devcycle", "plugin-manifest.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    [".claude-plugin/plugin.json", "playbooks/p.md", "scripts/shipped.mjs"],
  );
  assert.doesNotMatch(out, /in_use/);
});

test("a plugin update mid-cycle is advisory, not a failure", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  preflight({ pluginRoot, repoRoot });
  land(repoRoot, "scripts/landed.mjs");
  writeInto(pluginRoot, "scripts/shipped.mjs", "export const shipped = 99;\n");
  writeInto(pluginRoot, ".claude-plugin/plugin.json", manifestJson("devcycle", "1.0.1"));

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs"] });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.match(r.lines.join("\n"), /plugin updated mid-cycle \(1\.0\.0 → 1\.0\.1\)/);
});

test("--assert with no baseline on disk reports that it could not run instead of passing", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  land(repoRoot, "scripts/landed.mjs"); // the deliverable landed; only the preflight never ran

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs"] });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /no baseline/);
});

test("--assert with no recorded branch base reports that it could not run instead of passing", () => {
  const pluginRoot = makePlugin();
  const repoRoot = makeSourceRepo();
  preflight({ pluginRoot, repoRoot });
  land(repoRoot, "scripts/landed.mjs");
  rmSync(join(repoRoot, ".devcycle", "state.md"));

  const r = assertLanding({ pluginRoot, repoRoot, expect: ["scripts/landed.mjs"] });
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), /no branch base/);
});

test("pluginDigest is the tree digest truncated to the run record's sha field", () => {
  const pluginRoot = makePlugin();
  assert.match(pluginDigest(pluginRoot), /^[0-9a-f]{40}$/);
  // The guard rolls its own digest over the shipped files alone; with no host runtime present there
  // is nothing to leave out, so the two must agree — which is what keeps that roll from drifting
  // away from the rule tree-hash.mjs owns.
  assert.equal(pluginDigest(pluginRoot), digest40(hashTree(pluginRoot).digest));
});

test("the plugin digest identifies the plugin's bits, not how many sessions are live", () => {
  const pluginRoot = makePlugin();
  const alone = pluginDigest(pluginRoot);
  lock(pluginRoot, 5463);
  lock(pluginRoot, 7417);
  assert.equal(pluginDigest(pluginRoot), alone, "two live sessions moved the digest");
  rmSync(join(pluginRoot, ".in_use", "5463"));
  assert.equal(pluginDigest(pluginRoot), alone, "a session exiting moved the digest");
  writeInto(pluginRoot, "scripts/shipped.mjs", "export const shipped = 2;\n");
  assert.notEqual(pluginDigest(pluginRoot), alone, "a shipped file changed and the digest did not");
});

test("the CLI prints a 40-hex plugin digest for the run record", () => {
  const r = spawnSync("node", [SCRIPT, "--plugin-digest"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
});

test("the CLI exits 0 and prints nothing in an ordinary consumer repo", () => {
  const repoRoot = makeTempDir("sdc-consumer-cli-");
  writeInto(repoRoot, "src/app.js", "// an ordinary consumer repo\n");
  const r = spawnSync("node", [SCRIPT, "--assert", "--expect", "src/never.js", "--repo", repoRoot], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "");
});

test("the CLI exits 1 on a violation in devcycle's own source repo", () => {
  const repoRoot = makeSourceRepo(); // same plugin name as this repo's, so the guard is live
  land(repoRoot, "scripts/landed.mjs");
  const r = spawnSync("node", [SCRIPT, "--assert", "--expect", "scripts/landed.mjs", "--repo", repoRoot], {
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no baseline/);
});

test("the CLI refuses --assert with no --expect rather than passing an empty check", () => {
  const r = spawnSync("node", [SCRIPT, "--assert"], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /--expect/);
});
