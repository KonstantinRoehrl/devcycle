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
// accepted bound per the 2026-09-02 design spec's § Parser robustness. Shell reserved
// words and process substitution are NOT a bound: a head that is a reserved word (`if`, `!`,
// `for … do`, `while … do`) is stripped until the real command is reached, and `<(`/`>(` are denied
// like backticks and `$(` — that spec's rule is that a missed destructive command is not acceptable.
// Scope is git-only; non-git commands (tests, greps) are allowed. Three dispatch origins are guarded
// by the allowlist — task-reviewer, red-team-reviewer and, since #235, implementer — and the main
// thread (no agent_type) is guarded for `git stash` alone, only while a .devcycle/state.md above the
// call's cwd reports a stage other than done. Every other origin is never guarded.
//
// STATED BOUNDS (deliberately not covered). This is a proportionate backstop against a cooperative
// dispatch running a plain destructive git, not a complete parser hardened against an adversary
// crafting evasions — the origins guarded here are Claude dispatches following a read-only contract,
// not a hostile shell. So the guard denies plain, quoted, wrapped, reserved-word and process-
// substitution spellings — the process-substitution family it denies is `<(`, `>(` and zsh's `=(` —
// and leaves these classes as ALLOW, each needing the shell itself to resolve: a shell EXPANSION
// that assembles the word `git` (`G=git; $G reset --hard`, `${x}git …`, `git${IFS}reset …`, zsh's
// `=git` EQUALS form), an ANSI-C `$'…'` body that spells it (`$'\x67it' …`), a shell FUNCTION or
// `case` label that hides it (`f(){ git reset; }; f`, `case x in *) git reset;; esac`), a
// metacharacter glued flush against a neighbour (`f(){`), and a git OBFUSCATED by a backslash or
// quote INSIDE a substitution (`` `gi\t reset` ``, `$(g\it reset)`) — the substitution detector is a
// raw-text `\bgit\b` tripwire, so it sees the plain spelling but not the broken-up one. Closing any
// of these needs a shell-grade tokenizer, whose maintenance cost outweighs the evasion it stops for
// this threat model; if the origins ever stop being cooperative, that trade is what to revisit.
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

// Clearly read-only git subcommands (unconditional).
const READ_ONLY = new Set([
  "diff", "log", "show", "status", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file",
  "describe", "grep", "shortlog", "merge-base", "rev-list", "name-rev", "for-each-ref",
  "diff-tree", "diff-index", "symbolic-ref", "whatchanged",
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
// reduce to one token before classification (deny-on-ambiguity depends on this being total). First
// drop every quote and backslash the shell resolves in-word BEFORE it runs the command — `"git"`,
// `g"i"t`, `g''it`, `\git`, `gi\t`, `\g\i\t` all name git — then strip a leading/trailing run of
// grouping tokens the whitespace split leaves glued to a group's edge (`(git`, `{git`, `stash)`,
// `git}`), then take the path basename (`/usr/bin/git`, `./git`). Removing a quote or backslash only
// ever makes MORE tokens reduce to `git`, never fewer, so it can add a deny but never drop one — and
// a genuinely different binary keeps its own name (`gitleaks` stays `gitleaks`, not `git`). What this
// does NOT resolve is an ANSI-C `$'…'` body or a shell expansion (`$G`, `${x}git`, `git${IFS}reset`):
// those need the shell itself and are the guard's stated bound below, not a backstopped case.
function normalizeHead(token) {
  let t = token.replace(/['"\\]/g, "");
  t = t.replace(/^[({]+/, "").replace(/[)}]+$/, "");
  const slash = t.lastIndexOf("/");
  return slash === -1 ? t : t.slice(slash + 1);
}

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
// the `<(`/`>(` process-substitution forms (audit 2026-09-05 H1), plus zsh's third form `=(…)`, are
// all denied when a git token is present anywhere in the command, whatever the subcommand. `=(` is
// matched only at word start or after whitespace so it catches the process-substitution spelling
// (`cat =(git reset)`) without tripping on an array assignment (`arr=(a b c); git diff`), whose `=(`
// is glued to a name — a raw `=(` there would wrongly deny a legitimate read-only git. On the main
// thread the same denial is scoped to commands that ALSO carry a `stash` token anywhere. Like the
// wrapper arm below, that scoping over-reaches — an unrelated `stash` word (a `--grep=stash`, an
// echoed word) beside any substituted git denies — which is the accepted cost of not parsing inside
// a substitution; the reason therefore states what was seen instead of asserting a stash was run.
// The detector is a raw-text tripwire (`\bgit\b`), not a normalized-token scan, so a git OBFUSCATED
// inside the substitution (`` `gi\t reset` ``, `$(g\it reset)`) is a stated bound above, not caught.
const hasSubstitution = /`|\$\(|<\(|>\(/.test(command) || /(^|\s)=\(/.test(command);
if (hasSubstitution && /\bgit\b/.test(command) && (guarded || /\bstash\b/.test(command)))
  deny(denyReason(
    "run git inside a command substitution (deny-on-ambiguity).",
    "this command names `stash` and runs git inside a command substitution, which can hide one (deny-on-ambiguity)."
  ));

// Shell reserved words that may precede a command inside one segment. They are neither a command
// nor a wrapper, so a segment whose head is one of them was skipped and the git after it never
// classified (`for f in a b; do git checkout -- "$f"; done`, `! git reset --hard`,
// `if git reset --hard; then :; fi` — audit 2026-09-05 H1). They are stripped until the real head
// is reached. `for`/`select` are loop headers: everything up to and including the `do` of the same
// segment carries no command, and when the `do` sits after a `;` (the usual spelling) the header
// segment is simply empty — the body `git …` is then its own segment and classifies as git.
const RESERVED = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "!", "{", "(", "}", ")"]);
const LOOP_HEADS = new Set(["for", "select"]);

// Drop leading env-assignments, grouping tokens, reserved words and loop headers so the head
// re-derives to the real command. Returns the remaining tokens (possibly none).
function stripLeading(tokens) {
  let t = tokens;
  for (;;) {
    if (!t.length) return t;
    const head = t[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || RESERVED.has(head)) { t = t.slice(1); continue; }
    if (LOOP_HEADS.has(head)) {
      const doAt = t.indexOf("do");
      t = doAt === -1 ? [] : t.slice(doAt + 1);
      continue;
    }
    return t;
  }
}

// Split on shell operators that separate commands; classify each segment independently. A lone `&`
// (background operator) separates commands just as `;` does, so `true & git reset --hard` must split
// into two segments — `&&` is matched first so a logical-AND is never mis-split on its first `&`.
for (const seg of command.split(/(?:&&|\|\||;|\||&|\n)/)) {
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
  let i = 1; // skip git's own global options and -C <dir> / -c <cfg> to reach the subcommand
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "-c") { i += 2; continue; }
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
