import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";

const TASK_SCRIPTS = ["task-intake", "task-commit", "task-verdict", "task-dispatch", "wave-setup", "ledger-slot", "on-device-routing"];
const scriptPath = (name) => new URL(`../../scripts/${name}.mjs`, import.meta.url).pathname;
const run = (name, args, cwd) => spawnSync(process.execPath, [scriptPath(name), ...args], { cwd, encoding: "utf8", input: "" });

function scratch(t) {
  const dir = makeTempDir("task-script-help-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const name of TASK_SCRIPTS)
  test(`${name} --help answers its usage object and exits 0`, (t) => {
    const r = run(name, ["--help"], scratch(t));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.action, "usage");
    assert.ok(out.required.length + out.optional.length > 0);
    assert.ok([...out.required, ...out.optional].every((flag) => flag.startsWith("--")));
  });

test("task-intake missing --agent-type, --model and --model-source names all three in one error", (t) => {
  const r = run("task-intake", ["--run", "0123456789abcdef", "--task", "1", "--report", "r.md", "--status", "complete"], scratch(t));
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).error, /--agent-type, --model, --model-source are required/);
});

for (const name of ["capture-evidence", "dispatch-health"])
  test(`${name} --help prints its usage line and exits 0`, (t) => {
    const r = run(name, ["--help"], scratch(t));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^usage: ${name}\\.mjs `));
  });
