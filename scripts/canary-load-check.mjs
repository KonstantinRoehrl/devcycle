#!/usr/bin/env node
// The canary's real load check: `claude plugin list --json` exits 0 even when a plugin failed to
// load, so only the listed entry's `errors` tells (docs/platform-notes.md § (m)).
import { readFileSync } from "node:fs";
import { isMain } from "./is-main.mjs";

const textOf = (error) => (typeof error === "string" ? error : error?.message ?? JSON.stringify(error));

export function loadProblems(list) {
  if (!Array.isArray(list)) return ["the plugin list is not a list"];
  const entry = list.find((plugin) => typeof plugin?.id === "string" && plugin.id.split("@")[0] === "devcycle");
  if (!entry) return ["devcycle is not installed"];
  const problems = entry.enabled === true ? [] : ["devcycle is disabled"];
  return [...problems, ...(entry.errors ?? []).map((error) => `devcycle failed to load: ${textOf(error)}`)];
}

function main([path]) {
  let problems;
  try {
    problems = loadProblems(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    problems = [`cannot read the plugin list: ${err.message}`];
  }
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
