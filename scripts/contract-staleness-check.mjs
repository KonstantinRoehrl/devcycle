#!/usr/bin/env node
// #238: a cached (installed) plugin's evidence-contract version can predate the target repo's —
// e.g. after this repo's own references/evidence.md gained a versioned contract change but the
// operator's installed plugin copy is still the pre-contract build. Advisory only: it never
// blocks anything, it only tells the operator to reinstall. Every comparison outcome exits 0;
// only a usage error (a required flag missing its value) exits 1.
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";

const VERSION_RE = /<!--\s*evidence-contract-version:\s*(\d+)\s*-->/;

function norm(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Reads `<root>/references/evidence.md` and returns its `evidence-contract-version` marker as
// an integer, or `null` when the file or the marker is missing.
export function readVersion(root) {
  let text;
  try {
    text = readFileSync(join(root, "references", "evidence.md"), "utf8");
  } catch {
    return null;
  }
  const m = text.match(VERSION_RE);
  return m ? Number(m[1]) : null;
}

// Compares the cached plugin's contract version against the target repo's. Every branch is
// advisory — the caller decides nothing from `kind` except which line to print.
export function compareContractVersions({ pluginRoot, repoRoot }) {
  if (norm(pluginRoot) === norm(repoRoot)) {
    // Same tree on both sides (e.g. running the check against devcycle's own repo): there is
    // nothing to compare, so this short-circuits before either version is even read.
    return { kind: "same-root", message: "contract-staleness: ok (nothing to compare)" };
  }
  const pluginVersion = readVersion(pluginRoot);
  const repoVersion = readVersion(repoRoot);
  if (pluginVersion === null || repoVersion === null) {
    const which = pluginVersion === null ? "plugin" : "repo";
    return {
      kind: "unknown",
      message: `contract-staleness: unknown — ${which} evidence.md carries no version marker`,
    };
  }
  if (pluginVersion < repoVersion) {
    return {
      kind: "stale",
      message: `contract-staleness: stale — cached plugin contract v${pluginVersion} < repo v${repoVersion}; reinstall the plugin`,
    };
  }
  return { kind: "ok", message: `contract-staleness: ok (version ${repoVersion})` };
}

function main(argv) {
  const { flags } = parseFlags(argv, {
    "--plugin-root": "value",
    "--repo-root": "value",
  });
  const pluginRoot = requireValue(flags, "--plugin-root");
  if (pluginRoot === undefined) throw new Error("--plugin-root requires a path argument");
  const repoRoot = requireValue(flags, "--repo-root");
  if (repoRoot === undefined) throw new Error("--repo-root requires a path argument");
  return compareContractVersions({ pluginRoot, repoRoot });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { message } = main(process.argv.slice(2));
    console.log(message);
    process.exit(0);
  } catch (e) {
    console.error(`contract-staleness-check: ${e.message}`);
    process.exit(1);
  }
}
