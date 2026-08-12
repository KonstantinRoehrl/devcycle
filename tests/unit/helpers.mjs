// Shared helpers for the deterministic workflow-script tests.
// Everything here is keyless: the `claude`/`codex` CLIs are stubbed with fake
// executables placed first on PATH — no model call ever happens.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const GIT_IDENT = ["-c", "user.name=devcycle-test", "-c", "user.email=test@devcycle.invalid"];
const VALIDATE_SCRIPT = fileURLToPath(new URL("../../scripts/validate.mjs", import.meta.url));

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

// Writes `text` to `dir/relPath`, creating parent directories as needed.
export function writeInto(dir, relPath, text) {
  const p = join(dir, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

// Throwaway plugin tree that `scripts/validate.mjs` accepts as-is: both
// manifests, one well-formed playbook, and a routing table whose single row
// matches the one fixture command. Each validator test starts from this green
// tree and breaks exactly one thing.
export const FIXTURE_PLAYBOOK_HEAD = "# Demoing things\n\nThe routing table lives in references/routing.md.\n";

export function makePluginFixture() {
  const dir = mkdtempSync(join(tmpdir(), "devcycle-test-plugin-"));
  writeInto(
    dir,
    ".claude-plugin/plugin.json",
    JSON.stringify(
      {
        name: "devcycle",
        version: "0.0.1",
        description: "Fixture plugin.",
        license: "MIT",
        dependencies: [],
        userConfig: {
          profile: { type: "string", title: "Pipeline profile", default: "standard", description: "Fixture knob." },
        },
      },
      null,
      2
    ) + "\n"
  );
  writeInto(
    dir,
    ".claude-plugin/marketplace.json",
    JSON.stringify(
      { name: "devcycle", owner: { name: "fixture" }, plugins: [{ name: "devcycle", source: "./" }] },
      null,
      2
    ) + "\n"
  );
  // The playbook consumes references/routing.md so the fixture satisfies check 11
  // (every reference needs a consumer); the real tree's consumer is a script.
  writeInto(dir, "playbooks/demoing-things.md", FIXTURE_PLAYBOOK_HEAD);
  writeInto(
    dir,
    "references/routing.md",
    "# Routing\n\n| intent | entry point | consequence | model-invocable |\n| --- | --- | --- | --- |\n| run the pipeline | `cycle` | confirm-first | yes |\n"
  );
  writeInto(dir, "commands/cycle.md", '---\ndescription: "Fixture command."\n---\n\n# /devcycle:cycle\n\n- stage: <scoping|planning|execution>\n');
  // Check 14 requires the vocabulary to exist; every fixture tree therefore ships a minimal
  // valid one, the same way it ships a routing table for check 11.
  writeInto(
    dir,
    "references/culprits.json",
    JSON.stringify(
      [{ slug: "fixture-pattern", kind: "friction", phase: ["execution"], desc: "Fixture entry.", since: "0.0.1" }],
      null,
      2
    ) + "\n"
  );
  return dir;
}

// Runs `scripts/validate.mjs` against a fixture tree, exactly as CI invokes it:
// a subprocess rooted at the tree via cwd.
export function runValidate(cwd) {
  return spawnSync(process.execPath, [VALIDATE_SCRIPT], { cwd, encoding: "utf8" });
}

// Runs a workflow script as a subprocess, exactly as a playbook would invoke it,
// with fake CLI dirs prepended to PATH.
export function runScript(scriptPath, jsonArgs, { cwd, binDirs = [] } = {}) {
  const PATH = [...binDirs, process.env.PATH].join(delimiter);
  return spawnSync(process.execPath, [scriptPath, JSON.stringify(jsonArgs)], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH },
  });
}
