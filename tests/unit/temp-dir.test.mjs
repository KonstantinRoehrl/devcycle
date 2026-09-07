import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const HELPER = pathToFileURL(fileURLToPath(new URL("../../scripts/temp-dir.mjs", import.meta.url))).href;

// The helper's whole contract is observable only after its own process has exited, so every
// case here runs the code in a child and inspects what it left behind. Asserting on the
// registry from inside this process would prove nothing about cleanup.
function runChild(body) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", body], { encoding: "utf8" });
}

test("the directory is gone once the creating process exits", () => {
  const r = runChild(`
    import { existsSync } from "node:fs";
    import { makeTempDir } from ${JSON.stringify(HELPER)};
    const dir = makeTempDir("tdtest-exit-");
    if (!existsSync(dir)) { console.error("missing while running"); process.exit(2); }
    console.log(dir);
  `);
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.notEqual(dir, "");
  assert.equal(existsSync(dir), false, `leaked ${dir}`);
});

test("a process that throws still cleans up", () => {
  const r = runChild(`
    import { makeTempDir } from ${JSON.stringify(HELPER)};
    console.log(makeTempDir("tdtest-throw-"));
    throw new Error("boom");
  `);
  assert.equal(r.status, 1);
  const dir = r.stdout.trim();
  assert.notEqual(dir, "");
  assert.equal(existsSync(dir), false, `leaked ${dir}`);
});

test("many calls arm exactly one exit listener", () => {
  const r = runChild(`
    import { makeTempDir } from ${JSON.stringify(HELPER)};
    for (let i = 0; i < 20; i++) makeTempDir("tdtest-listeners-");
    console.log(process.listenerCount("exit"));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "1");
  assert.equal(r.stderr.includes("MaxListenersExceededWarning"), false, r.stderr);
});

test("an unremovable directory does not change the exit status", { skip: process.getuid?.() === 0 ? "runs as root, where mode 0 does not deny access" : false }, () => {
  const r = runChild(`
    import { mkdirSync, chmodSync } from "node:fs";
    import { join } from "node:path";
    import { makeTempDir } from ${JSON.stringify(HELPER)};
    const dir = makeTempDir("tdtest-locked-");
    mkdirSync(join(dir, "child"));
    chmodSync(dir, 0o000);
    console.log(dir);
  `);
  assert.equal(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  // The removal failed, which is the point: the directory is still there and the child still
  // exited 0. Unlock and remove it here so this test does not become the leak it is testing.
  assert.equal(existsSync(dir), true);
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});
