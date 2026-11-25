#!/usr/bin/env node
// The one reader of .github/claude-code/package.json, the Claude Code versions CI tests devcycle
// against: the floor, and the current version Dependabot and the canary bump. The floor is a custom
// field Dependabot never reads, so it moves only with a docs/decisions/README.md entry.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEMVER_RE, cmpSemver } from "./semver.mjs";
import { isMain } from "./is-main.mjs";

export const OWNER_FILE = ".github/claude-code/package.json";
export const PACKAGE = "@anthropic-ai/claude-code";

export function parseVersions(text, source = OWNER_FILE) {
  let owner;
  try {
    owner = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} is not valid JSON: ${error.message}`);
  }
  const floor = owner?.claudeCodeFloor;
  if (typeof floor !== "string" || !SEMVER_RE.test(floor)) {
    throw new Error(`${source}: claudeCodeFloor must be an exact major.minor.patch version`);
  }
  const current = owner?.devDependencies?.[PACKAGE];
  if (typeof current !== "string" || !SEMVER_RE.test(current)) {
    throw new Error(`${source}: devDependencies["${PACKAGE}"] must be an exact major.minor.patch version, not a range`);
  }
  if (cmpSemver(current, floor) < 0) {
    throw new Error(`${source}: the current version ${current} is below the floor ${floor}`);
  }
  return { floor, current };
}

export function readVersions(root = ".") {
  const path = join(root, OWNER_FILE);
  return parseVersions(readFileSync(path, "utf8"), path);
}

export function matrix({ floor, current }) {
  return floor === current ? [floor] : [floor, current];
}

// A regex over the text, not a JSON round trip, so the file's formatting survives for a one-line diff.
export function bumpCurrent(text, version) {
  if (!SEMVER_RE.test(version)) throw new Error(`${PACKAGE} must be bumped to an exact major.minor.patch version, not "${version}"`);
  const pin = new RegExp(`("${PACKAGE}"\\s*:\\s*")[^"]*(")`);
  if (!pin.test(text)) throw new Error(`devDependencies["${PACKAGE}"] not found in the owner text`);
  return text.replace(pin, `$1${version}$2`);
}

function main([command]) {
  if (command === "floor") return console.log(readVersions().floor);
  if (command === "current") return console.log(readVersions().current);
  if (command === "matrix") return console.log(JSON.stringify(matrix(readVersions())));
  console.error("claude-code-versions: usage: claude-code-versions.mjs floor | current | matrix");
  process.exit(2);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
