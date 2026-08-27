#!/usr/bin/env node
// One canonical "now", stamped from the system clock in the ISO-8601 UTC form the run-record
// journal, ledger, state file, and distilling checkpoint all already use: YYYY-MM-DDTHH:MM:SSZ,
// milliseconds stripped. Coordinator timestamp sites call `node scripts/stamp.mjs now` instead of
// narrating an estimated time (issue #103).
import { pathToFileURL } from "node:url";

export function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function main(argv) {
  const cmd = argv[2] ?? "now";
  if (cmd !== "now") {
    console.error(`stamp: unknown command "${cmd}" — usage: stamp now`);
    process.exit(1);
  }
  process.stdout.write(now() + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
