import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("devcycle-root resolves through PATH and prints the plugin root", () => {
  const out = execFileSync("devcycle-root", {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(REPO, "bin")}:${process.env.PATH}` },
  }).trim();
  assert.equal(realpathSync(out), realpathSync(REPO));
});

test("devcycle-root is executable", () => {
  // execFileSync through PATH already proves the bit is set; assert the mode explicitly so the
  // failure message names the cause rather than surfacing as ENOENT/EACCES.
  assert.ok(statSync(join(REPO, "bin", "devcycle-root")).mode & 0o111, "bin/devcycle-root must be executable");
});
