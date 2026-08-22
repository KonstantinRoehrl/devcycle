#!/usr/bin/env node
// Deterministic form of references/delegation.md § Research dispatches step 1's graph-availability
// predicate. Kept as a module so the graph-vs-Explore branch is unit-testable, and exposed as a CLI
// so a caller such as /devcycle:maintain can branch graph-vs-Explore from a playbook `node …` call.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";

function norm(p) {
  try { return realpathSync(p); } catch { return p; }
}

// Available iff a graphify skill is listed for this session AND the TARGET repo (never this
// plugin's own repo) carries graphify-out/ and/or a root GRAPH_REPORT.md.
export function resolveGraphAvailability({ repoPath, skills = [], pluginRoot } = {}) {
  const hasSkill = (skills || []).some((s) => /(^|:)graphify$/.test(String(s)));
  if (!hasSkill) return { available: false, reason: "no-graph: graphify skill unavailable" };
  if (pluginRoot && norm(repoPath) === norm(pluginRoot))
    return { available: false, reason: "no-graph: plugin's own repo excluded" };
  const hasArtifacts =
    existsSync(join(repoPath, "graphify-out")) || existsSync(join(repoPath, "GRAPH_REPORT.md"));
  if (!hasArtifacts) return { available: false, reason: "no-graph: no graph artifacts" };
  return { available: true, reason: "graph: graphify artifacts present" };
}

// CLI: `graph-availability.mjs --repo <path> [--skills <csv>] [--plugin-root <path>]` prints the
// `{ available, reason }` verdict as JSON, so the playbook's own "run it" instruction is executable
// and golden-path sees a real script invocation rather than a module-only orphan.
function cliResolve(argv) {
  const { flags } = parseFlags(argv, {
    "--repo": "value",
    "--skills": "value",
    "--plugin-root": "value",
  });
  const repoPath = requireValue(flags, "--repo");
  if (repoPath === undefined) throw new Error("--repo requires a path argument");
  const rawSkills = requireValue(flags, "--skills", "a comma-separated list");
  const skills = rawSkills === undefined ? [] : rawSkills.split(",").map((s) => s.trim()).filter(Boolean);
  const pluginRoot = requireValue(flags, "--plugin-root");
  return resolveGraphAvailability({ repoPath, skills, pluginRoot });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(cliResolve(process.argv.slice(2))));
  } catch (e) {
    console.error(`graph-availability: ${e.message}`);
    process.exit(1);
  }
}
