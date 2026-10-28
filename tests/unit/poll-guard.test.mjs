// hooks/lib/poll-guard.mjs: a guarded devcycle dispatch may not wait on evidence in an until/while loop
// that sleeps — the #385 hang — while the main thread and every other agent are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isPollLoop } from "../../hooks/lib/poll-guard.mjs";

const HOOK = new URL("../../hooks/block-destructive-git.mjs", import.meta.url).pathname;
const POLL = 'until grep -q "^# exit" .devcycle/evidence/5-after.txt; do sleep 5; done';
const LOOP_FORMS = [POLL, "while ! test -f x; do sleep 1; done", "while true\ndo\n  sleep 30\ndone"];

test("an until/while loop whose body sleeps is a poll; a bounded or sleepless loop is not", () => {
  for (const c of LOOP_FORMS) assert.equal(isPollLoop(c), true, c);
  for (const c of ["while read l; do echo $l; done < f", "for i in 1 2 3; do sleep 1; done", "sleep 5", "node --test tests/unit/a.test.mjs"])
    assert.equal(isPollLoop(c), false, c);
});

test("a sleep counts only inside its own loop's do…done body, including a nested one", () => {
  for (const c of [
    "while x; do for f in a b; do :; done; sleep 1; done",
    "until test -f y; do if true; then sleep 2; fi; done",
    "while true; do echo done; sleep 1; done",
    "out=$(while ! test -f z; do sleep 1; done)",
  ]) assert.equal(isPollLoop(c), true, c);
});

test("a sleepless loop followed by a later sleep, or loop words inside text, is not a poll", () => {
  for (const c of [
    "while read l; do echo $l; done < f; sleep 2; echo done",
    "while read l; do echo $l; done < f\nsleep 2; for x in a; do :; done",
    'git commit -m "wait a while, do not sleep; done"',
    "echo 'until ready; do sleep 1; done'",
    "cat > poll.sh <<'EOF'\nwhile true; do sleep 1; done\nEOF\nnode poll.sh",
    "cat <<-EOF > s.txt\n\twhile true; do sleep 1; done\n\tEOF",
    "while read l; do echo $l; done < f # then sleep 2 and done",
  ]) assert.equal(isPollLoop(c), false, c);
});

test("a sleep spelled through a path or a wrapper command is still a sleep", () => {
  for (const c of [
    "until [ -f x ]; do /bin/sleep 5; done",
    "until [ -f x ]; do /usr/bin/sleep 5; done",
    "until [ -f x ]; do command sleep 5; done",
    "until [ -f x ]; do env sleep 1; done",
    "until [ -f x ]; do env FOO=1 sleep 1; done",
    "until [ -f x ]; do nohup sleep 1; done",
    "while [ ! -f x ]; do timeout 5 sleep 5; done",
  ]) assert.equal(isPollLoop(c), true, c);
});

test("a loop hidden in bash -c, sh -c, zsh -c or eval is still a poll", () => {
  for (const c of [
    "bash -c 'until [ -f x ]; do sleep 1; done'",
    'sh -c "while true; do sleep 1; done"',
    "zsh -c 'until [ -f x ]; do sleep 1; done'",
    "bash -lc 'until [ -f x ]; do sleep 1; done'",
    "eval 'until [ -f x ]; do sleep 1; done'",
    `bash -c 'sh -c "until [ -f x ]; do sleep 1; done"'`,
    `bash -c '${"echo a; ".repeat(20_000)}until [ -f x ]; do sleep 1; done'`,
  ]) assert.equal(isPollLoop(c), true, c.slice(0, 80));
});

test("a loop whose condition runs sleep is a poll", () => {
  for (const c of ["while sleep 1; do :; done", "until ! sleep 1; do :; done"]) assert.equal(isPollLoop(c), true, c);
});

test("wrappers, shells and text around a sleep stay allowed unless a poll loop holds it", () => {
  for (const c of [
    "sleep 5",
    "timeout 10 sleep 1",
    "for i in 1 2 3; do sleep 1; done",
    "until [ -f x ]; do echo waiting; done",
    'echo "until x; do sleep 1; done"',
    "bash -c 'echo hi'",
    "bash -c 'sleep 5'",
    "ls",
    "",
  ]) assert.equal(isPollLoop(c), false, c);
});

function hook(agentType, command, options = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ agent_type: agentType, cwd: process.cwd(), tool_input: { command } }), encoding: "utf8", ...options });
  assert.equal(r.signal, null, "the hook must answer before the timeout kills it");
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test("the git guard denies a guarded dispatch's poll loop and names the bounded forms", () => {
  const out = hook("devcycle:implementer", POLL);
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /devcycle: reviewer\/implementer dispatch \(devcycle:implementer\) may not poll .*timeout: 600000.*completion notification/);
});

test("every guarded origin's poll loop is denied", () => {
  for (const origin of ["task-reviewer", "devcycle:task-reviewer", "red-team-reviewer", "devcycle:red-team-reviewer", "implementer", "spec-reviewer", "devcycle:spec-reviewer"])
    assert.equal(hook(origin, POLL)?.permissionDecision, "deny", origin);
});

test("the main thread and an unguarded agent may still loop", () => {
  for (const c of LOOP_FORMS) {
    assert.equal(hook("", c), null, c);
    assert.equal(hook("Explore", c), null, c);
  }
});

test("a 200 KB command full of loop keywords gets the hook's answer within seconds", () => {
  const command = "while a; do b; ".repeat(14_000);
  assert.ok(command.length >= 200_000);
  assert.equal(hook("devcycle:implementer", command, { timeout: 5_000 }), null);
});
