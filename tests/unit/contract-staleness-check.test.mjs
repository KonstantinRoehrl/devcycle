// #238: advisory preflight comparing the running (cached) plugin's evidence-contract version
// against the target repo's, so a cached install predating the contract is detected and the
// user is warned to reinstall. Never blocking — every comparison outcome exits 0; only a usage
// error (a missing required flag) exits 1. Spawns the CLI as a subprocess, exactly as a playbook
// would invoke it, and asserts on its exact stdout/stderr and exit code.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "contract-staleness-check.mjs");

// Builds a throwaway root with `references/evidence.md` carrying the given marker (or none).
function makeRoot(version) {
  const dir = mkdtempSync(join(tmpdir(), "csc-"));
  mkdirSync(join(dir, "references"), { recursive: true });
  const body = version === null
    ? "# Evidence\n\nNo marker here.\n"
    : `# Evidence\n\n<!-- evidence-contract-version: ${version} -->\n`;
  writeFileSync(join(dir, "references", "evidence.md"), body);
  return dir;
}

function run(args) {
  return spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });
}

test("cached plugin contract older than the repo's ⇒ stale, exit 0", () => {
  const pluginRoot = makeRoot(1);
  const repoRoot = makeRoot(2);
  try {
    const r = run(["--plugin-root", pluginRoot, "--repo-root", repoRoot]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(
      r.stdout.trim(),
      "contract-staleness: stale — cached plugin contract v1 < repo v2; reinstall the plugin"
    );
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("cached plugin contract matches the repo's ⇒ ok (version N), exit 0", () => {
  const pluginRoot = makeRoot(2);
  const repoRoot = makeRoot(2);
  try {
    const r = run(["--plugin-root", pluginRoot, "--repo-root", repoRoot]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), "contract-staleness: ok (version 2)");
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("repo evidence.md carries no version marker ⇒ unknown, exit 0", () => {
  const pluginRoot = makeRoot(2);
  const repoRoot = makeRoot(null);
  try {
    const r = run(["--plugin-root", pluginRoot, "--repo-root", repoRoot]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(
      r.stdout.trim(),
      "contract-staleness: unknown — repo evidence.md carries no version marker"
    );
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("plugin-root and repo-root are the same directory ⇒ ok, nothing to compare, exit 0", () => {
  const root = makeRoot(null); // no marker at all — proves this short-circuits before any version check
  try {
    const r = run(["--plugin-root", root, "--repo-root", root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), "contract-staleness: ok (nothing to compare)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing --repo-root ⇒ usage error, exit 1", () => {
  const pluginRoot = makeRoot(1);
  try {
    const r = run(["--plugin-root", pluginRoot]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--repo-root/);
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true });
  }
});
