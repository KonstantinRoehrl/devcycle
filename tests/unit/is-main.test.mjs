import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { isMain } from "../../scripts/is-main.mjs";

const IS_MAIN = new URL("../../scripts/is-main.mjs", import.meta.url).href;

// A CLI that prints "ran" when isMain says it is the entry, plus a symlink pointing at it.
function symlinkedCli() {
  const dir = realpathSync(makeTempDir("is-main"));
  const real = join(dir, "cli.mjs");
  writeFileSync(real, `import { isMain } from ${JSON.stringify(IS_MAIN)};\nif (isMain(import.meta.url, process.argv[1])) console.log("ran");\n`);
  const link = join(dir, "link.mjs");
  symlinkSync(real, link);
  return { real, link };
}

test("isMain: an entry reached through a symlink still counts as main (#147)", () => {
  const { real, link } = symlinkedCli();
  assert.equal(spawnSync(process.execPath, [link], { encoding: "utf8" }).stdout.trim(), "ran");
  assert.equal(spawnSync(process.execPath, [real], { encoding: "utf8" }).stdout.trim(), "ran");
});

test("isMain: no entry, an unresolvable entry, or another file is not main", () => {
  const here = pathToFileURL(realpathSync(new URL(import.meta.url).pathname)).href;
  assert.equal(isMain(here, undefined), false);
  assert.equal(isMain(here, "/nonexistent/entry.mjs"), false);
  assert.equal(isMain(here, new URL("../../scripts/is-main.mjs", import.meta.url).pathname), false);
});

// That flag keeps import.meta.url on the symlink path, so resolving only the entry side never matches.
test("isMain: a symlinked entry still counts as main under --preserve-symlinks-main", () => {
  const { link } = symlinkedCli();
  const r = spawnSync(process.execPath, ["--preserve-symlinks-main", link], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "ran", r.stderr);
});
