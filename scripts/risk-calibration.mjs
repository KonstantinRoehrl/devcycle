#!/usr/bin/env node
// Local calibration for the built-in risk signals (scripts/risk-signals.mjs): how often
// reviewDepth=auto would ask on a repo's recent squash-merged branches, one first-parent commit
// each. Built-in signals only, never a repo's .claude/devcycle-risk.json, so the bar measures the
// defaults. --write records the result in tests/fixtures/risk-calibration.json, which
// tests/unit/risk-calibration.test.mjs holds to the ceiling and to the current patterns' hash.
// A label shaped private-<n> keeps only shas and signal ids: the fixture is committed to a public repo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./atomic-write.mjs";
import { parseFlags } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { matchSignals, rangeChanges } from "./review-depth.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "tests/fixtures/risk-calibration.json");
const BAR = 0.25;
const CEILING = 0.3;
const PRIVATE = /^private-\d+$/;

function gitLines(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${(r.stderr ?? "").trim()}`);
  return r.stdout.split("\n").filter(Boolean);
}

export function calibrateRepo({ label, ref, path, limit }) {
  const commits = gitLines(path, ["log", "--first-parent", "--format=%H%x09%P%x09%s", `-n${limit}`, ref])
    .map((line) => line.split("\t"))
    .filter(([, parents]) => parents);
  const branches = commits.map(([sha, parents, subject]) => {
    const signals = matchSignals(rangeChanges({ base: parents.split(" ")[0], branch: sha, cwd: path })).matched.map((h) => h.id);
    return PRIVATE.test(label) ? { sha: sha.slice(0, 7), signals } : { sha: sha.slice(0, 7), subject, signals };
  });
  const asked = branches.filter((b) => b.signals.length).length;
  return { label, ref, asked, total: branches.length, askRate: Math.round((asked / branches.length) * 1000) / 1000, branches };
}

function main(argv) {
  const { flags } = parseFlags(argv, { "--repo": "repeat", "--limit": "value", "--write": "none" }, { requireValues: "nonEmpty" });
  const limit = Number(flags["--limit"] ?? 60);
  const repos = (flags["--repo"] ?? []).map((spec) => {
    const [label, ref, ...rest] = spec.split(",");
    if (!label || !ref || !rest.length) throw new Error(`--repo takes <label>,<ref>,<path>, got ${JSON.stringify(spec)}`);
    return calibrateRepo({ label, ref, path: rest.join(","), limit });
  });
  for (const r of repos) console.log(`${r.label}\t${r.ref}\tasked ${r.asked} of ${r.total} (${r.askRate.toFixed(3)})`);
  if (flags["--write"]) {
    const signalsSha256 = createHash("sha256").update(readFileSync(join(ROOT, "scripts/risk-signals.mjs"))).digest("hex");
    atomicWrite(FIXTURE, JSON.stringify({ signalsSha256, bar: BAR, ceiling: CEILING, limit, repos }, null, 2) + "\n");
  }
}

if (isMain(import.meta.url, process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`risk-calibration: ${e.message}`);
    process.exitCode = 1;
  }
}
