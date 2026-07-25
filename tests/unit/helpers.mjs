// Shared helpers for the deterministic workflow-script tests.
// Everything here is keyless: the `claude`/`codex` CLIs are stubbed with fake
// executables placed first on PATH — no model call ever happens.
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const GIT_IDENT = ["-c", "user.name=devcycle-test", "-c", "user.email=test@devcycle.invalid"];

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

// Throwaway git repo with one empty root commit on main.
export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "devcycle-test-repo-"));
  sh("git", ["init", "-q", "-b", "main"], { cwd: dir });
  sh("git", [...GIT_IDENT, "commit", "--allow-empty", "-qm", "init"], { cwd: dir });
  return dir;
}

export function commitAll(dir, msg) {
  sh("git", ["add", "-A"], { cwd: dir });
  sh("git", [...GIT_IDENT, "commit", "-qm", msg], { cwd: dir });
}

// Writes an executable named `name` (e.g. "claude") into a fresh bin dir and
// returns that dir, to be prepended to PATH. `body` is the Node program text.
export function makeFakeBin(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "devcycle-test-bin-"));
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}`);
  chmodSync(p, 0o755);
  return dir;
}

// Runs a workflow script as a subprocess, exactly as a skill would invoke it,
// with fake CLI dirs prepended to PATH.
export function runScript(scriptPath, jsonArgs, { cwd, binDirs = [] } = {}) {
  const PATH = [...binDirs, process.env.PATH].join(delimiter);
  return spawnSync(process.execPath, [scriptPath, JSON.stringify(jsonArgs)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
}
