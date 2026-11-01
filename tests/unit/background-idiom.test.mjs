// The rule's prescription runs here under every shell present, so it cannot rot, and every copy of it
// is pinned to the one references/evidence.md owns.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { BOUNDED_FORM } from "../../scripts/leftover-processes.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const FORM = read("references/evidence.md").match(/^`(set --; .*)`$/m)?.[1] ?? "";
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("evidence.md owns the form, and each copy matches it byte for byte", () => {
  assert.match(FORM, /^set --; work & /);
  assert.equal(BOUNDED_FORM, FORM);
  assert.ok(read("hooks/block-destructive-git.mjs").includes(FORM));
});

for (const shell of ["zsh", "bash", "dash", "sh"]) {
  const missing = spawnSync(shell, ["-c", "exit 0"]).status !== 0;
  test(`the form leaves two helpers dead and exits 0 under ${shell}`, { skip: missing && `${shell} is not installed` }, async () => {
    const [, setup, helper, trap] = FORM.match(/^(set --; )(work & set -- "\$@" \$!; )(trap .*)$/);
    const script = `${setup}${helper.replace("work", "sleep 20").repeat(2)}${trap}; echo "$@"`;
    const r = spawnSync(shell, ["-c", script], { encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    const pids = r.stdout.trim().split(/\s+/).map(Number);
    assert.equal(pids.length, 2, r.stdout);
    for (let tries = 0; tries < 40 && pids.some(alive); tries += 1) await sleep(50);
    assert.deepEqual(pids.filter(alive), []);
  });
}

test("the evidence section names each failing cleanup", () => {
  const section = read("references/evidence.md").split("## Background processes")[1]?.split("\n## ")[0] ?? "";
  for (const failing of ["$(jobs -p)", "kill $pids", "array", "kill 0", "last line", "timeout"]) assert.ok(section.includes(failing), failing);
});
