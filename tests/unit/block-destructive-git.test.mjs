// #165/#235: a guarded dispatch must not run destructive git against the shared checkout, and the
// main thread must not run `git stash` while a devcycle cycle is active. Structural backstop
// mirroring block-main-thread-browser.test.mjs: spawn the hook with a crafted
// PreToolUse stdin and assert the deny/allow decision. deny = a permissionDecision:"deny" object on
// stdout; allow = empty stdout (defer to normal permission flow). Both exit 0 (a non-zero exit with
// empty stdout is the fail-open a PreToolUse harness reads as "no decision").
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { hostname } from "node:os";
import { acquireDriveLock } from "../../scripts/drive-lock.mjs";

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
// hooks/workload-sensor.mjs does. The fixture must sit outside the repo (the suite runs under an
// out-of-repo TMPDIR), or the walk would find the repo's own state file.
function cycleDir(stateBody) {
  const dir = makeTempDir("devcycle-git-guard-");
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
  // normalizeHead drops quotes/backslashes IN the word, so a quote splitting the name mid-token
  // (`g"i"t`, `g''it`) resolves to git the same as a wrapping quote does — the shell runs git either
  // way. This is the fail-closed reduction; it only ever adds a match.
  assert.equal(decide(REVIEWER, 'g"i"t reset --hard'), "deny");
  assert.equal(decide(REVIEWER, "g''it clean -fd"), "deny");
});

test("reviewer + backslash-escaped git is denied, in and around the word", () => {
  assert.equal(decide(REVIEWER, "\\git reset --hard"), "deny");
  assert.equal(decide(REVIEWER, "gi\\t reset --hard"), "deny");
  assert.equal(decide(REVIEWER, "\\g\\i\\t clean -fd"), "deny");
});

// The reduction only makes MORE tokens read as git, never fewer: a different binary whose name
// merely contains the letters "git" keeps its own name and stays allowed (no false-positive deny).
test("reviewer + a non-git binary that contains 'git' is not swept into the guard", () => {
  for (const cmd of ["gitleaks detect", "git-lfs prune", "digital-clock --reset"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for non-git binary: ${cmd}`);
});

// STATED BOUNDS (see the hook header). This guard is a proportionate backstop against a cooperative
// dispatch running a plain destructive git, not a complete parser: closing these needs the shell
// itself, and the guarded origins are read-only-contract Claude dispatches, not a hostile shell.
// These are ALLOW today, by design; the test pins the bound so a future change to it is deliberate,
// not silent. If the origins ever stop being cooperative, this is the trade to revisit.
test("stated bounds: shell expansion, ANSI-C quoting, functions, case labels and in-substitution obfuscation reach allow", () => {
  for (const cmd of [
    "G=git; $G reset --hard",        // parameter expansion assembles the word
    "gi${x}t reset --hard",          // expansion spliced into the name
    "git${IFS}reset --hard",         // IFS expansion as the separator (bash)
    "$'\\x67it' reset --hard",       // ANSI-C quoting spells git
    "f(){ git reset --hard; }; f",   // a shell function hides it
    "case x in *) git reset --hard;; esac", // a case label hides it
    "echo `gi\\t reset --hard`",     // git obfuscated by a backslash INSIDE a substitution:
    "x=$(g\\it reset --hard)",       //   the substitution detector is a raw-text \bgit\b tripwire,
  ])                                 //   so it sees a plain `git` in there but not a broken-up one
    assert.equal(decide(REVIEWER, cmd), "allow", `bound changed (now denied) for: ${cmd}`);
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
  // The family is <( , >( and zsh's =( ; all three are denied when a git token is present.
  for (const cmd of ["cat <(git stash drop)", "echo x | tee >(git checkout -- x)", "cat <(git log -1)",
    "cat =(git reset --hard)", "diff =(git checkout -- x) f", "cat =(git log -1)"])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for process substitution: ${cmd}`);
});

// `=(` is anchored to word start / whitespace so the process-substitution spelling is caught without
// denying an ARRAY ASSIGNMENT, whose `=(` is glued to a name — the git after it is read-only and must
// still run. A raw `=\(` regex would wrongly deny these.
test("reviewer + an array assignment beside a read-only git is not a false-positive deny", () => {
  for (const cmd of ["files=(*.js); git diff -- x", "arr=(a b c); git status", "x=(1 2 3); git log -1"])
    assert.equal(decide(REVIEWER, cmd), "allow", `array assignment wrongly denied: ${cmd}`);
});

test("main thread + git stash inside a zsh =() substitution is denied during an active cycle", () => {
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decideMain(cwd, "cat =(git stash)"), "deny");
  // ...but an array assignment beside a benign main-thread git is not swept in.
  assert.equal(decideMain(cwd, "files=(a b); git status"), "allow");
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

// #276/#284 and the 2026-10-08 live repro: the substitution tripwire read "a substitution token
// anywhere plus the word git anywhere", so a heredoc note or a findings file that merely NAMED a git
// command next to backticks was denied — on a guarded dispatch and on the main thread's stash rule
// alike. Data now counts as data — a quoted heredoc body fed to cat/tee, single-quoted text — on a
// line made only of commands that never run their arguments or input; a guarded dispatch's
// substitution that names no git, feeding a command that is neither git nor a launcher, no longer
// trips the wire.
const LIVE_REPRO = [
  "cat > notes.md <<'EOF'",
  "- LIVE REPRO 2026-10-08 (main thread, stage brainstorm): a heredoc writing these notes was denied",
  "  because its prose named `git stash` and contained backticks (`deny-on-ambiguity`).",
  "EOF",
].join("\n");

test("main thread + the live repro: a quoted heredoc whose body names git stash beside backticks is allowed", () => {
  const cwd = cycleDir(stateAt("brainstorm"));
  assert.equal(decideMain(cwd, LIVE_REPRO), "allow");
  assert.equal(decideMain(cwd, `${LIVE_REPRO}\ngit add notes.md`), "allow");
  assert.equal(decideMain(cwd, "cat > \"${TMPDIR}/msg.md\" <<'EOF'\nfix: never run `git stash` during a cycle\nEOF"), "allow");
  // The execution stage's brief hand-off: task-dispatch.mjs only writes the brief it reads to a file.
  assert.equal(decideMain(cycleDir(stateAt("execution")),
    "node \"${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs\" --run 0123456789abcdef --task 3 --role implementer <<'EOF'\nNever run `git stash`.\ngit stash drop is named, not run\nEOF"), "allow");
});

test("reviewer + a findings file written through a quoted heredoc that names git is allowed (#284)", () => {
  for (const cmd of [
    "mkdir -p .devcycle/findings && cat > .devcycle/findings/t1.md <<'EOF'\n## Findings\n- `git reset --hard` in step 3 would discard the diff; $(git stash) is quoted prose.\nEOF",
    "tee notes.md <<\"NOTES\" >/dev/null\nrun `git checkout -- x` never\nNOTES",
    "cat > a.md <<-'EOF'\n\t`git clean -fd` stays banned\n\tEOF",
    "cat > b.md <<\\EOF\n`git push` is named only\nEOF",
    "cat <<'EOF' | tee c.md\ngit reset --hard\nEOF",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for heredoc data: ${cmd}`);
});

test("reviewer + a substitution without git beside a read-only git is allowed (#276)", () => {
  for (const cmd of [
    'git diff --stat -- CONTRIBUTING.md; echo "checked at $(date)"',
    "git log -1 --format=%H && wc -l `ls references`",
    "git show HEAD:README.md | head -n \"$(( 2 + 3 ))\"",
  ])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for git-free substitution: ${cmd}`);
});

test("single-quoted text is data for the substitution check", () => {
  assert.equal(decide(REVIEWER, "echo '$(git reset --hard)'"), "allow");
  assert.equal(decide(REVIEWER, "grep -n '`git stash`' references/evidence.md"), "allow");
  assert.equal(decideMain(cycleDir(stateAt("execution")), "printf '%s\\n' '$(git stash)'"), "allow");
  // ...but the wrapper arm still reads a quoted script, and double quotes still substitute.
  assert.equal(decide(REVIEWER, "sh -c 'git reset --hard'"), "deny");
  assert.equal(decide(REVIEWER, 'echo "$(git reset --hard)"'), "deny");
});

test("a heredoc read by a shell or piped into one stays a script, and an unquoted body still substitutes", () => {
  for (const cmd of [
    "bash <<'EOF'\ngit reset --hard\nEOF",
    "cat <<'EOF' | sh\ngit checkout -- x\nEOF",
    "cat > x.md <<EOF\nhead is $(git rev-parse HEAD)\nEOF",
    "cat > x.md <<EOF\nhead is `git log -1`\nEOF",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for executed heredoc: ${cmd}`);
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decideMain(cwd, "bash <<'EOF'\ngit stash\nEOF"), "deny");
  assert.equal(decideMain(cwd, "cat > notes.md <<EOF\nrun `git stash` now\nEOF"), "deny");
  // A shell reading a heredoc of read-only git is classified like the same lines typed directly.
  assert.equal(decide(REVIEWER, "bash <<'EOF'\ngit diff\ngit status\nEOF"), "allow");
});

test("nested substitutions are walked to their real boundaries", () => {
  for (const cmd of [
    'echo "$(echo $(git reset --hard))"',
    'x=$(echo ")"; git stash drop)',
    "echo $(echo `git checkout -- x`)",
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for nested substitution: ${cmd}`);
  assert.equal(decide(REVIEWER, 'echo "$(echo "(a)") $(date)"; git diff'), "allow");
});

test("input the scanner cannot parse is denied when git appears (deny-on-ambiguity)", () => {
  for (const cmd of ['echo "$(git status', "echo 'unterminated && git diff", "cat > f.md <<'EOF'\nnotes about git\n"])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for unparsable: ${cmd}`);
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decideMain(cwd, 'echo "$(git stash'), "deny");
  // Unparsable but naming no stash: the main thread's ban is stash-only, so it stays allowed.
  assert.equal(decideMain(cwd, 'echo "unterminated && git status'), "allow");
  const reason = decideRaw({ agent_type: REVIEWER, tool_input: { command: 'echo "$(git status' } }).reason;
  assert.match(reason, /cannot parse/);
});

test("rtk is a transparent launcher: the git it runs is still classified", () => {
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of ["rtk git stash", "rtk -v git stash pop", "rtk proxy --skip-env git stash", "rtk err git stash", "rtk proxy rtk git stash"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for rtk-launched stash: ${cmd}`);
  assert.equal(decideMain(cwd, "rtk git stash list"), "allow");
  for (const cmd of ["rtk git reset --hard", "rtk proxy git checkout -- x", "rtk proxy --ultra-compact git reset --hard",
    "rtk proxy -- git clean -fd", "rtk err git reset --hard", "rtk test git checkout -- x", "rtk summary git reset --hard",
    "rtk run -c 'git clean -fd'", "rtk run git reset --hard"])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for rtk-launched git: ${cmd}`);
  for (const cmd of ["rtk git diff", "rtk git log -3", "rtk grep git src", "rtk proxy git status", "rtk err git status"])
    assert.equal(decide(REVIEWER, cmd), "allow", `expected allow for rtk-launched read-only git: ${cmd}`);
});

// QC9: every way the plan review (coverage F1–F3) found to run a git through text the new parser
// could read as data — denied before this change, so each must stay denied. Bash and zsh run the git
// in every one: a glued or leading redirection, a reader on a continuation line, a shell reader
// outside WRAPPERS (`source`, `.`, `> >(sh)`, `$l`, `ssh`), a written script run in the same command,
// a quoted heredoc inside a substitution whose output is executed or becomes git's arguments, git
// and its subcommand on opposite sides of a substitution, an escaped space before `#`, `<<` inside
// `((…))`/`${…}`, a `case` label that closes a substitution early, an array subscript or glob
// qualifier that evaluates single-quoted text, and a command made of inert words fed into git.
const STAYS_DENIED_FOR_A_REVIEWER = [
  "bash<<'EOF'\ngit reset --hard\nEOF",
  "sh<<EOF\ngit reset --hard\nEOF",
  "<<'EOF' bash\ngit reset --hard\nEOF",
  "bash \\\n<<'EOF'\ngit reset --hard\nEOF",
  "cat <<'EOF' |\ngit reset --hard\nEOF\nbash",
  "source /dev/stdin <<'EOF'\ngit reset --hard\nEOF",
  "cat <<'EOF' > >(sh)\ngit reset --hard\nEOF",
  "while read -r l; do $l; done <<'EOF'\ngit reset --hard\nEOF",
  "ssh localhost <<'EOF'\ngit reset --hard\nEOF",
  "cat <<'EOF' > s.sh\ngit reset --hard\nEOF\nbash s.sh",
  "cat <<'EOF' | tee /dev/null | bash\ngit reset --hard\nEOF",
  "{ cat; } <<'EOF' | sh\ngit reset --hard\nEOF",
  "$(cat <<'EOF'\ngit reset --hard\nEOF\n)",
  "eval \"$(cat <<'EOF'\ngit reset --hard\nEOF\n)\"",
  "bash -c \"$(cat <<'EOF'\ngit reset --hard\nEOF\n)\"",
  "a=$(cat <<'EOF'\ngit reset --hard\nEOF\n)\n$a",
  "$(which git) reset --hard",
  "git diff $(echo --output=x)",
  "read x < <(echo --output=f); git log $x",
  "echo '$(git reset --hard)' | sh",
  "test -v 'a[$(git reset --hard)]'",
  "echo a\\ #$(git reset --hard)",
  "(( y = 1 <<EOF ))\ngit reset --hard\nEOF",
  "echo ${x:-<<EOF}\ngit reset --hard\nEOF}",
  "echo $(case x in a) echo;; *) git reset --hard;; esac)",
  // A delimiter word the shells decode beyond quote removal ends the body at a line the scanner
  // would read past: `$'EOF'`/`$"EOF"` end at `EOF`, `"E\\OF"` at `E\OF`, `${X Y}` spans the space.
  "cat <<$'EOF'\nx\nEOF\ngit reset --hard\n$EOF",
  "cat <<$\"EOF\"\nx\nEOF\ngit reset --hard\n$EOF",
  "cat <<E$'O'F\nx\nEOF\ngit reset --hard\nE$OF",
  "cat <<\"E\\\\OF\"\nx\nE\\OF\ngit reset --hard\nE\\\\OF",
  "cat <<\"E\\$F\"\nx\nE$F\ngit reset --hard\nE\\$F",
  "cat <<${X Y}\n${X\ncat <<'Q'\n${X Y}\ngit reset --hard\nQ",
  "cat <<$[1 + 2]\n$[1\ncat <<'Q'\n$[1 + 2]\ngit reset --hard\nQ",
  // The shells split words only on space, tab and newline: a no-break space, form feed or em space
  // stays inside the delimiter word, and a `#` after one does not start a comment.
  ...[" ", "\f", " "].map((blank) => `cat <<'EOF'${blank}X\nx\nEOF\ncat <<'Q'\nEOF${blank}X\ngit reset --hard\nQ`),
  "echo a #$(git reset --hard)",
];
const STAYS_DENIED_ON_THE_MAIN_THREAD = [
  "bash<<'EOF'\ngit stash\nEOF",
  "cat <<'EOF' |\ngit stash\nEOF\nsh",
  ". /dev/stdin <<'EOF'\ngit stash\nEOF",
  "eval \"$(cat <<'EOF'\ngit stash\nEOF\n)\"",
  "$(cat <<'EOF'\ngit stash\nEOF\n)",
  "$(which git) stash",
  "`which git` stash",
  "$(command -v git) stash drop",
  "git $(echo stash)",
  "git \"$(printf stash)\" drop",
  "GIT=$(which git); $GIT stash",
  "echo a\\ #$(git stash)",
  "cat > f <<'EOF'\nstash\nEOF\ngit $(cat f)",
  "printf -v 'a[$(git stash)]' 1",
  "ls *(e:'$(git stash)':)",
  "((echo '$(git stash)') | sh)",
  "X=1 cat <<'EOF'\ngit stash\nEOF",
  "cat <<'EOF' | git -c alias.x='!sh' x\ngit stash\nEOF",
  "cat <<'EOF' > f\ngit stash\nEOF\ngit -c alias.x='!sh f' x",
  "cat > s.sh <<'EOF'\ngit stash\nEOF\n./s.sh",
  "node \"${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs\" --run r --task 3 --role implementer <<'EOF' | sh\ngit stash\nEOF",
  // A quoted heredoc inside a substitution is never data — `git $(cat <<'EOF' …)` would take its
  // subcommand from it — so the commit-message idiom that names stash stays denied; write the
  // message with `cat > <file> <<'EOF'` and commit it with `git commit -F <file>` in a second call.
  "git commit -m \"$(cat <<'EOF'\nfix: never run git stash during a cycle\nEOF\n)\"",
  "cat <<$'EOF'\nx\nEOF\ngit stash\n$EOF",
  "cat <<$\"EOF\"\nx\nEOF\ngit stash\n$EOF",
  "cat <<\"E\\\\OF\"\nx\nE\\OF\ngit stash\nE\\\\OF",
  ...[" ", "\f", " "].map((blank) => `cat <<'EOF'${blank}X\nx\nEOF\ncat <<'Q'\nEOF${blank}X\ngit stash\nQ`),
];

test("QC9: every spelling that runs a git through text the parser could read as data stays denied", () => {
  for (const cmd of STAYS_DENIED_FOR_A_REVIEWER)
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a reviewer: ${cmd}`);
  const cwd = cycleDir(stateAt("execution"));
  for (const cmd of STAYS_DENIED_ON_THE_MAIN_THREAD)
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny on the main thread: ${cmd}`);
});

test("a quoted heredoc body carrying non-ASCII prose that names git stays data", () => {
  assert.equal(decide(REVIEWER, "cat >> .devcycle/ledger.md <<'EOF'\n- task 3 → done — `git reset --hard` never ran (§ 4.A)\nEOF"), "allow");
  assert.equal(decideMain(cycleDir(stateAt("execution")), "cat > msg.md <<'EOF'\nfix: never run git stash → use git add -N — § 4.A\nEOF"), "allow");
});

test("only devcycle's own task-dispatch.mjs reads its heredoc as data", () => {
  const brief = " --run r --task 3 --role implementer <<'EOF'\ngit reset --hard\nEOF";
  const ownScript = join(dirname(HOOK), "..", "scripts", "task-dispatch.mjs");
  for (const script of ["\"${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs\"", "$CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs", ownScript])
    assert.equal(decide(REVIEWER, `node ${script}${brief}`), "allow", `expected allow for devcycle's task-dispatch: ${script}`);
  for (const cmd of [
    "mkdir -p scripts && cat > scripts/task-dispatch.mjs <<'A'\nrequire('child_process').execSync(require('fs').readFileSync(0, 'utf8'))\nA\nnode scripts/task-dispatch.mjs <<'B'\ngit reset --hard\nB",
    `node ./scripts/task-dispatch.mjs${brief}`,
    `node /nowhere/scripts/task-dispatch.mjs${brief}`,
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a task-dispatch.mjs that is not devcycle's: ${cmd}`);
  // The same command could first overwrite devcycle's own script, so it is trusted only run alone.
  const evil = "<<'A'\nrequire('child_process').execSync(require('fs').readFileSync(0, 'utf8'))\nA\n";
  for (const cmd of [
    `cat > "\${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs" ${evil}node "\${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs"${brief}`,
    `cat >${ownScript} ${evil}node ${ownScript}${brief}`,
    `tee $CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs ${evil}node $CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs${brief}`,
    `cat > $CLAUDE_PLUGIN_ROOT/scripts/task-dispatc?.mjs ${evil}node $CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs${brief}`,
    `node $CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs${brief.replace("<<'EOF'", "<<'EOF' >$CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs")}`,
  ])
    assert.equal(decide(REVIEWER, cmd), "deny", `expected deny for a command that can rewrite task-dispatch.mjs: ${cmd}`);
});

// A driver holding the checkout (spec 4.A.1): `live` takes the lock in this test process, alive for
// every spawn below; otherwise the lock names this pid with a start time it never had — a stale lock
// an earlier driver left behind.
function drivenDir({ live }) {
  const dir = cycleDir(stateAt("execution"));
  const statePath = join(dir, ".devcycle", "state.md");
  const logPath = join(dir, ".devcycle", "drive.log");
  if (live) assert.equal(acquireDriveLock(dir, { statePath, logPath }).ok, true);
  else writeFileSync(join(dir, ".devcycle", "drive.lock"),
    JSON.stringify({ pid: process.pid, startTime: "Thu Jan  1 00:00:00 1970", hostname: hostname(), state: statePath, log: logPath }));
  return dir;
}

const MOVES_OR_DESTROYS = ["git checkout main", "git checkout -b other", "git switch main", "git switch -c other",
  "git reset --hard", "git reset --hard HEAD~1", "git clean -f", "git clean -fdx", "git clean --force",
  "git -C . checkout dev", "cd sub && git checkout main", "(git switch main)", "sh -c 'git reset --hard'", "x=$(git checkout main)",
  "rtk git checkout main", "rtk proxy --ultra-compact git switch main"];
// The spellings the plan review found around the stash rule (coverage F1/F2), with a branch move in
// place of the stash: git and its subcommand on opposite sides of a substitution, and git fed to a
// shell through a heredoc that the parser must not read as data.
const MOVES_BEHIND_A_SUBSTITUTION_OR_HEREDOC = ["$(which git) checkout main", "git $(echo switch) main",
  "git \"$(printf checkout)\" main", "GIT=$(which git); $GIT reset --hard", "bash<<'EOF'\ngit checkout main\nEOF",
  "cat <<'EOF' |\ngit switch main\nEOF\nsh", "eval \"$(cat <<'EOF'\ngit reset --hard\nEOF\n)\"", ". /dev/stdin <<'EOF'\ngit clean -fd\nEOF"];

test("main thread + a live driver lock: moving the branch or destroying the tree is denied, and the reason says how to stop the driver", () => {
  const cwd = drivenDir({ live: true });
  for (const cmd of [...MOVES_OR_DESTROYS, ...MOVES_BEHIND_A_SUBSTITUTION_OR_HEREDOC, "echo $(git switch main"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny under a live driver lock: ${cmd}`);
  const { reason } = decideRaw({ cwd, tool_input: { command: "git checkout main" } });
  assert.match(reason, new RegExp(`^devcycle: a driver \\(pid ${process.pid}, log [^)]*drive\\.log\\) is running unattended execution in this checkout`));
  assert.match(reason, /Stop the driver first/);
  assert.match(reason, new RegExp(`if pid ${process.pid} is no longer running \\(after a reboot, say\\), remove \\.devcycle/drive\\.lock\\. command: git checkout main$`));
});

test("main thread + a live driver lock: reading, committing and restoring files stay allowed", () => {
  const cwd = drivenDir({ live: true });
  for (const cmd of ["git status", "git log --oneline -3", "git diff", "git add -A", "git commit -m x", "git checkout -- src/a.mjs",
    "git clean -n", "npm test", "echo 'git checkout main'",
    // A brief written through a quoted heredoc names git as data, substitution spelling included —
    // whether cat writes it or task-dispatch.mjs takes it on stdin.
    "cat > .devcycle/briefs/3-implementer.md <<'EOF'\nNever run `git checkout main` or $(git reset --hard).\nEOF",
    "node \"${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs\" --run 0123456789abcdef --task 3 --role implementer <<'EOF'\ngit checkout main is banned; so is `git reset --hard`.\nEOF"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow under a live driver lock: ${cmd}`);
});

test("main thread + a stale driver lock changes nothing", () => {
  const cwd = drivenDir({ live: false });
  for (const cmd of [...MOVES_OR_DESTROYS, ...MOVES_BEHIND_A_SUBSTITUTION_OR_HEREDOC])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow under a stale lock: ${cmd}`);
  assert.equal(decideMain(cwd, "git stash"), "deny", "the stash rule still holds");
});

test("a live driver lock leaves a dispatch's verdicts unchanged", () => {
  const cwd = drivenDir({ live: true });
  assert.equal(decideRaw({ agent_type: IMPLEMENTER, cwd, tool_input: { command: "git status" } }).decision, "allow");
  assert.equal(decideRaw({ agent_type: IMPLEMENTER, cwd, tool_input: { command: "git checkout -- x" } }).decision, "deny");
});

// A trailing backslash joins two lines into one command, so the shell runs `git reset --hard` from
// `git reset \⏎--hard`; splitting the text at the newline first read it as two harmless commands.
// A backslash ending a comment or sitting inside single quotes joins nothing. A heredoc body a shell
// runs is joined when that shell reads it, quoted or not.
test("a backslash-continued destructive git is read as the one command the shell runs", () => {
  const cwd = drivenDir({ live: true });
  for (const cmd of ["git reset \\\n--hard", "git \\\n  -C . \\\n  checkout main", "git clean \\\n-fdx", "git checkout \\\nmain",
    "git sw\\\nitch main", "# a note \\\ngit checkout main", "bash <<'EOF'\ngit reset \\\n--hard\nEOF", "bash <<EOF\ngit reset \\\n--hard\nEOF"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny under a live driver lock: ${JSON.stringify(cmd)}`);
  for (const cmd of ["echo 'a \\\ngit checkout main'", "bash <<'EOF'\n# a note \\\ngit status\nEOF"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow under a live driver lock: ${JSON.stringify(cmd)}`);
  const cycle = cycleDir(stateAt("execution"));
  for (const cmd of ["git \\\nstash", "git \\\nstash drop", "git -C . \\\n  stash"])
    assert.equal(decideMain(cycle, cmd), "deny", `expected deny for main-thread stash: ${JSON.stringify(cmd)}`);
  assert.equal(decideMain(cycle, "git \\\nstash list"), "allow");
});

// The driven session commits through task-commit.mjs, whose `--test-cmd` takes the repo's
// `TMPDIR=$(…)` form: a substitution that runs no git, feeding a command that is neither git nor a
// launcher, beside a test path that contains "git" and a subject naming a drive word. Denying it
// told the session to stop the driver it runs under. A substitution that runs git still trips the
// wire, whichever side of it the drive word sits on.
const TASK_COMMIT = "node \"${CLAUDE_PLUGIN_ROOT}/scripts/task-commit.mjs\" --task 3";
test("main thread + a live driver lock: the driven session's own task-commit call is allowed", () => {
  const cwd = drivenDir({ live: true });
  for (const cmd of [
    `${TASK_COMMIT} --test-cmd "export TMPDIR=$(mktemp -d); node --test tests/unit/block-destructive-git.test.mjs" --subject "fix(guard): deny checkout under a drive lock"`,
    `${TASK_COMMIT} --test-cmd "export TMPDIR=$(cd \\"$(mktemp -d /tmp/dc-XXXX)\\" && pwd -P); node --test tests/unit/block-destructive-git.test.mjs" --subject "fix(guard): deny switch under a drive lock"`,
    `${TASK_COMMIT} --test-cmd "export TMPDIR=$(mktemp -d); node --test tests/unit/task-commit.test.mjs" --subject "fix(commit): reset the git index on a refused commit"`,
  ])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow under a live driver lock: ${cmd}`);
  for (const cmd of [
    `${TASK_COMMIT} --test-cmd "$(git checkout main)" --subject "x"`,
    `${TASK_COMMIT} --test-cmd "$(git rev-parse HEAD)" --subject "fix(guard): deny checkout under a drive lock"`,
    "echo $(mktemp -d); git $(echo checkout) main",
  ])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny under a live driver lock: ${cmd}`);
});

test("main thread in a cycle: a git-free substitution beside text that names stash is allowed", () => {
  const cwd = cycleDir(stateAt("execution"));
  assert.equal(decideMain(cwd,
    `${TASK_COMMIT} --test-cmd "export TMPDIR=$(mktemp -d); node --test tests/unit/block-destructive-git.test.mjs" --subject "fix(guard): deny git stash in a cycle"`), "allow");
  for (const cmd of [`${TASK_COMMIT} --test-cmd "$(git stash)" --subject x`, "echo $(date); git $(echo stash)"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny for main-thread stash: ${cmd}`);
});

// git takes the next word as the value of -C, -c, --git-dir, --work-tree, --namespace,
// --super-prefix and --config-env; reading that value as the subcommand hid the real one. Its
// subcommands accept any unambiguous prefix of a long option (`--har` is `--hard`), and a clean
// deletes without -f whenever clean.requireForce is off, so only a dry run is not destructive.
test("main thread + a live driver lock: git's separate-value options, abbreviations and an unforced clean are seen", () => {
  const cwd = drivenDir({ live: true });
  for (const cmd of ["git --git-dir .git checkout main", "git --work-tree . reset --hard", "git --namespace x switch main",
    "git --super-prefix x/ checkout main", "git --config-env core.x=HOME clean -fd", "git reset --har", "git reset --h HEAD~1",
    "git clean --forc -d", "git clean --f", "git -c clean.requireForce=false clean -dx", "git clean -dx", "git clean -f -e -n",
    "git clean -fd -- -n", "git clean -n --no-dry-run -f", "git clean -fdx --exclude=/-n"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny under a live driver lock: ${cmd}`);
  for (const cmd of ["git clean -n", "git clean -nd", "git clean -dn", "git clean --dry-run -fdx", "git clean --dry -f", "git reset --soft HEAD~1",
    "git --git-dir .git log -1"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow under a live driver lock: ${cmd}`);
  assert.equal(decideMain(cycleDir(stateAt("execution")), "git --git-dir .git stash"), "deny");
  assert.equal(decide(REVIEWER, "git --git-dir .git status"), "allow");
  assert.equal(decide(REVIEWER, "git --work-tree . checkout -- x"), "deny");
});

// A checkout with paths after `--` restores files whatever comes before it; `-C` pointing outside
// the checkout the driver holds is another repository's business; a separator inside quotes ends
// no command.
test("main thread + a live driver lock: file restores, other repositories and quoted separators are allowed", () => {
  const cwd = drivenDir({ live: true });
  const other = cycleDir(null);
  for (const cmd of ["git checkout -q -- f", "git checkout HEAD -- f", "git checkout main -- a b", `git -C ${other} checkout main`,
    `git -C ${other} reset --hard`, "echo 'a; git checkout main'", "echo \"a; git reset --hard\"", "git commit -m 'wip; git switch main next'",
    "echo 'a\ngit checkout main'", "bash <<'EOF'\necho 'a; git checkout main'\nEOF"])
    assert.equal(decideMain(cwd, cmd), "allow", `expected allow under a live driver lock: ${cmd}`);
  for (const cmd of ["git checkout main --", `git -C ${other} -C ${cwd} checkout main`, "git -C sub checkout main", `git -C ${cwd}/sub/.. switch main`,
    "sh -c 'true; git checkout main'"])
    assert.equal(decideMain(cwd, cmd), "deny", `expected deny under a live driver lock: ${cmd}`);
});
