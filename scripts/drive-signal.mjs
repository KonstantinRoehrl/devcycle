#!/usr/bin/env node
// The only channel from a driven session to its driver (spec 4.B.3): a gate the session may not ask
// becomes .devcycle/drive-stop.json, which the driver reads when the session ends and turns into its
// exit 4 with this reason. Written atomically, so the driver never reads half a signal.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { isMain } from "./is-main.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { now } from "./stamp.mjs";
import { field } from "./md-field.mjs";
import { hashSession } from "./run-record.mjs";

const STOP_REASONS = ["needs-user", "knob-drift", "foreign-state", "resume-check", "branch", "depth-at-start", "sweep-fallback", "scope-change", "no-driver", "not-opted-in"];
const MAX_DETAIL = 500;
const USAGE = "drive-signal: usage: drive-signal.mjs <reason> --detail <text> [--state <path>]";

function main(argv) {
  let reason, detail, statePath;
  try {
    const { flags, positionals } = parseFlags(argv, { "--detail": "value", "--state": "value" }, { allowPositionals: true });
    detail = requireValue(flags, "--detail", "a one-line detail");
    statePath = requireValue(flags, "--state");
    if (positionals.length !== 1) throw new Error("exactly one <reason> is required");
    [reason] = positionals;
    if (!STOP_REASONS.includes(reason)) throw new Error(`unknown reason "${reason}" — one of ${STOP_REASONS.join(", ")}`);
    if (detail === undefined) throw new Error("--detail is required");
  } catch (err) {
    console.error(`drive-signal: ${err.message}`);
    console.error(USAGE);
    process.exit(2);
  }

  let devcycleDir;
  if (statePath) devcycleDir = dirname(resolve(statePath));
  else {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (top.status !== 0) {
      console.error("drive-signal: not inside a git repository, and no --state names the cycle");
      process.exit(3);
    }
    devcycleDir = join(top.stdout.trim(), ".devcycle");
  }
  let stage = null;
  try {
    stage = field(readFileSync(statePath ? resolve(statePath) : join(devcycleDir, "state.md"), "utf8"), "stage");
  } catch {
    // No readable state file: the stage stays unknown; the reason and detail still reach the driver.
  }
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  const signal = {
    reason,
    detail: detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL),
    stage,
    stamp: now(),
    sessionHash: sessionId ? hashSession(sessionId) : null,
  };
  const path = join(devcycleDir, "drive-stop.json");
  try {
    mkdirSync(devcycleDir, { recursive: true });
    atomicWrite(path, JSON.stringify(signal, null, 2) + "\n");
  } catch (err) {
    console.error(`drive-signal: cannot write ${path}: ${err.message}`);
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({ ok: true, action: "signal", reason, path }) + "\n");
}

if (isMain(import.meta.url, process.argv[1])) main(process.argv.slice(2));
