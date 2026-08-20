// Shared helpers for the structural workflow tests. This repo carries no YAML-parsing dependency
// (node --test only), so these read .github/workflows/*.yml as raw text and assert against it with
// small regex-based helpers rather than a parser. They do not run the workflows; GitHub Actions
// syntax validity is not proven by anything that imports this.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();

/** Reads a repo-relative path as text. */
export const read = (p) => readFileSync(join(root, p), "utf8");

// Splits the `jobs:` section into { jobId: bodyLines[] }, one entry per top-level (2-space
// indented) job key. Relies on this repo's own workflows being written with plain 2-space
// YAML indentation throughout (true of every workflow under .github/workflows/ today).
export function parseJobs(yaml) {
  const bodyStart = yaml.indexOf("\njobs:\n");
  assert.ok(bodyStart !== -1, "no top-level `jobs:` key found");
  const lines = yaml.slice(bodyStart + 1).split("\n");
  const jobs = {};
  let current = null;
  for (const line of lines.slice(1)) {
    const jobHeader = line.match(/^ {2}([a-z][\w-]*):\s*$/);
    if (jobHeader) {
      current = jobHeader[1];
      jobs[current] = [];
      continue;
    }
    if (current === null) continue;
    if (line.length && !/^\s/.test(line)) break; // dedented past the jobs: block entirely
    jobs[current].push(line);
  }
  return jobs;
}
