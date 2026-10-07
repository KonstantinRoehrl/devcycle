import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { isMain } from "../../scripts/is-main.mjs";

const IS_MAIN = new URL("../../scripts/is-main.mjs", import.meta.url).href;

test("isMain: an entry reached through a symlink still counts as main (#147)", () => {
  const dir = realpathSync(makeTempDir("is-main"));
  const real = join(dir, "cli.mjs");
  writeFileSync(real, `import { isMain } from ${JSON.stringify(IS_MAIN)};\nif (isMain(import.meta.url, process.argv[1])) console.log("ran");\n`);
  const link = join(dir, "link.mjs");
  symlinkSync(real, link);
  assert.equal(spawnSync(process.execPath, [link], { encoding: "utf8" }).stdout.trim(), "ran");
  assert.equal(spawnSync(process.execPath, [real], { encoding: "utf8" }).stdout.trim(), "ran");
});

test("isMain: no entry, an unresolvable entry, or another file is not main", () => {
  const here = pathToFileURL(realpathSync(new URL(import.meta.url).pathname)).href;
  assert.equal(isMain(here, undefined), false);
  assert.equal(isMain(here, "/nonexistent/entry.mjs"), false);
  assert.equal(isMain(here, new URL("../../scripts/is-main.mjs", import.meta.url).pathname), false);
});
