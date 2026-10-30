#!/usr/bin/env node
// Prints one `##` section of a plugin reference — the section-read citation form
// (references/README.md § Citation grammar). The path resolves against the plugin root, never the
// cwd: the command runs from the user's repo.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";
import { apostropheSlug, sections } from "./md-sections.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REFERENCE = /^references\/[A-Za-z0-9._-]+\.md$/;

export function readSection(file, wanted, root = PLUGIN_ROOT) {
  if (!REFERENCE.test(file)) throw new Error(`${file} is not a plugin reference path (references/<name>.md)`);
  const abs = join(root, file);
  if (!existsSync(abs)) throw new Error(`no such file ${file}`);
  const all = sections(readFileSync(abs, "utf8"));
  const hit = all.find((s) => s.slug === wanted) ?? all.find((s) => apostropheSlug(s.heading) === wanted);
  if (!hit) throw new Error(`no section "${wanted}" in ${file} — its sections: ${all.map((s) => s.slug).join(", ")}`);
  return hit.text;
}

if (isMain(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("read-section: usage: read-section.mjs references/<file>.md <section-slug>");
    process.exit(1);
  }
  try {
    process.stdout.write(readSection(args[0], args[1]));
  } catch (err) {
    console.error(`read-section: ${err.message}`);
    process.exit(1);
  }
}
