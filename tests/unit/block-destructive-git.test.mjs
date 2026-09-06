// #165/#235: a guarded dispatch must not run destructive git against the shared checkout, and the
// main thread must not run `git stash` while a devcycle cycle is active. Structural backstop
// mirroring block-main-thread-browser.test.mjs: spawn the hook with a crafted
// PreToolUse stdin and assert the deny/allow decision. deny = a permissionDecision:"deny" object on
// stdout; allow = empty stdout (defer to normal permission flow). Both exit 0 (a non-zero exit with
// empty stdout is the fail-open a PreToolUse harness reads as "no decision").
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// Nothing else ever deletes these, and this file makes one per call across two dozen call sites, so
// each is removed when the run ends — the convention tests/unit/mechanical-sweep.test.mjs documents.
const fixtures = [];
after(() => { for (const p of fixtures) rmSync(p, { recursive: true, force: true }); });
function cycleDir(stateBody) {
  const dir = mkdtempSync(join(tmpdir(), "devcycle-git-guard-"));
  fixtures.push(dir);
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
  // Branch review round 2: the same four classes in their GLUED spellings. The parser tokenized on
  // whitespace only, so a shell metacharacter written flush against the next word (`f(){`, `*)git`)
  // stayed part of the head token and hid the git from both round-1 rules; `2>&1` additionally lost
  // its `&` to the segment splitter's background-operator alternative. The function-head, case-label
  // and `2>&1` rows returned allow on at least one arm before the round-2 fix; the other three
  // redirection rows (`<`, `>>out`, `2>/dev/null`) already denied and are carried as regression
  // guards for the operator spellings around them (branch review round 4, test-integrity).
  ["function-definition head glued to its brace body", "f(){ git reset --hard; }; f", "f(){ git stash; }; f"],
  ["function-definition head glued to its subshell body", "f()( git reset --hard )", "f()( git stash )"],
  ["function-definition head that names the git binary", "git () { git reset --hard; }; git", "git () { git stash; }; git"],
  ["case pattern label glued to its command", "case x in *)git reset --hard;; esac", "case x in *)git stash;; esac"],
  ["case pattern label that spells the git binary", "case $x in git) git reset --hard;; esac", "case $x in git) git stash;; esac"],
  ["case pattern label that spells the git binary on a multi-line arm", "case $x in\n  git) git reset --hard ;;\nesac", "case $x in\n  git) git stash ;;\nesac"],
  ["leading redirection: stderr duplication (2>&1)", "2>&1 git reset --hard", "2>&1 git stash"],
  ["leading redirection: input with a separated target (<)", "< /dev/null git reset --hard", "< /dev/null git stash"],
  ["leading redirection: append with a glued target (>>)", ">>out git reset --hard", ">>out git stash"],
  ["leading redirection: numbered descriptor with a glued target (2>)", "2>/dev/null git reset --hard", "2>/dev/null git stash"],
  // Branch review round 4: the HALF-glued twins of the classes rounds 1-3 closed. Splitting on
  // whitespace alone gave every rule keyed to a token boundary a twin spelling, so `f() {` (round 1)
  // and `f(){` (round 2) were closed while `f (){` — head `f`, with `(){` behind it — stayed open,
  // and `2>& 1` stayed open after `2>&1` was closed. Each row below returned allow on BOTH arms
  // before the tokenizer rewrite; they are the reason the parser now canonicalizes before it
  // classifies rather than enumerating one more spelling.
  ["function-definition head with a space before its glued brace body", "f (){ git reset --hard; }; f", "f (){ git stash; }; f"],
  ["function-definition head with a space before its glued subshell body", "f ()( git reset --hard )", "f ()( git stash )"],
  ["function-definition head naming git, spaced parens and a glued body", "git (){ git reset --hard; }; git", "git (){ git stash; }; git"],
  ["leading redirection: descriptor duplication with a separated target (2>& 1)", "2>& 1 git reset --hard", "2>& 1 git stash"],
  ["leading redirection: duplication onto stderr with a separated target (>& 2)", ">& 2 git reset --hard", ">& 2 git stash"],
  // Branch review round 6 (F3): canonicalization stopped at the token's ENDS. normalizeHead
  // re-derived the head with a leading/trailing-run regex, so a quote or backslash written INSIDE a
  // word survived and the token stopped reducing to `git` — while bash runs `gi\t`, `"g"'it'` and
  // `g""it` as exactly `git`. Both halves of the first four rows returned allow before the
  // word-level canonicalization; the fifth is falsifiable on the main-thread half only (see below).
  ["escape inside the git binary name", "gi\\t reset --hard", "gi\\t stash"],
  ["quotes inside the git binary name", "\"g\"'it' reset --hard", "\"g\"'it' stash"],
  ["empty quote pair inside the git binary name", 'g""it reset --hard', 'g""it stash'],
  ["escape inside a wrapper's name", "s\\h -c 'git reset --hard'", "s\\h -c 'git stash'"],
  // The guarded half here already denied before the fix — the wrapper arm denies any git behind
  // `sh -c` whatever its subcommand, so only the main-thread half is falsifiable: mentionsStash read
  // `st""ash` as not-stash and let the one command that ban exists to stop through.
  ["empty quote pair inside a subcommand behind a wrapper", 'sh -c "git re""set --hard"', 'sh -c "git st""ash"'],
  // Branch review round 8 (F1): an ANSI-C quote (`$'…'`) written anywhere but the START of a word
  // defeated the head reduction. stripQuoting dropped the quote characters but left the `$` that
  // introduces the quote, and the head reduction stripped `$` only as a LEADING run — so `$'git'`
  // reduced to `git` while `g$'it'` stopped at `g$it`, and every spelling below returned allow on
  // BOTH arms (verified: the round-8 differential probe, 10784 rows). bash and zsh both print `git`
  // for each of these words, so each is a real, executed git.
  ["ANSI-C quote glued inside the git binary name", "g$'it' reset --hard", "g$'it' stash"],
  ["ANSI-C quote glued before the last character of the git binary name", "gi$'t' reset --hard", "gi$'t' stash"],
  ["ANSI-C quote concatenated onto a double-quoted git binary name", "\"g\"$'it' reset --hard", "\"g\"$'it' stash"],
  ["ANSI-C quote concatenated between both halves of the git binary name", "\"g\"$'i't reset --hard", "\"g\"$'i't stash"],
  ["empty ANSI-C quote pair inside the git binary name", "g$''it reset --hard", "g$''it stash"],
  ["ANSI-C quoted git binary name behind a shell wrapper", "sh -c \"g$'it' reset --hard\"", "sh -c \"g$'it' stash\""],
  ["ANSI-C quoted git binary name behind a reserved word", "for f in a; do g$'it' reset --hard; done", "for f in a; do g$'it' stash; done"],
  ["ANSI-C quoted git binary name behind a case pattern label", "case x in *) g$'it' reset --hard;; esac", "case x in *) g$'it' stash;; esac"],
  ["ANSI-C quoted git binary name behind a leading redirection", ">/dev/null g$'it' reset --hard", ">/dev/null g$'it' stash"],
  // The escape forms of the same class: inside `$'…'` a `\xHH`, `\nnn` or `\uHHHH` escape stands for
  // the character it encodes, so these spell the binary name without ever writing `g`. (`\u` is a
  // zsh 5.9 escape that bash 3.2 leaves literal — the shell that runs an agent's Bash call here is
  // zsh, so the guard must read it.)
  ["ANSI-C hex escape spelling the git binary name", "$'\\x67it' reset --hard", "$'\\x67it' stash"],
  ["ANSI-C octal escape spelling the git binary name", "$'\\147it' reset --hard", "$'\\147it' stash"],
  ["ANSI-C unicode escape spelling the git binary name", "$'\\u0067it' reset --hard", "$'\\u0067it' stash"],
  // Branch review round 8, fix round: a backslash-newline the OUTER shell was told to keep LITERAL.
  // Single quotes hand both characters through untouched, and the inner shell a wrapper starts reads
  // them as the line continuation they are and joins the halves — `sh -c 'g<backslash><newline>it
  // stash'` runs a real git that neither half spells. tokenizeCommand flushes a word on any
  // whitespace inside quotes (deliberately: a wrapper's quoted script must still show its `git` to
  // the wrapper check), so the word split into `'g\` and `it` and neither reduced to `git`. Seven of
  // the eight rows below returned allow on BOTH arms before the fix; the row with the continuation in
  // FRONT of the name already denied on both, because a leading `\` flushes as a token of its own and
  // leaves an ordinary `git` token the wrapper arm already saw — it is carried as a regression guard
  // for the position (verified: the branch-fix-8-3 differential probe's pre-fix column,
  // .devcycle/evidence/branch-fix-8-3-probe.txt). bash and zsh both print `git` for each of these
  // words, so each is a real, executed git.
  ["literal line continuation splitting the git binary name inside a wrapper's quoted script", "sh -c 'g\\\nit reset --hard'", "sh -c 'g\\\nit stash'"],
  ["literal line continuation before the last character of the git binary name", "sh -c 'gi\\\nt reset --hard'", "sh -c 'gi\\\nt stash'"],
  ["literal line continuation in front of the git binary name", "sh -c '\\\ngit reset --hard'", "sh -c '\\\ngit stash'"],
  ["literal line continuation after the git binary name", "sh -c 'git\\\n reset --hard'", "sh -c 'git\\\n stash'"],
  ["literal line continuation inside a bash -c script", "bash -c 'g\\\nit reset --hard'", "bash -c 'g\\\nit stash'"],
  ["literal line continuation inside a dash -c script", "dash -c 'g\\\nit reset --hard'", "dash -c 'g\\\nit stash'"],
  ["literal line continuation inside an eval'd string", "eval 'g\\\nit reset --hard'", "eval 'g\\\nit stash'"],
  ["literal line continuation inside a script behind stacked wrappers", "timeout 5 sh -c 'g\\\nit reset --hard'", "timeout 5 sh -c 'g\\\nit stash'"],
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
    // Round 4: the glued and half-glued definition heads, and the separated-target redirections,
    // in their non-git direction — closing a class must not turn it into a blanket deny.
    "f(){ echo ok; }; f",
    "f (){ echo ok; }; f",
    "f ()( echo ok )",
    "2>& 1 echo ok",
    ">& 2 echo ok",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for non-git: ${cmd}`);
});

// Round-4 lows: a case-pattern label is syntax whatever it spells, but two label spellings still
// reached the classifier as a command — an alternated label's FIRST alternative (`git|sh)`, cut off
// by the segment splitter's `|`) and a label whose arm body sits on the next line (`git)` alone in
// its segment) — so a benign `echo` was denied to a guarded origin because the LABEL spelled git.
test("guarded origin + a case label spelling git is never the arm's command, in either spelling", () => {
  for (const cmd of [
    "case $x in git|sh) echo ok;; esac",
    'case "$1" in\n  git|sh) echo ok ;;\nesac',
    "case $x in\n  git)\n    echo ok\n    ;;\nesac",
    "case $x in sh|git) git log;; esac",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a case label spelling git: ${cmd}`);
});

// A metacharacter inside quotes is DATA, not syntax: canonicalizing it into its own token would
// invent segments and commands that the shell never runs. Single, double and ANSI-C quoting all
// hold, and a `;` inside a commit message must not split the command.
test("a shell metacharacter inside quotes is data, not syntax", () => {
  for (const cmd of [
    "echo '(){}'",
    'echo "a; git reset --hard is only text"',
    "git log --grep='; git reset --hard' -1",
    "grep -rn 'git stash' playbooks/",
    "git diff -- 'a(b)c'",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a quoted metacharacter: ${cmd}`);
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decideMain(cwd, 'git commit -m "fix: git stash;"'), "allow");
  assert.equal(decideMain(cwd, "echo 'git stash'"), "allow");
});

// An unterminated quote is an ambiguous command, and this file's answer to ambiguity is to classify
// MORE, never less: the command is re-read with quoting disabled so the syntax the dangling quote
// would have hidden still reaches the classifier. A denial then costs a malformed command; the
// alternative costs a destructive git.
test("an unterminated quote is classified as if the command were unquoted", () => {
  assert.equal(decide(REVIEWER, 'echo "x; git reset --hard'), "deny");
  assert.equal(decide(REVIEWER, "echo 'x; git reset --hard"), "deny");
  assert.equal(decide(REVIEWER, 'echo "x; npm test'), "allow");
});

// Round-4 low: the background-`&` split had no regression row pairing a redirection with a REAL
// background operator, so the rule that keeps `2>&1` intact could have swallowed one unnoticed.
// The responsibility for telling the two apart now sits in the tokenizer, which glues a
// duplication's `&` into its redirection operator and emits a background `&` as its own token.
test("a background & after a redirection still separates the commands", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["node s.js >/dev/null & git reset --hard", "node s.js >/dev/null& git reset --hard"])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a backgrounded redirect: ${cmd}`);
  assert.equal(decideMain(cwd, "node s.js >/dev/null & git stash"), "deny");
  assert.equal(decide(REVIEWER, "node s.js >/dev/null & npm test"), "allow");
});

// No new false positives: the ordinary commands this cycle's own agents run every turn. A tokenizer
// rewrite is exactly the change that breaks these, and round 1 already shipped two over-denials.
test("the ordinary commands a cycle's agents run stay allowed", () => {
  for (const cmd of [
    "git status 2>&1",
    "npm test 2>&1 | tail -5",
    "git diff --stat -- a b",
    "node --test tests/unit/*.test.mjs",
    'grep -rn "git" playbooks/',
    "find . -name '*.mjs' -exec node --check {} \\;",
    "node scripts/validate.mjs && node scripts/xref-check.mjs",
    "du -sh /tmp/devcycle-tests",
    "git log --oneline -5 | cat",
    "awk '{print $1}'",
    "cat <<EOF > notes.md\nordinary prose, no command here\nEOF",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for an ordinary agent command: ${cmd}`);
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
    "case $x in git) git stash list;; esac",
    "f() { git stash show -p; }; f",
    "f(){ git stash show -p; }; f",
    "f (){ git stash show -p; }; f",
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

// Branch review round 2 (F4): a `case` pattern label is syntax, never a command, whatever it happens
// to spell. Refusing to drop a label that reduces to a classified head over-DENIED: the label `git)`
// made the classifier read the arm's own `echo` as a git subcommand, and the label `sh)` denied
// through the wrapper arm even though the only reachable git is a read-only `git log`.
test("guarded origin + a case pattern label spelling a command classifies the arm's body, not the label", () => {
  for (const cmd of [
    'case "$1" in git) echo x;; esac',
    "case $x in sh) git log;; esac",
    "case $x in git) git log;; esac",
    'case "$1" in\n  sh) echo ok ;;\nesac',
    "case $x in *)echo ok;; esac",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for case-label spelling: ${cmd}`);
});

// `(git)` is a subshell running a bare, unclassifiable git, not a labelled arm, so deny-on-ambiguity
// still owns it — including with a redirection behind it, which round 4 found slipping through when
// the whole `(git)` token was mistaken for a pattern label.
test("guarded origin + a bare git inside a subshell is still denied", () => {
  assert.equal(decide(REVIEWER, "(git)"), "deny");
  assert.equal(decide(REVIEWER, "(git stash)"), "deny");
  assert.equal(decide(REVIEWER, "(git) >/dev/null"), "deny");
});

// Fold-in F6: every VALUE_OPTIONS entry is exercised on both arms — a separated value must not be
// read as the subcommand, and the option must not hide a destructive one behind it.
test("guarded origin + git's separated global options skip their value, on both verdicts", () => {
  for (const cmd of [
    "git --config-env x.y=Z log",
    "git --super-prefix p/ log",
    "git --attr-source HEAD log",
    "git --exec-path=/p log",
    "git -c user.name=x log",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a read-only git behind a global option: ${cmd}`);
  for (const cmd of [
    "git --config-env x.y=Z reset --hard",
    "git --super-prefix p/ clean -fd",
    "git --attr-source HEAD checkout -- x",
    "git --exec-path /p reset --hard",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a destructive git behind a global option: ${cmd}`);
});

test("main thread + a stash behind git's separated global options is denied", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "git --config-env x.y=Z stash",
    "git --super-prefix p/ stash",
    "git --attr-source HEAD stash",
    "git --exec-path /p stash",
    "git -c user.name=x stash",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for main-thread stash behind a global option: ${cmd}`);
});

// F6, pinned: `git --exec-path log` is the valueless print-and-exit spelling — git prints its exec
// path and never runs `log` (verified: `git --exec-path log -1 --oneline` on git 2.39.2 prints only
// the path). The parser consumes `log` as the option's value, so the index runs off the end and a
// guarded origin gets an unclassifiable git. Pinned as a DENY: the spelling runs no subcommand at
// all, so denying it withholds nothing a guarded origin can act on.
test("guarded origin + the valueless git --exec-path spelling is denied as unclassifiable", () => {
  assert.equal(decide(REVIEWER, "git --exec-path log"), "deny");
  assert.equal(decide(REVIEWER, "git --exec-path"), "deny");
});

// Fold-in F5: an option whose value is absent runs the subcommand index off the end, and the two
// arms then differ by design — a guarded origin sees an unclassifiable git and denies, the main
// thread reads the missing token as "" and allows, because its ban is stash-only (spec §2) and a
// git with no subcommand runs nothing (`git --git-dir` exits 129 with a usage error on git 2.39.2).
test("a global option with its value missing: denied to a guarded origin, allowed on the main thread", () => {
  assert.equal(decide(REVIEWER, "git --git-dir"), "deny");
  assert.equal(decideMain(cycleDir(stateAt("execution")), "git --git-dir"), "allow");
});

// Round-2 regression guards for the two widenings: a `)` inside an ARGUMENT is not a pattern label,
// and a trailing `2>&1` (whose `&` no longer splits the command) must not turn an ordinary redirect
// into a denied segment.
test("guarded origin + a parenthesis inside an argument or a trailing redirection stays allowed", () => {
  for (const cmd of [
    "git log --grep=')' -1",
    "git diff -- 'a)b'",
    "git status 2>&1",
    "npm test 2>&1 | tail -5",
    "grep -rn ')' playbooks/",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a non-label parenthesis: ${cmd}`);
});

// A case arm's alternation (`git|sh)`) spans the `|` the segment splitter cuts on, so the whole
// label — every alternative — is dropped before segments are formed. Both directions are pinned:
// with the label gone the arm is classified by its BODY, which is the only thing that runs. Pinning
// the deny alone proved nothing, because a bare `git` first alternative denied on ambiguity anyway
// (branch review round 4, test-integrity).
test("a case arm with alternated patterns is classified by its body, in both directions", () => {
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decide(REVIEWER, "case $x in git|sh) git reset --hard;; esac"), "deny");
  assert.equal(decideMain(cwd, "case $x in git|sh) git stash;; esac"), "deny");
  assert.equal(decide(REVIEWER, "case $x in git|sh) git log;; esac"), "allow");
  assert.equal(decideMain(cwd, "case $x in git|sh) git stash list;; esac"), "allow");
});

// Round 6 (F3), the allow direction: canonicalizing the whole word must REDUCE the spelling, not
// deny it. The same `gi\t` that denies `reset --hard` has to allow `log`, or the fix would trade a
// fail-open for a blanket deny on every word carrying a quote.
test("an intra-word quoted or escaped git that reduces to a read-only invocation stays allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["gi\\t log", "\"g\"'it' status", 'g""it diff --stat -- a b', "gi\\t add -N x"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a reduced read-only git: ${cmd}`);
  for (const cmd of ['g""it stash list', "gi\\t stash show -p", "\"g\"'it' commit -m x"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow on the main thread: ${cmd}`);
});

// Round 6 (F4): a heredoc BODY is DATA, not commands. `<<` tokenized as an ordinary redirection, so
// the body's newlines became separator tokens and every body line was classified as a command — a
// guarded agent could not write a report or fixture naming `git reset --hard`. That over-denial
// obstructed round 6's own reviewer, which had to encode every git token as a placeholder to finish
// its review. The tokenizer now consumes the body up to its delimiter in every spelling bash
// accepts: quoted, unquoted, and `<<-` with its leading tabs stripped.
test("a heredoc body is data, so a report naming a destructive git may be written", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "cat <<EOF\ngit reset --hard\nEOF",
    "cat <<-EOF\n\tgit clean -fd\n\tEOF",
    "cat <<'EOF'\ngit reset --hard\nEOF",
    'cat <<"EOF"\ngit checkout -- x\nEOF',
    "cat <<EOF > findings.md\n- the guard denies git reset --hard\n- and git checkout -- x\nEOF",
    "cat <<A <<B\ngit reset --hard\nA\ngit clean -fd\nB",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a heredoc body: ${JSON.stringify(cmd)}`);
  for (const cmd of ["cat <<EOF\ngit stash\nEOF", "cat <<'EOF'\ngit stash pop\nEOF", "cat <<-EOF\n\tgit stash\n\tEOF"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow for a heredoc body: ${JSON.stringify(cmd)}`);
});

// The body is data only until its delimiter, and only from the next newline: a command sharing the
// heredoc's own line, and anything after the delimiter line, is still a command.
test("a command beside or after a heredoc is still classified", () => {
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decide(REVIEWER, "cat <<EOF > f\nprose\nEOF\ngit reset --hard"), "deny");
  assert.equal(decideMain(cwd, "cat <<EOF > f\nprose\nEOF\ngit stash"), "deny");
  assert.equal(decide(REVIEWER, "cat <<'EOF'\ngit log\nEOF\ngit clean -fd"), "deny");
  assert.equal(decide(REVIEWER, "cat <<EOF; git reset --hard\nprose\nEOF"), "deny");
  assert.equal(decide(REVIEWER, "cat <<EOF > f\nprose\nEOF\nnpm test"), "allow");
});

// An unterminated heredoc is an ambiguous command, and this file answers ambiguity by classifying
// MORE: the body is read as commands, exactly as before the fix. A denial then costs a malformed
// command; the alternative is a destructive git parked under a delimiter that never arrives.
test("an unterminated heredoc classifies its body as commands (deny-on-ambiguity)", () => {
  assert.equal(decide(REVIEWER, "cat <<EOF\ngit reset --hard\n"), "deny");
  assert.equal(decideMain(cycleDir(stateAt("execution")), "cat <<EOF\ngit stash\n"), "deny");
  assert.equal(decide(REVIEWER, "cat <<EOF\nnpm test\n"), "allow");
});

// A herestring is not a heredoc: `<<<` must keep matching before `<<`, or its word would be read as
// a delimiter and the rest of the command swallowed as a body.
test("a herestring is not a heredoc", () => {
  assert.equal(decide(REVIEWER, "git log <<< x"), "allow");
  assert.equal(decide(REVIEWER, "git reset --hard <<< x"), "deny");
  assert.equal(decide(REVIEWER, "cat <<< x; git reset --hard"), "deny");
});

// Round 8 (F1), the subcommand half of the ANSI-C class. Only the MAIN-THREAD arm is falsifiable
// here: a guarded origin denies `git st$'ash'` already, because its allowlist compares the raw
// subcommand token and has never contained `stash` in any spelling. The main thread reads the
// subcommand through normalizeHead, so the undropped `$` made `st$'ash'` "not stash" and allowed the
// single command the #235 ban exists to stop — a stash discards every in-flight implementer's
// uncommitted edits across the shared checkout. Every row below returned allow in an active cycle
// (verified: the round-8 differential probe's pre-fix column).
test("main thread + an ANSI-C quoted stash subcommand is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "git st$'ash'",
    "git st$'ash' pop",
    "git \"st\"$'ash'",
    "git s$''tash",
    "git $'\\x73tash'",
    "git $'\\163tash'",
    "git $'\\u0073tash'",
    "sh -c \"git st$'ash'\"",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for an ANSI-C quoted stash: ${cmd}`);
});

// Round 8 (F1), the allow direction: inside `$'…'` an escape stands for the character it encodes, so
// the quote is only removable where the shell removes it. `$'gi\t'` is `gi<TAB>` — a command neither
// bash nor zsh has — and consuming the backslash the way an unquoted word's rule does read it as
// `git` and DENIED a command the shell never runs. Decoding the escapes fixes both directions at
// once: it is what turns `$'\x67it'` into a deny above and this row into an allow.
test("an ANSI-C escape the shell does not read as the binary name stays allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["$'gi\\tt' reset --hard", "$'gi\\t' reset --hard", "$'gi\\tt' log", "'g'\\''it' reset --hard"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a significant ANSI-C escape: ${cmd}`);
  for (const cmd of ["$'gi\\tt' stash", "$'gi\\t' stash", "git st$'\\tash'", "'g'\\''it' stash"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow on the main thread: ${cmd}`);
  // Reducing the subcommand must not turn the ANSI-C spellings into a blanket stash deny either.
  assert.equal(decideMain(cwd, "git st$'ash' list"), "allow");
  assert.equal(decideMain(cwd, "git st$'ash' show -p"), "allow");
  // A DELIBERATE over-deny, unchanged by this fix and pinned so it stays visible: `\$git` is a
  // literal `$git` to the shell, not the binary, but normalizeHead's leading-`$` strip (which covers
  // the `$git` variable spelling) reduces it to git. Denying costs a command that runs nothing.
  assert.equal(decide(REVIEWER, "\\$git reset --hard"), "deny");
});

// Round 8 fix round, the subcommand half of the literal-continuation class. Only the MAIN-THREAD arm
// is falsifiable: a guarded origin denies any git behind `sh -c` already, whatever its subcommand.
// The main thread reads the subcommand through mentionsStash, and a `stash` split across the literal
// continuation reduced to neither `st` nor `ash` — so the one command the #235 ban exists to stop
// reached allow (verified: the branch-fix-8-3 differential probe's pre-fix column). The first and
// third rows are the falsifiable ones; the middle row, whose continuation sits in FRONT of `stash`,
// already denied, because that position leaves `stash` an ordinary token mentionsStash could read.
test("main thread + a stash subcommand split by a literal line continuation is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["sh -c 'git st\\\nash'", "sh -c 'git \\\nstash'", "bash -c 'git sta\\\nsh'"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for a split stash subcommand: ${JSON.stringify(cmd)}`);
});

// Round 8 fix round, the allow direction. A backslash before a SPACE or a TAB is an escaped
// space/tab, not a continuation: the shell builds the single word `g it`, and no git ever runs. It
// tokenizes exactly like the continuation — the word flushes at the whitespace, leaving a half that
// ends in a backslash — so a fix that joined any token ending in a backslash with its successor
// would deny every row here. Joining only across the backslash-NEWLINE the tokenizer preserved is
// what keeps them apart. The bound holds at the top level too: `'g<backslash><newline>it'` outside a
// wrapper is a command NAME carrying those two literal characters, which is not git in any shell.
test("a backslash that is not a line continuation the shell performs stays allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "sh -c 'echo g\\ it'",
    "sh -c 'echo git\\ reset'",
    "sh -c 'echo g\\\tit'",
    "echo 'g\\ it'",
    "'g\\\nit' reset --hard",
    "echo 'a\\'",
    "echo 'a\\\nb'",
    "printf 'a\\\nb'",
    "sh -c 'echo one \\\n  two'",
    "sh -c 'set -e\ncd x\ngrep -rn stash playbooks/'",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a non-continuation backslash: ${JSON.stringify(cmd)}`);
  for (const cmd of ["'g\\\nit' stash", "sh -c 'echo g\\ it stash'", "echo 'g\\\nit stash'"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow on the main thread: ${JSON.stringify(cmd)}`);
  // A DELIBERATE over-deny, the price of the bound this fix took, pinned so it stays visible: behind
  // a RECOGNIZED wrapper the guard cannot see whether that wrapper re-reads its argument as shell
  // text (`sh -c`, `eval`) or execs it literally (`sudo`, `env`), so a quoted literal continuation
  // denies behind all of them. The spelling names a command no shell has, so the deny withholds
  // nothing runnable — while the narrower bound (join only behind a named shell) would fail open on
  // every launcher that hands its argument to `sh -c`.
  assert.equal(decide(REVIEWER, "sudo 'g\\\nit' reset --hard"), "deny");
});

// No new false positives: an ANSI-C quote is ordinary punctuation in the commands this cycle's own
// agents run, and dropping the `$` in front of one must not invent a git anywhere in them.
test("the ordinary agent commands carrying an ANSI-C quote stay allowed", () => {
  for (const cmd of [
    "printf $'%s\\n' x",
    "echo $'a\\tb'",
    "grep -rn $'git\\treset' playbooks/",
    "rg -n $'\\tstash' references/",
    "sed -n $'1,40p' f",
    "git log --grep=$'x\\ty' -1",
    "node --test tests/unit/*.test.mjs",
    "npm test 2>&1 | tail -5",
    "find . -name '*.mjs' -maxdepth 2",
    "jq '.[] | .id' out.json",
    "gh pr view 235 --json title",
    "make check",
    "'/usr/local/bin/my git tool' --version",
    "python3 - <<'PY'\nprint('git reset --hard')\nPY",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for an ordinary agent command: ${cmd}`);
});

// Round 10 (F1). `\U` took up to EIGHT hex digits and handed the value straight to
// String.fromCodePoint, which throws above U+10FFFF, so the hook died with exit 1 and empty stdout —
// the fail-open this file's header names, the one a PreToolUse harness reads as "no decision". The
// boundary is measured, not assumed: `$'\U10FFFF'` decodes, `$'\U110000'` and up threw (verified:
// the round-10 finding's reproduction, re-run against HEAD before this test was written). decideRaw
// asserts status === 0, so each row below fails on the crash itself rather than on the verdict.
// Neither shell turns any of these into git — bash 3.2 leaves `\U…` literal and zsh emits the code
// point (or its replacement bytes) — so allow is the correct verdict on both sides of the boundary.
test("an out-of-range ANSI-C code point does not crash the guard", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "$'\\U10FFFF' reset --hard",
    "$'\\U0010FFFF' reset --hard",
    "$'\\U110000' reset --hard",
    "$'\\U00110000' reset --hard",
    "$'\\Uffffffff' reset --hard",
    "$'\\u0067it\\U110000' reset --hard",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for an unreadable code point: ${cmd}`);
  assert.equal(decideMain(cwd, "$'\\U110000' stash"), "allow");
  // The in-range escape still decodes, so the class it was added for is untouched: `\U00000067` is
  // `g`, and this spelling IS the git binary.
  assert.equal(decide(REVIEWER, "$'\\U00000067'it reset --hard"), "deny");
});

// Round 10 (F1), the scenario the finding measured rather than the decode unit. Heads are normalized
// segment by segment in order, so a crashing token placed BEFORE the git segment killed the process
// before any deny() was written and disarmed the guard for the whole command.
test("a crashing token in front of a git segment does not disarm the guard", () => {
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decide(REVIEWER, "echo hi ; $'\\UFFFFFFFF' ; git reset --hard"), "deny");
  assert.equal(decideMain(cwd, "echo hi ; $'\\UFFFFFFFF' ; git stash"), "deny");
});

// Round 10 (F1), the CLASS rather than the instance: whatever the parser throws on, the answer must
// be a deny, not an uncaught exception — a guard whose failure mode is fail-open contradicts this
// file's whole premise, and the next parser change could add another crash. With the decode fixed no
// input reaches a throw any more, so the only honest injection left is to run the REAL hook source
// with one line mutated to throw, reached through the ordinary stdin path. Both replacements are
// asserted, so a rename that stops the mutation from applying fails here instead of passing
// vacuously — as it did in round 12, when the per-token entry point every command head passes
// through became headForms (normalizeHead now reads that function's first realization).
test("a parser failure ends in a deny, not in a fail-open exit", () => {
  const IMPORT = 'import { findStateFile } from "./lib/find-state-file.mjs";';
  const SIGNATURE = "function headForms(token) {";
  const source = readFileSync(HOOK, "utf8");
  assert.ok(source.includes(IMPORT), "the hook's find-state-file import moved; the mutant cannot resolve it");
  assert.ok(source.includes(SIGNATURE), "headForms' signature moved; the mutant would inject nothing");
  const mutantDir = mkdtempSync(join(tmpdir(), "devcycle-git-guard-throw-"));
  fixtures.push(mutantDir);
  const mutant = join(mutantDir, "block-destructive-git.mjs");
  writeFileSync(mutant, source
    .replace(IMPORT, `import { findStateFile } from ${JSON.stringify(pathToFileURL(join(dirname(HOOK), "lib", "find-state-file.mjs")).href)};`)
    .replace(SIGNATURE, `${SIGNATURE} if (token === "boom") throw new Error("injected parser failure");`));

  const cwd = cycleDir(stateAt("execution"));
  for (const input of [
    { agent_type: REVIEWER, tool_input: { command: "boom ; git log" } },
    { agent_type: IMPLEMENTER, tool_input: { command: "boom ; git log" } },
    { cwd, tool_input: { command: "boom ; git log" } },
  ]) {
    const r = spawnSync("node", [mutant], { input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(r.status, 0, `the mutant exited ${r.status} with stdout ${JSON.stringify(r.stdout)}`);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision, "deny",
      `expected a deny for a parser failure, got ${JSON.stringify(r.stdout)}`);
  }
  // A parser failure on an origin the guard does not cover is still not this hook's business: those
  // origins never reach the classification loop at all.
  const unguarded = spawnSync("node", [mutant], {
    input: JSON.stringify({ agent_type: "devcycle:planner", tool_input: { command: "boom ; git log" } }), encoding: "utf8",
  });
  assert.equal(unguarded.status, 0);
  assert.equal(unguarded.stdout.trim(), "");
});

// Round 10 fix round. A command that ENDS in a backslash carries a DANGLING escape: there is no
// character behind it to escape, and both shells drop it — `git stash\` invoked git with argv
// `stash` in /bin/bash and in /bin/zsh alike (verified with a `git` shim first on PATH that records
// the argv it is handed). The tokenizer kept the character in the word instead, so the subcommand
// read as `stash\`, which is not `stash`, and the one command the #235 ban exists to stop reached
// ALLOW. Only the MAIN arm flips: a guarded origin denies every row here already, because there the
// head alone decides and the subcommand never has to be read (verified against HEAD before this test
// was written).
test("main thread + a stash subcommand ending in a dangling backslash is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["git stash\\", "true && git stash\\", "git -C . stash\\"]) {
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for a dangling backslash: ${JSON.stringify(cmd)}`);
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a dangling backslash: ${JSON.stringify(cmd)}`);
  }
});

// The bound on that drop, in the direction that must NOT move: a backslash the shell KEEPS is not a
// dangling escape and may not deny. Inside single quotes it is literal (`git 'stash\'` hands git the
// argv `stash\`), an escaped backslash leaves one literal backslash (`git stash\\` → argv `stash\`),
// and a backslash-space is an escaped space (`git stash\ ` → argv `stash `, with the space) — the
// shim oracle recorded each of those argvs in both shells, and none of them is `git stash`. The
// non-git spellings an agent writes carry the same character and must stay allowed too: a quoted
// Windows-style path, a `find … -exec … \;`, and a single-quoted trailing backslash.
test("a backslash the shell keeps is not a dangling escape and stays allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "git 'stash\\'",
    "git stash\\\\",
    "git stash\\ ",
    "echo 'a\\'",
    "echo 'C:\\Users\\me\\repo\\'",
    "find . -name '*.mjs' -exec grep -l stash {} \\;",
  ])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow for a backslash the shell keeps: ${JSON.stringify(cmd)}`);
});

// The same drop in the relaxing direction, pinned because it is a behavior change and not a side
// effect: a trailing backslash on a READ-ONLY subcommand read as `status\`/`log\`/`stash list\`,
// which no allowlist entry matches, so a guarded origin was denied `git status\` and the main thread
// `git stash list\` — commands the shells run as plain `git status` and `git stash list` (shim
// oracle, both shells). Dropping the dangling backslash makes both classify as what actually runs.
test("a read-only subcommand ending in a dangling backslash is allowed on both arms", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["git status\\", "git log\\", "git diff\\"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a read-only git: ${JSON.stringify(cmd)}`);
  for (const cmd of ["git stash list\\", "git stash show\\"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow for an inspecting stash: ${JSON.stringify(cmd)}`);
});

// Round 12 (F1), the NUL class. `$'\x00'`, `$'\000'` and `$'\c@'` all materialise a NUL byte, and
// neither shell hands that byte to the binary — each cuts the word short at it, in a DIFFERENT
// place: /bin/bash truncates every `$'…'` expansion at its own first NUL and keeps concatenating
// what the word spells around it (`g$'\x00'it` → `git`), while /bin/zsh truncates the WHOLE word
// there (`git$'\x00'x` → `git`). So each spelling below reaches the real git binary in at least one
// of the two shells — the `git` shim first on PATH logged `stash`, `reset --hard` and `status` argvs
// for them — while the guard kept the NUL inside the word, compared it against "git" and allowed.
// This arm flips for every row: the head never reduced to git, so the segment was read as a non-git
// command. The deny direction is the union of the two shells, which is why both cut rules are
// modelled rather than one.
test("guarded origin + a NUL-cut git or wrapper head is denied", () => {
  for (const cmd of [
    "$'\\x00'git reset --hard",     // bash: the expansion is empty, the word is still `git`
    "g$'\\x00'it stash",
    "true && $'\\x00'git stash",
    "g$'\\000'it stash",            // the octal spelling of the same byte
    "g$'\\c@'it stash",             // the control-@ spelling of the same byte
    "git$'\\x00' stash",            // both shells: the word is `git`
    "$'git\\x00foo' reset --hard",  // bash cuts the expansion at the NUL, so the head is `git`
    "git$'\\x00'x stash",           // zsh cuts the whole word at the NUL, so the head is `git`
    "sh -c \"g$'\\x00'it stash\"",  // the same cut inside a wrapper's script
    "s$'\\x00'h -c 'git stash'",    // and in the WRAPPER's own name
    "$'sh\\x00x' -c 'git stash'",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a NUL-cut head: ${cmd}`);
});

// The same class on the main-thread arm, which reads the SUBCOMMAND through the same normalizer: a
// NUL anywhere in `stash` left the token spelling something that is not `stash`, so the one command
// the #235 ban exists to stop reached ALLOW. Every row ran a real `git stash` in at least one shell
// (shim oracle); the rows whose head carries the NUL flip on both arms, the rows whose SUBCOMMAND
// carries it flip only here (a guarded origin denies those already — its allowlist has never
// contained `stash` in any spelling).
test("main thread + a NUL-cut git stash is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "g$'\\x00'it stash",
    "true && $'\\x00'git stash",
    "git$'\\x00' stash",
    "git$'\\x00'x stash",
    "git st$'\\x00'ash",            // bash: `stash`; zsh: `st`
    "git stash$'\\x00'",
    "git $'stash\\x00pop'",         // both shells cut the expansion at the NUL → `stash`
    "git stash$'\\x00'x",           // zsh cuts the word at the NUL → `stash`
    "sh -c \"g$'\\x00'it stash\"",
    "$'sh\\x00x' -c 'git stash'",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for a NUL-cut stash: ${JSON.stringify(cmd)}`);
});

// The bound on that union, in the direction that must NOT move: a NUL that cuts a command name SHORT
// leaves a name neither shell runs as git, and modelling the cut must not invent one. `$'gi\x00t'` is
// `gi` in both shells and ran nothing; `git $'sta\x00sh'` invoked git with `sta`; and a NUL in front
// of a read-only subcommand is still read-only (`$'\x00'git status` ran `git status` in bash). Each
// argv below is the shim oracle's, in both shells.
test("a NUL that cuts a command name short is not the git binary and stays allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["$'gi\\x00t' reset --hard", "$'np\\x00m' test", "$'\\x00'git status", "$'git\\x00foo' status", "echo $'a\\x00b'"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a NUL-cut name: ${cmd}`);
  for (const cmd of ["$'gi\\x00t' stash", "git $'sta\\x00sh'", "git stash$'\\x00' list", "git st$'\\x00'ash show"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow on the main thread: ${cmd}`);
});

// Round 12 (F2), the eval-rejoin class. `eval` CONCATENATES its arguments and re-parses the result,
// so a leading escaped space, tab or backslash in front of `git` is whitespace or an alias-bypass to
// that second parse and disappears: `eval \ git stash` and `eval \\git stash` each ran a real
// `git stash` in both shells (shim oracle). This outer parse resolves `\ git` to the word " git" and
// `\\git` to "\git", neither of which equals "git", so the wrapper arm returned without denying —
// the opposite of what the WRAPPERS comment promises. Both arms flip for the stash rows; the
// `reset --hard` row flips on the guarded arm alone (the main-thread ban is stash-only).
test("guarded origin + git behind an eval that re-joins its arguments is denied", () => {
  for (const cmd of ["eval \\ git stash", "eval \\\tgit reset --hard", "eval \\\\git stash", "eval \" git stash\""])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for an eval-rejoined git: ${JSON.stringify(cmd)}`);
});

test("main thread + git stash behind an eval that re-joins its arguments is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["eval \\ git stash", "eval \\\\git stash"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for an eval-rejoined stash: ${JSON.stringify(cmd)}`);
});

// The bound on that resolution: only the FIRST backslash is the inner parse's escape. `eval \\\\git`
// hands the inner shell `\\git`, which it reads as the literal command name `\git` — no shell has
// it, and the oracle recorded no git call in either shell. At the top level nothing re-parses at
// all, so `\\git stash` is that same non-existent command and must stay allowed on both arms.
test("a backslash the inner or outer parse keeps is not git and stays allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["eval \\\\\\\\git stash", "\\\\git stash"]) {
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a kept backslash: ${JSON.stringify(cmd)}`);
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow for a kept backslash: ${JSON.stringify(cmd)}`);
  }
});

// Round 14 (F1), the substitution backstop's canonicalization. The pre-check tested a RAW-text
// `\bgit\b`, so every word-level obfuscation the shell resolves BEFORE it runs the binary made the
// backstop silent: `echo $(g\it stash)` handed git the argv `stash` in /bin/bash and in /bin/zsh
// alike (shim oracle) and reached ALLOW on both arms, and so did the backtick, the double-quoted
// `$( )`, the `<( )` process substitution, `gi""t` and `g'it'`. The segment classifier cannot reach
// those heads either — stripLeading returns the OUTER command (`echo`) and the substitution's words
// are merely its arguments — so the backstop now runs the same headForms reduction the classifier
// uses over the command's tokens. Both arms flip on the `stash` rows; the `reset --hard` rows flip
// on the guarded arm alone, whose ban is not stash-only.
test("guarded origin + a substitution whose git is obfuscated is denied", () => {
  for (const cmd of [
    "echo $(g\\it stash)",
    "echo `g\\it stash`",
    'echo "$(g\\it stash)"',
    "printf %s $(g\\it reset --hard)",
    "cat <(g\\it stash)",
    'echo $(gi""t stash)',
    "echo $(g'it' stash)",
    // Double quotes do not suppress a backtick substitution, so the head inside one has to reduce
    // there too; and the body of a substitution is RE-READ, so the backslash-newline the outer
    // single quotes made literal is a line continuation in it and joins the halves. Both spellings
    // ran a real git in both shells (shim oracle).
    'echo "`g\\it reset --hard`"',
    'echo "`$\'\\x67\'it reset --hard`"',
    "echo `'g\\\nit' reset --hard`",
    "echo \"`'g\\\nit' reset --hard`\"",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for an obfuscated substituted git: ${JSON.stringify(cmd)}`);
});

// The same class on the main-thread arm, which needs a `stash` word beside the substituted git: the
// SUBCOMMAND obfuscations flip only here, because a guarded origin denies any substituted git
// already. `echo $(git st\ash)` ran a real `git stash` in both shells (shim oracle) while the raw
// `\bstash\b` read it as "not stash" and allowed — the one command the #235 ban exists to stop.
test("main thread + an obfuscated git or stash inside a substitution is denied in an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "echo $(g\\it stash)",
    "echo `g\\it stash`",
    'echo "$(g\\it stash)"',
    "cat <(g\\it stash)",
    "echo $(git st\\ash)",
    "echo `git st\\ash`",
    'echo "`g\\it stash`"',
    "echo `'g\\\nit' stash`",
    "echo `git 's\\\ntash'`",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for an obfuscated substituted stash: ${JSON.stringify(cmd)}`);
});

// Round 14 (F2), the reverted heredoc widening. Round 13 exempted the body of a QUOTED-delimiter
// heredoc from the substitution pre-check, falling back to the raw command only when a segment head
// was in WRAPPERS. Everything that executes a body without being listed kept the exemption, so
// `ksh <<'EOF'` (ksh ships with macOS) and writing the body to a file and sourcing it with `.` or
// `source` each ran a real `git stash` in BOTH shells (shim oracle) while both arms ALLOWED — a deny
// that commit 0e1dc9d had. The widening is reverted rather than re-bounded: the pre-check reads the
// raw command again, bodies included. The last four rows were denied by round 13 too and are kept so
// the revert cannot quietly narrow them.
test("a heredoc body carrying a substitution is denied whatever executes the body", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "cat <<'EOF' > f\n$(git stash)\nEOF\n. ./f",             // an unlisted executor: the `.` builtin
    "cat <<'EOF' > f\n$(git stash)\nEOF\nsource ./f",
    "ksh <<'EOF'\n$(git stash)\nEOF",                        // an interpreter that is not in WRAPPERS
    "bash <<'EOF'\n$(git stash)\nEOF",                       // one that is
    "cat <<'EOF' | bash\n$(git stash)\nEOF",
    "cat <<EOF > f\nrun `git reset --hard` here\nEOF",       // a BARE delimiter really expands the body
    "cat <<EOF > f\nuse $(git rev-parse HEAD)\nEOF",
    "cat <<'EOF' > f\nprose\nEOF\necho $(git reset --hard)", // the substitution is outside the body
    "cat <<'EOF' > f\nuse $(git reset --hard)\n",            // unterminated: no body boundary to trust
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a live substitution: ${JSON.stringify(cmd)}`);
  for (const cmd of [
    "cat <<'EOF' > f\n$(git stash)\nEOF\n. ./f",
    "cat <<'EOF' > f\n$(git stash)\nEOF\nsource ./f",
    "ksh <<'EOF'\n$(git stash)\nEOF",
    "bash <<'EOF'\n$(git stash)\nEOF",
    "cat <<'EOF' | bash\n$(git stash)\nEOF",
    "echo `git stash`\ncat <<'EOF' > f\nprose\nEOF",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for a live substitution: ${JSON.stringify(cmd)}`);
});

// The COST of that revert, pinned here so it stays a visible decision instead of being rediscovered
// as a bug: a heredoc body that merely NAMES a git command inside markdown backticks or a `$( )` —
// the ordinary shape of the report and findings files this repo asks its agents to write — is denied
// again, and no git runs in any of these (the shim oracle recorded no git call, in either shell).
// Round 13 removed this deny, and the removal was wider than the shells' behaviour (see above); the
// decision at the round-14 gate was to revert and accept the over-denial rather than re-bound the
// exemption a third time. The `reset --hard`/`rev-parse` rows are guarded-arm only.
test("a quoted heredoc body naming a git command in a substitution is denied (the accepted over-denial)", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "cat <<'EOF' > f\nrun `git reset --hard` here\nEOF",
    "cat <<'EOF' > f\nuse $(git rev-parse HEAD)\nEOF",
    'cat <<"EOF" > f\nuse $(git reset --hard)\nEOF',
    "cat <<\\EOF > f\nuse $(git reset --hard)\nEOF",
    "cat <<-'EOF' > f\n\trun `git stash` here\n\tEOF",
    "cat <<'EOF' > f\n- ran `git stash` by mistake\nEOF",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a quoted heredoc body: ${JSON.stringify(cmd)}`);
  for (const cmd of [
    "cat <<-'EOF' > f\n\trun `git stash` here\n\tEOF",
    "cat <<'EOF' > f\n- ran `git stash` by mistake\nEOF",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for a quoted heredoc body: ${JSON.stringify(cmd)}`);
  // The bound on that cost: the pre-check needs substitution punctuation, so a body that names a git
  // command WITHOUT any is still data and the round-6 exemption an agent leans on is untouched.
  for (const cmd of [
    "cat <<'EOF' > f\n- the guard denies git reset --hard\nEOF",
    "cat <<EOF > notes.md\nordinary prose, no command here\nEOF",
    "python3 - <<'PY'\nprint('git reset --hard')\nPY",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a substitution-free body: ${JSON.stringify(cmd)}`);
});

// Round 14 (F3), the comment-fabricated heredoc. tokenizeCommand had no comment handling, so the
// `<<` inside `echo hi # <<'EOF'` registered a heredoc the shell never opens, and skipHeredocBodies
// then consumed the REAL commands on the following lines as body data: `git stash` ran in both
// shells and both arms allowed it (shim oracle recorded the `stash` argv). The command is now
// classified in BOTH readings — as written, and with the `#` comments removed — and denied on either.
test("a # comment cannot fabricate a heredoc that hides the commands behind it", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of [
    "echo hi # <<'EOF'\ngit stash\nEOF",
    "echo hi #<<'EOF'\ngit stash\nEOF",
    "echo hi # <<EOF\ngit stash\nEOF",
    "echo hi # <<'EOF'\n$(git reset --hard)\nEOF",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a fabricated heredoc: ${JSON.stringify(cmd)}`);
  for (const cmd of ["echo hi # <<'EOF'\ngit stash\nEOF", "echo hi # <<EOF\ngit stash\nEOF"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for a fabricated heredoc: ${JSON.stringify(cmd)}`);
  // The bound: a `#` opens a comment only where the shells make it one — at the start of a WORD and
  // unquoted. Quoted or escaped it is an ordinary character, the heredoc it opens is REAL, and its
  // body stays data (`echo '#' <<EOF … EOF` ran no git in either shell); and a comment carrying no
  // heredoc opener hides nothing, so the command behind it classifies exactly as before.
  for (const cmd of ["echo '#' <<EOF\ngit stash\nEOF", "echo a\\#b; git log", "echo hi # heredoc\ngit log"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for a hash the shell does not read as a comment: ${JSON.stringify(cmd)}`);
});
