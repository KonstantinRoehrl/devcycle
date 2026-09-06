#!/usr/bin/env node
// PreToolUse Bash hook (#165): a guarded dispatch must never run a destructive git command
// against the shared checkout. agents/task-reviewer.md, agents/red-team-reviewer.md and
// agents/implementer.md carry a prose ban and references/evidence.md forbids `git stash`, but
// `tools:` still grants full Bash and nothing intercepts the call — prose is exactly what failed in
// the incident that destroyed an uncommitted round-2 diff. This is the structural backstop,
// mirroring hooks/block-main-thread-browser.mjs: origin is read from the hook input's agent_type
// (namespaced for a plugin agent, per docs/platform-notes.md § (e)); for a GUARDED dispatch origin
// a git invocation must reduce to an allowlisted read-only subcommand or the call is denied.
// Deny-on-ambiguity carries the safety within what the parser sees: a git it cannot confidently
// classify as read-only — a destructive subcommand,
// git behind a RECOGNIZED shell/exec wrapper (sh -c, xargs, eval, or a process/privilege/scheduling
// launcher in the bounded WRAPPERS set: setsid/sudo/exec/taskset/…), a `{ … }` group or `( … )`
// subshell, backticks, or a write-capable option (git diff --output=<file>) — is denied. The WRAPPERS
// set is a bounded launcher denylist: a git behind an UNLISTED head-position launcher is allowed, the
// accepted bound per the 2026-09-02 design spec's § Parser robustness. Shell syntax that merely sits
// in FRONT of a command is NOT a bound: a head that is a reserved word (`if`, `!`, `for … do`,
// `case … in`, `coproc`, `function`), a case pattern label (`*)`, `1)`), a function-definition head
// (`f()`, `f () {`), or a redirection (`>/dev/null git …`) is stripped until the real command is
// reached; a line continuation is joined before splitting; and `<(`/`>(` are denied like backticks
// and `$(` — that spec's rule is that a missed destructive command is not acceptable.
// Scope is git-only; non-git commands (tests, greps) are allowed. Three dispatch origins are guarded
// by the allowlist — task-reviewer, red-team-reviewer and, since #235, implementer — and the main
// thread (no agent_type) is guarded for `git stash` alone, only while a .devcycle/state.md at or
// above the call's cwd reports a stage other than done. Every other origin is never guarded.
import { readFileSync } from "node:fs";
import { findStateFile } from "./lib/find-state-file.mjs";

let input = {};
try {
  const parsed = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
} catch { /* malformed stdin → no origin → not a guarded dispatch → allow */ }

const rawAgentType = input.agent_type;
const agentType = typeof rawAgentType === "string" ? rawAgentType.trim() : "";

// The inverse of block-main-thread-browser.mjs's ALLOWED list: these origins are GUARDED. Both the
// bare frontmatter name and the <plugin>:<name> spelling the harness passes are pinned (stripping a
// prefix would admit another plugin's identically-named agent, widening a guard whose only job is to
// narrow). tests/unit/golden-path.test.mjs ties this list to the three agents' name: frontmatter, so
// a rename fails the suite instead of disarming. The implementer joined in #235: its contract was
// already read-only apart from `git add -N`, so one allowlist serves all three.
const GUARDED_AGENT_TYPES = ["task-reviewer", "devcycle:task-reviewer", "red-team-reviewer", "devcycle:red-team-reviewer", "implementer", "devcycle:implementer"];
const guarded = GUARDED_AGENT_TYPES.includes(agentType);

const allow = () => process.exit(0); // no output = defer to normal permission flow
const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

// Main thread (agent_type absent): only `git stash` is guarded, and only while a cycle is active —
// a stash discards every in-flight implementer's uncommitted edits across the shared checkout
// (#235). The active cycle is read the way hooks/workload-sensor.mjs reads it: walk upward from the
// hook input's cwd for .devcycle/state.md and take its stage: line. No state file, `stage: done`,
// or a malformed file → not in a cycle → allow. Everything else on the main thread stays
// unguarded: the coordinator legitimately commits, switches branches and merges.
function activeCycleStage() {
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const stateFile = findStateFile(cwd);
  if (!stateFile) return null;
  let stage;
  try { stage = readFileSync(stateFile, "utf8").match(/^- stage:\s*(\S+)/m)?.[1]; } catch { return null; }
  return stage && stage !== "done" ? stage : null;
}
const cycleStage = agentType === "" ? activeCycleStage() : null;
if (!guarded && cycleStage === null) allow();

const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";

// Every deny names its origin class and the offending spelling, so the transcript explains itself: a
// guarded dispatch is told what its allowlist forbids, the main thread which stash spelling tripped
// the cycle-scoped ban.
const denyReason = (guardedTail, mainThreadTail) =>
  (guarded
    ? `devcycle: reviewer/implementer dispatch (${agentType}) may not ${guardedTail}`
    : `devcycle: main thread may not run git stash while a devcycle cycle is active (stage: ${cycleStage}) — ${mainThreadTail}`) +
  ` command: ${command.slice(0, 200)}`;

// Clearly read-only git subcommands (unconditional). `symbolic-ref` is deliberately absent: with two
// arguments it REPOINTS HEAD in the shared checkout (`git symbolic-ref HEAD refs/heads/other`), and
// deny-on-ambiguity takes the whole subcommand rather than classifying its arguments — `rev-parse`
// covers the read use.
const READ_ONLY = new Set([
  "diff", "log", "show", "status", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file",
  "describe", "grep", "shortlog", "merge-base", "rev-list", "name-rev", "for-each-ref",
  "diff-tree", "diff-index", "whatchanged",
]);
// Command-LAUNCHERS that run their trailing arguments as a command, so a git after one is EXECUTED
// → deny-on-ambiguity when git appears. This is a bounded denylist (per the design's § Parser
// robustness): a head-position launcher NOT in this set is allowed — that is the accepted bound, not
// a backstopped case. There is no fallback that catches an unlisted launcher: the git-behind-wrapper
// check below only runs for a head in this set, so completeness of the set is what keeps a launched
// git from slipping through. A recognized wrapper hiding git, by contrast, is denied. The set is
// deliberately launchers only: commands that take `git` as a DATA argument (grep/echo/cat/rg/find/
// awk/sed) never execute it and MUST stay allowed, so a blanket "any segment containing a git token"
// is wrong. Covered: shell interpreters and exec/eval helpers (including the `exec` builtin), plus
// the common process/privilege/scheduling/sandbox launchers (setsid/sudo/doas/taskset/chrt/ionice/
// stdbuf/unshare/unbuffer/caffeinate/flock/strace/ltrace/proxychains/firejail/arch/chroot/runcon/
// catchsegv) that otherwise pass a destructive git straight through.
const WRAPPERS = new Set([
  "sh", "bash", "zsh", "dash", "eval", "exec", "xargs", "env", "command", "nice", "nohup", "time",
  "timeout", "watch", "setsid", "sudo", "doas", "taskset", "chrt", "ionice", "stdbuf", "unshare",
  "unbuffer", "caffeinate", "flock", "strace", "ltrace", "proxychains", "proxychains4", "firejail",
  "arch", "chroot", "runcon", "catchsegv",
]);

// Normalize a command head to the bare command name so alternate spellings of the same binary all
// reduce to one token before classification (deny-on-ambiguity depends on this being total): strip a
// leading run of grouping tokens, quotes and `$` (`(`/`{`/`\'`/`"`/`$` — the subshell/brace-group
// spelling `(git`/`{git`, the quoted spelling `"git"`, the ANSI-C quoted spelling `$'git` that
// `bash -c $'git reset --hard'` tokenizes to), then the same run at the end (`stash)`, `git}`,
// `stash'`, the closing char the whitespace split leaves glued to the last word of a group), then a
// single leading backslash (`\git`, the alias-bypass spelling), then the path basename
// (`/usr/bin/git`, `./git`). Whatever reduces to `git` is treated as git. Stripping only ever adds
// matches, so every extension here denies more, never less.
function normalizeHead(token) {
  let t = token.replace(/^[({'"$]+/, "").replace(/[)}'"]+$/, "").replace(/^\\/, "");
  const slash = t.lastIndexOf("/");
  return slash === -1 ? t : t.slice(slash + 1);
}

// git's own global options that take a VALUE. Written separated (`git --git-dir .git stash`) the
// value is a token of its own, so an option paired with nothing left the subcommand index on the
// VALUE: `.git` was compared against `stash` and the main-thread ban missed the stash, and a guarded
// origin's read-only `git --git-dir /r/.git log` was wrongly denied for the "subcommand" `/r/.git`.
// The attached spellings (`--git-dir=.git`) need no entry — the generic `-`-prefixed skip covers
// them. `--exec-path` and `--attr-source` also have valueless/attached uses; skipping a token that
// is not there just runs the index off the end, which classifies as an unreadable git → deny.
const VALUE_OPTIONS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env",
  "--super-prefix", "--attr-source",
]);

// A git segment is read-only iff its subcommand is confidently inspection-only.
function gitSegmentIsReadOnly(tokens, i) {
  const sub = tokens[i];
  if (sub === undefined) return false;          // bare `git` → not classifiable → deny
  const rest = tokens.slice(i + 1);
  // git's `--output=<file>` / `--output <file>` writes/overwrites that file, so a read-only
  // subcommand (the diff-generating family accepts it) carrying it is not inspection-only → deny.
  // Judge only this one write flag; deny-on-ambiguity backstops any other write option.
  if (rest.some((a) => a === "--output" || a.startsWith("--output="))) return false;
  if (READ_ONLY.has(sub)) return true;
  if (sub === "add") return rest.some((a) => a === "-N" || a === "--intent-to-add"); // the one carve-out
  if (sub === "config") return rest.some((a) => a === "--get" || a === "--get-all" || a === "--list" || a === "-l");
  if (sub === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "show";
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
  return false;                                  // everything else (checkout/reset/clean/stash/…) → deny
}

// Main-thread classification: only a stash subcommand other than `list`/`show` is denied. Both
// tokens go through normalizeHead for the same reason heads do — the whitespace split leaves a
// grouping char or a quote glued to them (`(git stash)` tokenizes as `stash)`, `git "stash"` as
// `"stash"`), and a raw comparison read those as "not stash" and allowed the one command this ban
// exists to stop (round-1 finding).
function stashIsDestructive(tokens, i) {
  if (normalizeHead(tokens[i] ?? "") !== "stash") return false;
  const op = normalizeHead(tokens[i + 1] ?? "");
  return !(op === "list" || op === "show");
}
// Behind a wrapper or substitution the main thread cannot see the subcommand either; a `stash`
// token next to a git token is denied on ambiguity (`sh -c 'git stash list'` included — the
// coordinator can run that directly). Same normalizer, so a quoted or grouped spelling counts.
const mentionsStash = (tokens) => tokens.some((t) => normalizeHead(t) === "stash");

// Command and process substitution can hide a git write we cannot classify: backticks, `$(`, and
// the `<(`/`>(` process-substitution forms (audit 2026-09-05 H1) are all denied when a git token
// is present anywhere in the command, whatever the subcommand. On the main thread the same denial
// is scoped to commands that ALSO carry a `stash` token anywhere. Like the wrapper arm below, that
// scoping over-reaches — an unrelated `stash` word (a `--grep=stash`, an echoed word) beside any
// substituted git denies — which is the accepted cost of not parsing inside a substitution; the
// reason therefore states what was seen instead of asserting a stash was run.
if (/`|\$\(|<\(|>\(/.test(command) && /\bgit\b/.test(command) && (guarded || /\bstash\b/.test(command)))
  deny(denyReason(
    "run git inside a command substitution (deny-on-ambiguity).",
    "this command names `stash` and runs git inside a command substitution, which can hide one (deny-on-ambiguity)."
  ));

// Shell reserved words that may precede a command inside one segment. They are neither a command
// nor a wrapper, so a segment whose head is one of them was skipped and the git after it never
// classified (`for f in a b; do git checkout -- "$f"; done`, `! git reset --hard`,
// `if git reset --hard; then :; fi` — audit 2026-09-05 H1; `case`/`esac`, `coproc` and `function`
// — branch review round 1). They are stripped until the real head is reached.
const RESERVED = new Set([
  "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "!", "{", "(", "}", ")",
  "esac", "coproc", "function",
]);
// Compound-command headers: everything up to and including the terminator token carries no command,
// so it is dropped wholesale. `for`/`select` end at `do`; `case` ends at `in`. When the terminator
// sits after a `;` or a newline (the usual spelling) the header segment is simply empty — the body
// `git …` is then its own segment and classifies as git.
const BLOCK_HEADS = new Map([["for", "do"], ["select", "do"], ["case", "in"]]);

// A head that classification itself keys off: the git binary, or a recognized wrapper. Every
// widening in stripLeading is gated on this, which is what keeps the "stripping only ever adds
// denies, never removes one" invariant true — a token that would have been classified is never
// consumed as syntax.
const isClassifiedHead = (token) => {
  const h = normalizeHead(token);
  return h === "git" || WRAPPERS.has(h);
};
// A redirection in front of a command (`>/dev/null git reset --hard`, `2>&1 git …`) is not a
// command, so the git behind it was never classified. A bare operator's target is the following
// token (`> /dev/null git …`) and is dropped with it; a glued target (`>/dev/null`, `2>&1`) is one
// token. Both forms are bounded to the leading-file-descriptor spelling the shell accepts.
const BARE_REDIRECTION = /^\d*(?:<{1,2}|>{1,2})$/;
const REDIRECTION = /^\d*[<>]/;
// A `case` arm's body sits behind its pattern label (`*)`, `1)`, `(*)`), and a function definition
// behind its head (`f()`, or `f` `()` / `f` `{` when the whitespace split separates them). Neither
// is a command, so the git after it was never classified. Both are bounded by shape — a token
// ending in `)`, or a token whose successor is `{`/`()` — and never applied to a classified head.
const isSyntaxLabel = (token) => /\)$/.test(token) && !isClassifiedHead(token);

// Drop leading env-assignments, grouping tokens, reserved words, compound-command headers,
// redirections, case labels and function-definition heads so the head re-derives to the real
// command. Returns the remaining tokens (possibly none).
function stripLeading(tokens) {
  let t = tokens;
  for (;;) {
    if (!t.length) return t;
    const head = t[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || RESERVED.has(head)) { t = t.slice(1); continue; }
    if (BLOCK_HEADS.has(head)) {
      const endAt = t.indexOf(BLOCK_HEADS.get(head));
      t = endAt === -1 ? [] : t.slice(endAt + 1);
      continue;
    }
    if (BARE_REDIRECTION.test(head)) { t = isClassifiedHead(t[1] ?? "") ? t.slice(1) : t.slice(2); continue; }
    if (REDIRECTION.test(head)) { t = t.slice(1); continue; }
    if (!isClassifiedHead(head) && (t[1] === "{" || t[1] === "()")) { t = t.slice(1); continue; }
    if (isSyntaxLabel(head)) { t = t.slice(1); continue; }
    return t;
  }
}

// Split on shell operators that separate commands; classify each segment independently. A lone `&`
// (background operator) separates commands just as `;` does, so `true & git reset --hard` must split
// into two segments — `&&` is matched first so a logical-AND is never mis-split on its first `&`.
// A backslash-newline is a line continuation, not a separator: joining it first keeps `git \`+newline
// +`stash pop` one command instead of a `git \` segment and an unrelated-looking `stash pop` one.
for (const seg of command.replace(/\\\r?\n/g, " ").split(/(?:&&|\|\||;|\||&|\n)/)) {
  // stripLeading drops env-assignments, `{`/`(` grouping tokens and reserved words so the head is
  // the real command — `{ git reset; }`, `( git reset )` and `do git reset` must not hide the git.
  // (normalizeHead additionally strips a grouping char glued to the head, e.g. `(git`.)
  const tokens = stripLeading(seg.trim().split(/\s+/).filter(Boolean));
  if (!tokens.length) continue;
  const head = normalizeHead(tokens[0]);
  if (WRAPPERS.has(head)) {
    // A wrapper's argument is often a quoted script (`sh -c 'git checkout -- x'`), so the naive
    // whitespace split leaves a quote character glued to the word (`'git`, `"git`), and a wrapper may
    // also name git by path — normalizeHead reduces every such spelling to `git` before comparing.
    if (tokens.slice(1).some((t) => normalizeHead(t) === "git") && (guarded || mentionsStash(tokens))) // git behind a wrapper we cannot see into
      deny(denyReason(
        "run git behind a shell wrapper (deny-on-ambiguity).",
        "a git behind a shell wrapper can hide one (deny-on-ambiguity)."
      ));
    continue; // a wrapper with no git (e.g. `timeout 30 npm test`) is a non-git command → allow
  }
  if (head !== "git") continue; // non-git command (basename never `git`) → allowed
  let i = 1; // skip git's own global options, including each one's separated value, to reach the subcommand
  while (i < tokens.length) {
    const t = tokens[i];
    if (VALUE_OPTIONS.has(t)) { i += 2; continue; }
    if (t.startsWith("-")) { i += 1; continue; }
    break;
  }
  const denied = guarded ? !gitSegmentIsReadOnly(tokens, i) : stashIsDestructive(tokens, i);
  if (denied)
    deny(denyReason(
      `run destructive/ambiguous git — guarded dispatches are read-only apart from \`git add -N\` (${tokens[i] ?? "git"}).`,
      `\`git ${normalizeHead(tokens[i] ?? "") || "stash"}\` discards every in-flight implementer's uncommitted edits across the shared checkout.`
    ));
}

allow();
