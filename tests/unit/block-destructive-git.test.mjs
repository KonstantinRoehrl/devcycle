// #165/#235: a guarded dispatch must not run destructive git against the shared checkout, and the
// main thread must not run `git stash` while a devcycle cycle is active. Structural backstop
// mirroring block-main-thread-browser.test.mjs: spawn the hook with a crafted
// PreToolUse stdin and assert the deny/allow decision. deny = a permissionDecision:"deny" object on
// stdout; allow = empty stdout (defer to normal permission flow). Both exit 0 (a non-zero exit with
// empty stdout is the fail-open a PreToolUse harness reads as "no decision").
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "block-destructive-git.mjs");

// Spawns the hook with a crafted PreToolUse stdin; returns the decision and the deny reason.
function decideRaw(input) {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(r.status, 0, `hook exited ${r.status}, stderr: ${r.stderr}`);
  if (r.stdout.trim() === "") return { decision: "allow", reason: "" };
  const out = JSON.parse(r.stdout).hookSpecificOutput ?? {};
  return { decision: out.permissionDecision === "deny" ? "deny" : "allow", reason: out.permissionDecisionReason ?? "" };
}

// Returns "deny" or "allow" for a given agent_type + Bash command.
const decide = (agentType, command) => decideRaw({ agent_type: agentType, tool_input: { command } }).decision;

// Main-thread cases pass a cwd; the hook walks upward from it for .devcycle/state.md exactly as
// hooks/workload-sensor.mjs does. tmpdir() must sit outside the repo (the suite runs under an
// out-of-repo TMPDIR), or the walk would find the repo's own state file.
function cycleDir(stateBody) {
  const dir = mkdtempSync(join(tmpdir(), "devcycle-git-guard-"));
  if (stateBody !== null) {
    mkdirSync(join(dir, ".devcycle"));
    writeFileSync(join(dir, ".devcycle", "state.md"), stateBody);
  }
  return dir;
}
const stateAt = (stage) => `# devcycle state\n- stage: ${stage}\n- root: /nowhere\n`;
const decideMain = (cwd, command) => decideRaw({ cwd, tool_input: { command } }).decision;

const REVIEWER = "devcycle:task-reviewer";
const IMPLEMENTER = "devcycle:implementer";

test("reviewer + destructive git is denied", () => {
  for (const cmd of [
    "git checkout -- x",
    "git restore x",
    "git reset --hard",
    "git clean -fd",
    "git stash",
    "git rm x",
    "git commit -m y",
    "git push",
    "git checkout main",
    "git add newfile",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for: ${cmd}`);
});

test("reviewer + read-only git is allowed", () => {
  for (const cmd of [
    "git diff",
    "git status",
    "git log -p",
    "git show HEAD",
    "git blame x",
    "git rev-parse HEAD",
    "git ls-files",
    "git -C sub diff",
    "git diff -U10 HEAD -- a b",
    "git config --get user.name",
    "git remote -v",
    "git reflog show",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for: ${cmd}`);
});

test("reviewer + git add --intent-to-add is the one sanctioned write", () => {
  assert.equal(decide(REVIEWER, "git add -N newfile"), "allow");
  assert.equal(decide(REVIEWER, "git add --intent-to-add newfile"), "allow");
});

test("reviewer + a chained mutation anywhere in the chain is denied", () => {
  assert.equal(decide(REVIEWER, "git diff && git checkout -- x"), "deny");
  assert.equal(decide(REVIEWER, "git status; git reset --hard"), "deny");
});

test("reviewer + git hidden behind a shell wrapper or substitution is denied", () => {
  for (const cmd of [
    "sh -c 'git checkout -- x'",
    "bash -c \"git reset --hard\"",
    "eval git clean -fd",
    "xargs git checkout",
    "echo `git stash`",
    "x=$(git reset --hard)",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for wrapped: ${cmd}`);
});

// Round-1 regression: four alternate spellings of a destructive git command the committed hook
// wrongly ALLOWED for a guarded reviewer origin. Deny-on-ambiguity requires every spelling that
// reduces to the `git` binary to be classified, not just the literal head token `git`.
test("reviewer + path-qualified destructive git is denied", () => {
  for (const cmd of ["/usr/bin/git reset --hard", "./git reset --hard", "/opt/homebrew/bin/git clean -fd"])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for path-qualified git: ${cmd}`);
});

test("reviewer + quoted top-level git is denied", () => {
  assert.equal(decide(REVIEWER, '"git" checkout -- x'), "deny");
  assert.equal(decide(REVIEWER, "'git' reset --hard"), "deny");
});

test("reviewer + backslash-escaped git is denied", () => {
  assert.equal(decide(REVIEWER, "\\git reset --hard"), "deny");
});

test("reviewer + destructive git after a bare & background operator is denied", () => {
  assert.equal(decide(REVIEWER, "true & git reset --hard"), "deny");
});

test("reviewer + non-git commands are allowed (tests, greps)", () => {
  for (const cmd of ["npm test", "node --test", "rg pattern src", "cat file"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for non-git: ${cmd}`);
});

// Round-1 blocking fix: three confirmed bypasses where a destructive git slipped classification.

// (1) Shell grouping constructs — a `{ … }` group or a `( … )` subshell must not hide the git.
test("reviewer + destructive git inside a grouping construct is denied", () => {
  for (const cmd of [
    "{ git reset --hard; }",
    "{ git checkout -- x; }",
    "(git reset --hard)",
    "( git reset --hard )",
    "(git clean -fd)",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for grouped git: ${cmd}`);
});

// (2) Exec/privilege/scheduling wrappers — a wrapper that runs a destructive git must be denied.
test("reviewer + destructive git behind an exec/privilege/scheduling wrapper is denied", () => {
  for (const cmd of [
    "setsid git reset --hard",
    "taskset 1 git checkout -- x",
    "sudo git reset --hard",
    "doas git reset --hard",
    "ionice git reset --hard",
    "chrt 1 git reset --hard",
    "stdbuf -o0 git clean -fd",
    "unshare git reset --hard",
    "unbuffer git reset --hard",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for wrapped git: ${cmd}`);
});

// Round-2 blocking fix: command-LAUNCHERS not in WRAPPERS let a destructive git through — the
// git-behind-wrapper check only fires inside `if (WRAPPERS.has(head))`, so a head-position launcher
// missing from the set falls to `if (head !== "git") continue;` and the git is executed unguarded.
// `exec` is the priority case: an always-available shell builtin that replaces the shell with the
// git it launches.
test("reviewer + destructive git behind a command-launcher (exec/caffeinate/flock/…) is denied", () => {
  for (const cmd of [
    "exec git reset --hard",
    "caffeinate git reset --hard",
    "flock /tmp/l git reset --hard",
    "strace git reset --hard",
    "firejail git checkout -- x",
    "chroot /jail git clean -fd",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for launcher-wrapped git: ${cmd}`);
});

// Regression: a launcher (or any command) taking the literal string "git" as a DATA argument stays
// allowed — reviewers grep for "git" constantly, so a blanket "deny any segment containing a git
// token" is wrong. grep/echo/cat/rg/find take git as data, never execute it.
test("reviewer + a command taking \"git\" as a data argument is allowed", () => {
  for (const cmd of [
    "grep -rn git playbooks/",
    "rg git references/",
    "echo git",
    "cat somefile",
    "git add -N f",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for git-as-data: ${cmd}`);
});

// (3) A read-only subcommand carrying git's write-capable `--output` flag overwrites a file.
test("reviewer + a read-only git carrying --output is denied", () => {
  for (const cmd of [
    "git diff --output=src/main.js HEAD",
    "git diff --output out.txt HEAD",
    "git show --output=x HEAD",
    "git log --output=x -p",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for --output git: ${cmd}`);
});

// Regression: a wrapper with NO git token stays allowed (reviewers genuinely need these).
test("reviewer + a wrapper running a non-git command is allowed", () => {
  for (const cmd of ["timeout 30 npm test", "xargs grep foo", "nice node --test", "setsid npm test"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for non-git wrapper: ${cmd}`);
});

// Regression: `--` pathspec is not the `--output` write flag.
test("reviewer + git diff with a double-dash pathspec stays allowed", () => {
  assert.equal(decide(REVIEWER, "git diff -- path"), "allow");
  assert.equal(decide(REVIEWER, "git diff -- src/main.js"), "allow");
});

// Audit 2026-09-05 H1: a shell reserved word at a segment's head is neither `git` nor a wrapper, so
// the segment was skipped and the git behind it never classified; `<(`/`>(` were absent from the
// substitution test. Every spelling below returned allow before the fix.
test("reviewer + destructive git behind a shell reserved word is denied", () => {
  for (const cmd of [
    'for f in a b; do git checkout -- "$f"; done',
    "! git reset --hard",
    "if git reset --hard; then :; fi",
    "while true; do git reset --hard; break; done",
    "until false; do git clean -fd; done",
    'for f in a b\ndo git checkout -- "$f"\ndone',
    "select x in a; do git stash drop; done",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for reserved-word git: ${cmd}`);
});

test("reviewer + git inside a process substitution is denied regardless of subcommand", () => {
  for (const cmd of ["cat <(git stash drop)", "echo x | tee >(git checkout -- x)", "cat <(git log -1)"])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for process substitution: ${cmd}`);
});

// Reserved words around NON-git commands must not trip the guard: reviewers write these loops.
test("reviewer + reserved words around non-git commands stay allowed", () => {
  for (const cmd of [
    'for f in *.js; do node --check "$f"; done',
    "if grep -q x y; then echo ok; fi",
    "while read l; do echo $l; done",
    "! test -f x",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for reserved-word non-git: ${cmd}`);
});

test("all six guarded spellings are guarded", () => {
  for (const origin of ["task-reviewer", "devcycle:task-reviewer", "red-team-reviewer", "devcycle:red-team-reviewer", "implementer", "devcycle:implementer"])
    assert.equal(decide(origin, "git checkout -- x"), "deny", `expected deny for origin: ${origin}`);
});

// #235: an implementer shares the checkout with its siblings, and agents/implementer.md already
// forbids every git write except `git add -N` — the same allowlist applies, one classifier.
test("implementer + destructive git is denied, read-only git and git add -N are allowed", () => {
  for (const cmd of ["git stash", "git checkout -- x", "git restore x", "git reset --hard", "git commit -m y", "git add newfile", "sh -c 'git stash'"])
    assert.equal(decide(IMPLEMENTER, cmd), "deny", `expected deny for implementer: ${cmd}`);
  for (const cmd of ["git diff", "git status", "git log -3", "git add -N newfile", "npm test"])
    assert.equal(decide(IMPLEMENTER, cmd), "allow", `expected allow for implementer: ${cmd}`);
});

test("an unguarded dispatch origin is never guarded", () => {
  for (const origin of ["devcycle:on-device-driver", "on-device-driver", "general-purpose", "Explore"])
    assert.equal(decide(origin, "git checkout -- x"), "allow", `expected allow for origin: ${origin}`);
});

test("main thread (absent agent_type) is unguarded apart from git stash", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["git checkout -- x", "git commit -m x", "git checkout dev", "git merge --squash topic", "git reset --hard", "git add -A", "git push"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow on the main thread: ${cmd}`);
});

test("main thread + git stash is denied while a cycle is active, through every spelling the parser sees", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["git stash", "git stash push -m wip", "git stash pop", "git stash drop", "git -C . stash", "sh -c 'git stash'", "for i in 1; do git stash; done", "x=$(git stash)",
    // Round-1 blocking fix: the whitespace split leaves a grouping char or a quote glued to the
    // subcommand, so the raw-token comparison read `stash)` / `"stash"` as "not stash" and allowed
    // the one command this ban exists to stop. `(cd sub && git stash)` is an ordinary spelling.
    "(cd sub && git stash)", "(git stash)", "( git stash )", "{ git stash; }", 'git "stash"', "git 'stash'", "git stash)"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for main-thread stash: ${cmd}`);
});

test("main thread + git stash list/show are allowed in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decideMain(cwd, "git stash list"), "allow");
  assert.equal(decideMain(cwd, "git stash show -p"), "allow");
  // Normalizing the subcommand must not turn the grouped spellings into a blanket stash deny.
  assert.equal(decideMain(cwd, "(git stash list)"), "allow");
  assert.equal(decideMain(cwd, "(cd sub && git stash show -p)"), "allow");
});

test("main thread + git stash is allowed when the cycle is done, absent, or the state file is malformed", () => {
  assert.equal(decideMain(cycleDir(stateAt("done")), "git stash"), "allow");
  assert.equal(decideMain(cycleDir(null), "git stash"), "allow");
  assert.equal(decideMain(cycleDir("not a state file\n"), "git stash"), "allow");
});

test("the deny reason names the origin class and the active stage", () => {
  const dispatch = decideRaw({ agent_type: IMPLEMENTER, tool_input: { command: "git reset --hard" } });
  assert.match(dispatch.reason, /^devcycle: reviewer\/implementer dispatch \(devcycle:implementer\) may not /);
  const main = decideRaw({ cwd: cycleDir(stateAt("execution")), tool_input: { command: "git stash" } });
  assert.match(main.reason, /^devcycle: main thread may not run git stash while a devcycle cycle is active \(stage: execution\)/);
});

test("malformed / non-object stdin fails safe to allow, never throws", () => {
  for (const raw of ["", "not json", "null", "[1,2]", "42"]) {
    const r = spawnSync("node", [HOOK], { input: raw, encoding: "utf8" });
    assert.equal(r.status, 0, `exited ${r.status} on stdin ${JSON.stringify(raw)}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "", `denied on unparseable stdin ${JSON.stringify(raw)}`);
  }
});

// Branch review round 1 (findings A1–A5): ordinary shell spellings that still reduced to a real
// `git` invocation but reached `allow()` — for a guarded origin AND past the main-thread
// cycle-scoped stash ban. The spec's § Parser robustness rule is that a missed destructive command
// is not acceptable, so each is a live fail-open rather than an accepted bound. Every class is
// asserted on BOTH arms from one table, because spec §2 pins that only the final classification
// differs by origin: a fix that closes a spelling for guarded origins alone is not a fix.
// Each row is [ambiguity class, guarded-origin command, main-thread command].
const AMBIGUITY_CLASSES = [
  ["reserved word: case/esac", "case x in *) git reset --hard;; esac", "case x in *) git stash;; esac"],
  ["case pattern label on a multi-line arm", "case x in\n  1) git reset --hard ;;\nesac", "case x in\n  1) git stash ;;\nesac"],
  ["case pattern label in its parenthesized form", "case x in\n  (*) git clean -fd ;;\nesac", "case x in\n  (*) git stash pop ;;\nesac"],
  ["reserved word: coproc", "coproc git reset --hard", "coproc git stash"],
  ["function body", "f() { git reset --hard; }; f", "f() { git stash; }; f"],
  ["function body with a space before the parens", "f () { git reset --hard; }; f", "f () { git stash; }; f"],
  ["reserved word: function keyword", "function f { git reset --hard; }; f", "function f { git stash; }; f"],
  ["leading redirection with a glued target", ">/dev/null git reset --hard", ">/dev/null git stash"],
  ["leading redirection with a separated target", "> /dev/null git reset --hard", "> /dev/null git stash"],
  ["ANSI-C quoting behind a shell wrapper", "bash -c $'git reset --hard'", "sh -c $'git stash'"],
  ["ANSI-C quoted subcommand", "git $'reset' --hard", "git $'stash'"],
  ["separated global option: --git-dir", "git --git-dir .git reset --hard", "git --git-dir .git stash"],
  ["separated global option: --work-tree", "git --work-tree . clean -fd", "git --work-tree . stash"],
  ["separated global option: --namespace", "git --namespace n reset --hard", "git --namespace n stash"],
  ["line continuation", "git \\\n reset --hard", "git \\\nstash pop"],
];

test("guarded origin + every named ambiguity class hiding a destructive git is denied", () => {
  for (const [ambiguityClass, cmd] of AMBIGUITY_CLASSES)
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for ${ambiguityClass}: ${JSON.stringify(cmd)}`);
});

test("main thread + every named ambiguity class hiding git stash is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const [ambiguityClass, , cmd] of AMBIGUITY_CLASSES)
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for ${ambiguityClass}: ${JSON.stringify(cmd)}`);
});

// The widening must not become a blanket deny: the same reserved words and labels around a non-git
// command, and git's separated global options in front of a read-only subcommand, stay allowed.
test("guarded origin + the same reserved words and labels around non-git commands stay allowed", () => {
  for (const cmd of [
    "case $x in *) echo ok;; esac",
    "case $x in\n  1) echo ok ;;\nesac",
    "f() { echo ok; }; f",
    "function f { echo ok; }; f",
    ">/dev/null echo ok",
    "coproc node --test",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for non-git: ${cmd}`);
});

// A3's false-deny half: pairing a value only with -C/-c left the subcommand index on the VALUE, so
// a read-only git carrying a separated global option was wrongly DENIED to a guarded origin.
test("guarded origin + read-only git behind a separated global option is allowed", () => {
  for (const cmd of [
    "git --git-dir /r/.git log",
    "git --work-tree . status",
    "git --namespace n log -1",
    "git --git-dir /r/.git diff -- path",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for separated global option: ${cmd}`);
});

test("main thread + git stash list/show stay allowed through the newly parsed spellings", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "git stash list",
    "git stash show -p",
    "case x in *) git stash list;; esac",
    "f() { git stash show -p; }; f",
    "git --git-dir /r/.git stash list",
  ])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow for main-thread read-only stash: ${cmd}`);
});

// Fold-in F1: `symbolic-ref` writes — `git symbolic-ref HEAD refs/heads/other` repoints HEAD in the
// shared checkout — so it does not belong in the unconditional read-only allowlist. Deny-on-
// ambiguity takes the whole subcommand rather than classifying its arguments; `rev-parse` covers
// the read case.
test("guarded origin + git symbolic-ref is denied (it writes HEAD)", () => {
  assert.equal(decide(REVIEWER, "git symbolic-ref HEAD refs/heads/other"), "deny");
  assert.equal(decide(IMPLEMENTER, "git symbolic-ref HEAD refs/heads/other"), "deny");
  assert.equal(decide(REVIEWER, "git symbolic-ref --short HEAD"), "deny");
  assert.equal(decide(REVIEWER, "git rev-parse --abbrev-ref HEAD"), "allow"); // the read path stays open
});
