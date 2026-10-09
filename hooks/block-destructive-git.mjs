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
// subshell, a substitution that may run or feed a git, or a write-capable option (git diff
// --output=<file>) — is denied, and so is any git in text the guard cannot parse. The WRAPPERS
// set is a bounded launcher denylist: a git behind an UNLISTED head-position launcher is allowed, the
// accepted bound per the 2026-09-02 design spec's § Parser robustness. Shell reserved
// words and process substitution are NOT a bound: a head that is a reserved word (`if`, `!`,
// `for … do`, `while … do`) is stripped until the real command is reached, and `<(`/`>(` are denied
// like backticks and `$(` — that spec's rule is that a missed destructive command is not acceptable.
// Only what the shell can RUN is judged: on a line made entirely of commands that never run their
// arguments or input, a quoted heredoc body fed to cat/tee and single-quoted text are data (#276,
// #284), and `rtk` is a transparent launcher whose git is classified like any other.
// Scope is git-only; non-git commands (tests, greps) are allowed. Three dispatch origins are guarded
// by the allowlist — task-reviewer, red-team-reviewer and, since #235, implementer — and the main
// thread (no agent_type) is guarded for `git stash` while a .devcycle/state.md above the call's cwd
// reports a stage other than done, and for a branch-moving or tree-destroying git while a live driver
// lock sits beside that state file. Every other origin is never guarded.
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
// raw-text `\bgit\b` tripwire, so it sees the plain spelling but not the broken-up one — and a script
// or git configuration that a heredoc writes and git itself then runs (an alias, `core.pager`), or
// devcycle's own task-dispatch.mjs rewritten before the call that feeds it a brief, which the Write
// tool or a second Bash call could write just as well. Closing any
// of these needs a shell-grade tokenizer, whose maintenance cost outweighs the evasion it stops for
// this threat model; if the origins ever stop being cooperative, that trade is what to revisit.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findStateFile } from "./lib/find-state-file.mjs";
import { readLiveDriveLock } from "../scripts/drive-lock.mjs";

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
// unguarded — the coordinator legitimately commits, switches branches and merges — unless a driver
// holds the checkout (below).
const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
function activeCycleStage() {
  const stateFile = findStateFile(cwd);
  if (!stateFile) return null;
  let stage;
  try { stage = readFileSync(stateFile, "utf8").match(/^- stage:\s*(\S+)/m)?.[1]; } catch { return null; }
  return stage && stage !== "done" ? stage : null;
}
const cycleStage = agentType === "" ? activeCycleStage() : null;
// While a driver runs unattended execution here, it holds .devcycle/drive.lock beside the state
// file, and the checkout is its: the main thread of every session in it — driven or the user's
// own — may not move the branch or destroy the tree. A lock whose holder is gone changes nothing.
// The holder comes back with `root`, the checkout it holds.
function liveDriveLock() {
  const stateFile = findStateFile(cwd);
  if (!stateFile) return null;
  const root = dirname(dirname(stateFile));
  try {
    const holder = readLiveDriveLock(root);
    return holder && { ...holder, root };
  } catch {
    return null;
  }
}
const driveLock = agentType === "" ? liveDriveLock() : null;
if (!guarded && cycleStage === null && driveLock === null) allow();

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
// An argument loses its quotes and a glued closing group the way a head does, but keeps its path:
// `--exclude=/-n` is not `-n`.
const normalizeArg = (token) => token.replace(/['"\\]/g, "").replace(/[)}]+$/, "");

// git's global options that take the next word as their value (git.c's handle_options; each also
// has a `--opt=<value>` spelling, which is one word).
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
// Where a git segment's subcommand sits, past git's global options, and the `-C` dirs on the way.
function gitSubcommand(tokens) {
  const dirs = [];
  let i = 1;
  while (i < tokens.length && normalizeArg(tokens[i]).startsWith("-")) {
    const option = normalizeArg(tokens[i]);
    if (option === "-C") dirs.push(tokens[i + 1] ?? "");
    i += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  return { i, dirs };
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

// Under a live driver lock: a checkout or switch that can move the branch (a checkout with paths
// after `--` restores files and moves nothing), a hard reset, and a clean that is not a dry run —
// `clean.requireForce` may be off in any config or through `-c`, so a missing `-f` proves nothing.
// git's subcommands take any unambiguous prefix of a long option: `--har` is `--hard`.
const isLongOption = (arg, name, minLength = 1) => arg.length >= 2 + minLength && `--${name}`.startsWith(arg);
function cleanIsDryRun(options) {
  let dryRun = false;
  for (let k = 0; k < options.length; k += 1) {
    const a = options[k];
    if (/^-[qifdxX]*e$/.test(a) || isLongOption(a, "exclude")) k += 1; // the pattern is the next word
    else if (/^-[qifdxX]*n/.test(a) || isLongOption(a, "dry-run")) dryRun = true;
    else if (isLongOption(a, "no-dry-run", 4)) dryRun = false;
  }
  return dryRun;
}
function movesOrDestroys(tokens, i) {
  const sub = normalizeHead(tokens[i] ?? "");
  const rest = tokens.slice(i + 1).map(normalizeArg);
  const dashDash = rest.indexOf("--");
  const options = dashDash === -1 ? rest : rest.slice(0, dashDash);
  if (sub === "switch") return true;
  if (sub === "checkout") return dashDash === -1 || dashDash === rest.length - 1;
  if (sub === "reset") return options.some((a) => isLongOption(a, "hard"));
  if (sub === "clean") return !cleanIsDryRun(options);
  return false;
}
// `-C <dir>` runs git in another directory, each relative to the one before; a git sent outside
// the checkout the driver holds cannot move its branch or touch its tree.
function insideDriveRoot(dirs) {
  const target = realPath(resolve(cwd, ...dirs.map(normalizeArg)));
  const root = realPath(driveLock.root);
  return target === root || target.startsWith(root + sep);
}
// Behind a wrapper or a substitution the subcommand is out of sight: any of these words in a command
// that runs git is denied, the way the stash rule reads the word `stash`.
const DRIVE_WORDS = new Set(["checkout", "switch", "reset", "clean"]);
const DRIVE_WORD = /\b(?:checkout|switch|reset|clean)\b/;
const mentionsDriveWord = (tokens) => tokens.some((t) => DRIVE_WORDS.has(normalizeHead(t)));
const driveDenyReason = () =>
  `devcycle: a driver (pid ${driveLock.pid}, log ${driveLock.log}) is running unattended execution in this checkout — ` +
  "the main thread may not move the branch or destroy the working tree while it runs. Stop the driver first " +
  `(Ctrl-C in its terminal, or kill ${driveLock.pid}), or run git from your own terminal. command: ${command.slice(0, 200)}`;

// A heredoc, a quote or a substitution decides whether a `git` in the text is RUN or only READ, and
// the substitution tripwire used to tell neither apart: "a substitution token anywhere plus the word
// git anywhere" also denied every note and findings file that merely NAMED a git command beside a
// backtick (#276, #284). scanShell parses just enough shell to separate the two. It tracks single
// quotes and ANSI-C `$'…'` (nothing is substituted inside them), double quotes, backslash escapes,
// `#` comments (only at the start of a word), every substitution form — `$(…)`, arithmetic `$((…))`
// and `$[…]`, backticks, `<(…)`, `>(…)` and zsh's `=(…)` at the start of a word — nested to any
// depth, `${…}` and `((…))` (inside which `<<` is a shift, never a heredoc), and heredocs: `<<WORD`
// and `<<-WORD`, a quoted WORD (`'EOF'`, `"EOF"`, `\EOF`) meaning the body is not expanded; `<<<` is
// a here-string. It returns null when the text does not parse — an unterminated quote, substitution,
// expansion or heredoc, a heredoc whose delimiter word does not decode to plain `[A-Za-z0-9_.-]`
// characters (`$'EOF'`, `${X Y}`, `"E\\OF"`, `EOF<U+00A0>X`) — and otherwise:
//   substitutions — every substitution at any depth, those an unquoted heredoc body expands included,
//                   as { start, end, inner, top, segment }: `top` when it sits in the command line
//                   itself (not inside another substitution or a heredoc body), `segment` then being
//                   the index of the command it belongs to;
//   heredocs      — { start, end, quoted, top, segment }, [start, end) spanning the body and its
//                   delimiter line;
//   singleQuotes  — the [start, end) spans of the command line's single-quoted text;
//   doubleQuotes  — the same for its double-quoted text;
//   continuations — where a backslash-newline outside a substitution joins two lines into one, in
//                   the command line or an unquoted heredoc body (the shell drops the pair; inside
//                   single quotes, a comment or a quoted heredoc body it joins nothing);
//   segments      — the command line's commands as { start, end, sep }, `sep` the operator that ends
//                   each (`|`, `&&`, `;`, a newline, …; "" for the last);
//   complex       — whether the text carries a `${…}` other than a plain `${NAME}`, a `((`, a `(`
//                   glued to a word, or a `)` no `(` opened: each can run code no command head shows
//                   (a zsh glob qualifier `*(e:…:)`, a function definition, `((…))` read as nested
//                   subshells), and a stray `)` is a `case` label that closed a substitution early.
const UNPARSABLE = Symbol("unparsable");
const PLAIN_PARAMETER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/y;
// The shells split words only on these blanks, and end one at an operator character.
const SHELL_BLANKS = /[ \t\n]+/;
const WORD_END = /[ \t\n;&|<>()]/;
const SAFE_DELIMITER = /^[A-Za-z0-9_.-]+$/;
function scanShell(text) {
  const substitutions = [];
  const heredocs = [];
  const singleQuotes = [];
  const doubleQuotes = [];
  const continuations = [];
  const segments = [];
  let complex = false;
  let pending = [];
  let segmentStart = 0;
  let groups = 0;
  let nesting = 0;
  let inBody = false;
  let i = 0;
  const fail = () => { throw UNPARSABLE; };
  const atTop = () => nesting === 0 && !inBody;

  function substitution(openLength, closer, kind) {
    const start = i;
    const top = atTop();
    const segment = segments.length;
    i += openLength;
    const innerStart = i;
    nesting += 1;
    walk(closer, kind);
    nesting -= 1;
    substitutions.push({ start, end: i, inner: text.slice(innerStart, i - 1), top, segment });
  }
  function parameter() {
    PLAIN_PARAMETER.lastIndex = i;
    if (!PLAIN_PARAMETER.test(text)) complex = true;
    i += 2;
    walk("}", "parameter");
  }
  function singleQuoted(ansiC) {
    const start = i;
    i += ansiC ? 2 : 1;
    while (i < text.length && text[i] !== "'") i += ansiC && text[i] === "\\" ? 2 : 1;
    if (i >= text.length) fail();
    i += 1;
    if (atTop()) singleQuotes.push([start, i]);
  }
  // The `$`-forms shared by every context that expands them: double quotes, an unquoted heredoc
  // body and a command line. Returns false when the text at i is none of them.
  function dollarForm() {
    if (text.startsWith("$((", i)) substitution(2, ")", "arithmetic");
    else if (text.startsWith("$(", i)) substitution(2, ")", "command");
    else if (text.startsWith("$[", i)) substitution(2, "]", "arithmetic");
    else if (text.startsWith("${", i)) parameter();
    else if (text[i] === "`") substitution(1, "`", "command");
    else return false;
    return true;
  }
  function escaped() {
    if (text[i + 1] === "\n" && nesting === 0) continuations.push(i);
    i += 2;
  }
  function doubleQuoted() {
    const start = i;
    i += 1;
    while (i < text.length) {
      if (text[i] === "\\") escaped();
      else if (text[i] === '"') {
        i += 1;
        if (atTop()) doubleQuotes.push([start, i]);
        return;
      }
      else if (!dollarForm()) i += 1;
    }
    fail();
  }
  // The delimiter word ends where the shell's does, at a blank (space, tab, newline — never another
  // Unicode space) or an operator, and is decoded by quote removal alone. Bash and zsh decode more in
  // places — `$'…'`, `$"…"`, `${X Y}` read as one word, a backslash inside double quotes — and could
  // then end the body at a line the scanner reads past, so a word that does not decode to
  // SAFE_DELIMITER's plain characters is unparsable.
  function heredocIntroducer() {
    const top = atTop();
    const segment = segments.length;
    i += 2;
    const stripTabs = text[i] === "-";
    if (stripTabs) i += 1;
    while (text[i] === " " || text[i] === "\t") i += 1;
    let delimiter = "";
    let quoted = false;
    while (i < text.length && !WORD_END.test(text[i])) {
      const c = text[i];
      if (c === "'" || c === '"') {
        const end = text.indexOf(c, i + 1);
        if (end === -1) fail();
        delimiter += text.slice(i + 1, end);
        quoted = true;
        i = end + 1;
      } else if (c === "\\") {
        delimiter += text[i + 1] ?? "";
        quoted = true;
        i += 2;
      } else {
        delimiter += c;
        i += 1;
      }
    }
    if (!SAFE_DELIMITER.test(delimiter)) fail();
    pending.push({ delimiter, stripTabs, quoted, top, segment });
  }
  // Inside an unquoted heredoc body only `\` and the `$`-forms are special: quotes are literal.
  function expandingBody(end) {
    inBody = true;
    while (i < end) {
      if (text[i] === "\\") escaped();
      else if (!dollarForm()) i += 1;
      if (i > end) fail();
    }
    inBody = false;
  }
  // At the newline ending a command line, each heredoc that line introduced takes the lines up to
  // its delimiter line as its body.
  function readBodies() {
    const queue = pending;
    pending = [];
    for (const doc of queue) {
      const start = i;
      for (;;) {
        if (i >= text.length) fail();
        const eol = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
        const line = text.slice(i, eol);
        if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
          const bodyEnd = i;
          const end = Math.min(eol + 1, text.length);
          heredocs.push({ start, end, quoted: doc.quoted, top: doc.top, segment: doc.segment });
          if (!doc.quoted) {
            i = start;
            expandingBody(bodyEnd);
          }
          i = end;
          break;
        }
        i = eol + 1;
      }
    }
  }
  // A `;`, `&` or `|` that separates commands; `>&`, `<&`, `&>` and `>|` are redirections.
  function separator() {
    const c = text[i];
    if (c === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) return "";
    if (c === "|" && text[i - 1] === ">") return "";
    const two = text.slice(i, i + 2);
    return ["&&", "||", "|&", ";;", ";&"].includes(two) ? two : c;
  }
  // Walks to the end of the current frame: the whole text (closer null), the `)` closing a `$(`-style
  // substitution or `((`, the `]` closing `$[`, the `}` closing `${`, or the backtick closing a pair.
  // `kind` is "command" where commands run (comments and heredocs exist only there), "arithmetic" or
  // "parameter".
  function walk(closer, kind) {
    const opener = { ")": "(", "]": "[", "}": "{" }[closer];
    let depth = 0;
    let wordStart = true;
    while (i < text.length) {
      const c = text[i];
      const word = wordStart;
      wordStart = false;
      if (c === "\\") { escaped(); continue; }
      if (closer === "`" && c === "`") { i += 1; return; }
      if (opener && c === opener) { depth += 1; i += 1; continue; }
      if (opener && c === closer) {
        i += 1;
        if (depth === 0) return;
        depth -= 1;
        continue;
      }
      if (kind === "command" && c === "#" && word) {
        const eol = text.indexOf("\n", i);
        i = eol === -1 ? text.length : eol;
        wordStart = true;
        continue;
      }
      if (c === "'") singleQuoted(false);
      else if (c === "$" && text[i + 1] === "'") singleQuoted(true);
      else if (c === '"') doubleQuoted();
      else if (dollarForm()) { /* consumed */ }
      else if (text.startsWith("<<<", i)) i += 3;
      else if (text.startsWith("<<", i)) {
        if (kind === "command") heredocIntroducer();
        else i += 2;
      } else if (text.startsWith("<(", i) || text.startsWith(">(", i)) substitution(2, ")", "command");
      else if (text.startsWith("=(", i) && word) substitution(2, ")", "command");
      else if (text.startsWith("((", i) && word && kind === "command") {
        complex = true;
        i += 1;
        walk(")", "arithmetic");
      } else if (c === "\n") {
        if (closer === null) segments.push({ start: segmentStart, end: i, sep: "\n" });
        i += 1;
        if (pending.length) readBodies();
        if (closer === null) segmentStart = i;
        wordStart = true;
      } else if (closer === null && (c === ";" || c === "&" || c === "|") && separator()) {
        const sep = separator();
        segments.push({ start: segmentStart, end: i, sep });
        i += sep.length;
        segmentStart = i;
        wordStart = true;
      } else {
        if (closer === null && c === "(") {
          if (!word) complex = true;
          groups += 1;
        } else if (closer === null && c === ")") {
          if (groups === 0) complex = true;
          else groups -= 1;
        }
        wordStart = WORD_END.test(c);
        i += 1;
      }
    }
    if (closer !== null) fail();
  }

  try {
    walk(null, "command");
    if (pending.length) fail();
  } catch (e) {
    if (e === UNPARSABLE) return null;
    throw e;
  }
  segments.push({ start: segmentStart, end: text.length, sep: "" });
  return { substitutions, heredocs, singleQuotes, doubleQuotes, continuations, segments, complex };
}

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

// RTK, the token-saving CLI proxy, rewrites `git status` to `rtk git status` in its own PreToolUse
// hook, and an agent may type that form itself, so `rtk` is a transparent launcher (per `rtk --help`):
// `rtk [opts] git …` runs that git; `proxy`, `err`, `test` and `summary` run the command after their
// own options; `rtk run …` runs its arguments through `sh -c`. Every other rtk subcommand filters one
// named tool, so a `git` after it is data (`rtk grep git src`).
const RTK_LAUNCHERS = new Set(["proxy", "err", "test", "summary"]);
function unwrapRtk(tokens) {
  if (normalizeHead(tokens[0] ?? "") !== "rtk") return tokens;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
  const sub = normalizeHead(tokens[i] ?? "");
  if (sub === "run") return ["sh", ...tokens.slice(i + 1)];
  if (RTK_LAUNCHERS.has(sub)) {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
    return unwrapRtk(tokens.slice(i));
  }
  return sub === "git" ? tokens.slice(i) : tokens;
}

// Shell operators that separate commands; each segment is classified independently. A lone `&`
// (background operator) separates commands just as `;` does, so `true & git reset --hard` must split
// into two segments — `&&` is matched first so a logical-AND is never mis-split on its first `&`.
const SEPARATORS = /(?:&&|\|\||;|\||&|\n)/;
// stripLeading drops env-assignments, `{`/`(` grouping tokens and reserved words so the head is
// the real command — `{ git reset; }`, `( git reset )` and `do git reset` must not hide the git.
// (normalizeHead additionally strips a grouping char glued to the head, e.g. `(git`.)
const segmentTokens = (segment) => unwrapRtk(stripLeading(segment.trim().split(/\s+/).filter(Boolean)));

function classifySegments(text) {
  for (const segment of text.split(SEPARATORS)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length) continue;
    const head = normalizeHead(tokens[0]);
    if (WRAPPERS.has(head)) {
      // A wrapper's argument is often a quoted script (`sh -c 'git checkout -- x'`), so the naive
      // whitespace split leaves a quote character glued to the word (`'git`, `"git`), and a wrapper may
      // also name git by path — normalizeHead reduces every such spelling to `git` before comparing.
      if (!guarded && driveLock !== null && tokens.slice(1).some((t) => normalizeHead(t) === "git") && mentionsDriveWord(tokens))
        return driveDenyReason();
      if (tokens.slice(1).some((t) => normalizeHead(t) === "git") && (guarded || mentionsStash(tokens))) // git behind a wrapper we cannot see into
        return denyReason(
          "run git behind a shell wrapper (deny-on-ambiguity).",
          "a git behind a shell wrapper can hide one (deny-on-ambiguity)."
        );
      continue; // a wrapper with no git (e.g. `timeout 30 npm test`) is a non-git command → allow
    }
    if (head !== "git") continue; // non-git command (basename never `git`) → allowed
    const { i, dirs } = gitSubcommand(tokens);
    if (!guarded && driveLock !== null && movesOrDestroys(tokens, i) && insideDriveRoot(dirs)) return driveDenyReason();
    const denied = guarded ? !gitSegmentIsReadOnly(tokens, i) : stashIsDestructive(tokens, i);
    if (denied)
      return denyReason(
        `run destructive/ambiguous git — guarded dispatches are read-only apart from \`git add -N\` (${tokens[i] ?? "git"}).`,
        `\`git ${normalizeHead(tokens[i] ?? "") || "stash"}\` discards every in-flight implementer's uncommitted edits across the shared checkout.`
      );
  }
  return null;
}

// What a command can do with text it carries as DATA — a quoted heredoc body, single-quoted text —
// is decided by every command on its line, not by the one that reads it: `cat <<'EOF' | sh`,
// `cat <<'EOF' > s.sh` + `bash s.sh`, `eval "$(cat <<'EOF' …)"` and `printf '…' | xargs git` all run
// the data. So data counts as data only on a line made entirely of INERT commands — commands that
// never execute an argument or their input — with no substitution, no `${…}` beyond `${NAME}` and
// no `(` glued to a word (scanShell's `complex`), and no leading assignment (`GIT_*=`, `PAGER=`,
// `BASH_ENV=` change what a later command runs). git is inert only with a read-only subcommand or
// `add`, and without `-c`/`--config-env`/`--exec-path`, which make it run a command; printf only
// without `-v`, which assigns (and evaluates an array subscript); `test`/`[` never, for the same
// reason. Anything else is read exactly as before this parser existed.
const INERT_COMMANDS = new Set(["cat", "tee", "echo", "printf", "mkdir", "touch", "ls", "wc", "head", "tail", "grep", "cd", "pwd", "true"]);
// The heredoc readers: they copy the body to a file or to the output and nothing else. devcycle's
// own task-dispatch.mjs is one too, run alone — it writes the brief it reads on stdin to .devcycle/briefs/.
const HEREDOC_READERS = new Set(["cat", "tee"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PIPES = new Set(["|", "|&"]);
// A command name with any redirection glued to it dropped (`cat>f`, `bash<<'EOF'`).
const commandName = (token) => normalizeHead(token.split(/[<>]/)[0]);
// Only devcycle's own script is that reader: named through the plugin-root variable, or by the
// absolute path the playbooks render that variable to — this hook's own plugin root — and run as the
// whole command with no redirection. Any other task-dispatch.mjs may be one the same command just
// wrote, and a command that also writes a file (`cat > …`, `tee`, a glob) may rewrite this one first.
const PLUGIN_ROOT_TASK_DISPATCH = new Set(["${CLAUDE_PLUGIN_ROOT}/scripts/task-dispatch.mjs", "$CLAUDE_PLUGIN_ROOT/scripts/task-dispatch.mjs"]);
const realPath = (path) => { try { return realpathSync(path); } catch { return path; } };
const OWN_TASK_DISPATCH = realPath(fileURLToPath(new URL("../scripts/task-dispatch.mjs", import.meta.url)));
function isTaskDispatch(tokens) {
  if (commandName(tokens[0]) !== "node") return false;
  const script = (tokens[1] ?? "").replace(/['"\\]/g, "");
  return PLUGIN_ROOT_TASK_DISPATCH.has(script) || (isAbsolute(script) && realPath(script) === OWN_TASK_DISPATCH);
}
// The segment running devcycle's task-dispatch.mjs when it is the command's only command and carries
// no redirection; null otherwise.
function loneTaskDispatch(text, scan) {
  const commands = scan.segments.filter((segment) => scannedTokens(text, segment).tokens.length);
  if (commands.length !== 1) return null;
  const [only] = commands;
  return !text.slice(only.start, only.end).includes(">") && isTaskDispatch(scannedTokens(text, only).tokens) ? only : null;
}
function gitIsInert(tokens) {
  const { i } = gitSubcommand(tokens);
  const runsACommand = (option) => option === "-c" || option.startsWith("--config-env") || option.startsWith("--exec-path");
  if (tokens.slice(1, i).map(normalizeArg).some(runsACommand)) return false;
  const sub = normalizeHead(tokens[i] ?? "");
  return READ_ONLY.has(sub) || sub === "add";
}
function isInert(tokens) {
  const name = commandName(tokens[0]);
  if (name === "git") return gitIsInert(tokens);
  if (name === "printf") return !tokens.includes("-v");
  return INERT_COMMANDS.has(name);
}
// The tokens of a scanned segment, split as the shell splits words, and whether stripLeading dropped
// an assignment on the way. (segmentTokens' wider `\s` split is the conservative one for finding a
// git; here a word the shell keeps whole, `cat<U+00A0>x`, must not read as the inert `cat`.)
function scannedTokens(text, { start, end }) {
  const raw = text.slice(start, end).split(SHELL_BLANKS).filter(Boolean);
  const tokens = stripLeading(raw);
  return { tokens: unwrapRtk(tokens), assigns: raw.slice(0, raw.length - tokens.length).some((t) => ASSIGNMENT.test(t)) };
}
function lineIsInert(text, scan) {
  if (scan.substitutions.length || scan.complex) return false;
  const dispatch = loneTaskDispatch(text, scan);
  return scan.segments.every((segment) => {
    const { tokens, assigns } = scannedTokens(text, segment);
    return !assigns && (!tokens.length || segment === dispatch || isInert(tokens));
  });
}
// A heredoc's body is data when its reader is a heredoc reader and every command its output is piped
// into is one too (a pipe carries on past a line break: `cat <<'EOF' |` + body + `tee f`).
function readOnlyAsData(text, scan, k) {
  const isReader = (j) => {
    const { tokens } = scannedTokens(text, scan.segments[j]);
    return tokens.length > 0 && (HEREDOC_READERS.has(commandName(tokens[0])) || scan.segments[j] === loneTaskDispatch(text, scan));
  };
  if (!isReader(k)) return false;
  for (let j = k; PIPES.has(scan.segments[j].sep); ) {
    j += 1;
    while (scan.segments[j].sep === "\n" && !scannedTokens(text, scan.segments[j]).tokens.length) j += 1;
    if (!isReader(j)) return false;
  }
  return true;
}

// A substitution that names no git and whose output only becomes arguments of a command that is
// neither git nor a launcher cannot run or assemble a git that the same command with that output
// written out literally would not show the segment classifier — so it no longer trips the wire
// (#276: `git diff --stat -- f; echo "checked at $(date)"`), whatever else that command's words
// name: a driven session's `task-commit.mjs --test-cmd "TMPDIR=$(mktemp -d); node --test
// tests/unit/block-destructive-git.test.mjs" --subject "…checkout…"` runs no git through it. Every
// other substitution keeps the wire over the whole command, where git and its subcommand may sit on
// opposite sides of it (`$(which git) stash`, `git $(echo stash)`). A `complex` line keeps it too:
// there the scanner's view of where a substitution ends may not be the shell's. So does a command
// that stores its arguments or input in a variable a later `git $x` would read.
const SETS_VARIABLES = new Set(["read", "mapfile", "readarray", "declare", "typeset", "local", "export", "readonly", "let", "getopts", "vared"]);
function harmlessSubstitution(text, scan, sub) {
  if (scan.complex || !sub.top || /\bgit\b/.test(sub.inner)) return false;
  const { tokens, assigns } = scannedTokens(text, scan.segments[sub.segment]);
  if (assigns || !tokens.length || /[$`]/.test(tokens[0])) return false;
  const name = normalizeHead(tokens[0]);
  if (SETS_VARIABLES.has(name) || (name === "printf" && tokens.includes("-v"))) return false;
  return /^[\w.+-]+$/.test(name) && name !== "git" && name !== "source" && name !== "." && !WRAPPERS.has(name);
}

// Text with each [start, end) span replaced (spans may nest; an inner one is dropped with its outer).
function replaceSpans(text, spans) {
  let out = "";
  let from = 0;
  for (const [start, end, replacement] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (start < from) continue;
    out += text.slice(from, start) + replacement;
    from = end;
  }
  return out + text.slice(from);
}

// The substitution tripwire, unchanged in what it matches: a substitution token plus the word git
// (and, on the main thread, the word stash) — but over the text minus what is proven data or
// harmless, not over the raw command. It is a raw-text `\bgit\b` match, not a normalized-token scan,
// so a git OBFUSCATED inside a substitution (`` `gi\t reset` ``, `$(g\it reset)`) is a stated bound
// above, not caught.
const SUBSTITUTION_TOKEN = /`|\$\(|<\(|>\(|(?:^|\s)=\(/;
function substitutionTripwire(text) {
  if (!SUBSTITUTION_TOKEN.test(text) || !/\bgit\b/.test(text)) return null;
  if (!guarded && driveLock !== null && DRIVE_WORD.test(text)) return driveDenyReason();
  if (!guarded && !/\bstash\b/.test(text)) return null;
  return denyReason(
    "run git inside a command substitution (deny-on-ambiguity).",
    "this command names `stash` and runs git inside a command substitution, which can hide one (deny-on-ambiguity)."
  );
}

// The verdict on one command text: a deny reason, or null to allow. Text that does not parse is
// denied when it names git (on the main thread: git and stash) and otherwise classified as raw text,
// so every spelling the normalizer already denies (`g"i"t reset`, `\git …`) stays denied.
function verdict(text) {
  const scan = scanShell(text);
  if (!scan) {
    if (!guarded && driveLock !== null && /\bgit\b/.test(text) && DRIVE_WORD.test(text)) return driveDenyReason();
    if (/\bgit\b/.test(text) && (guarded || /\bstash\b/.test(text)))
      return denyReason(
        "run git in a command the guard cannot parse — an unterminated quote, substitution or heredoc (deny-on-ambiguity).",
        "this command names `stash` and git in text the guard cannot parse — an unterminated quote, substitution or heredoc (deny-on-ambiguity)."
      );
    return classifySegments(text);
  }
  const inert = lineIsInert(text, scan);
  const dataDocs = inert ? scan.heredocs.filter((doc) => doc.quoted && readOnlyAsData(text, scan, doc.segment)) : [];
  const dataBodies = dataDocs.map((doc) => [doc.start, doc.end, ""]);
  const ignored = inert
    ? [...dataBodies, ...scan.singleQuotes.map(([start, end]) => [start, end, "''"])]
    : scan.substitutions.filter((sub) => harmlessSubstitution(text, scan, sub)).map((sub) => [sub.start, sub.end, ""]);
  const shellJoins = shellJoinSpans(text, scan, 0, (doc) => dataDocs.includes(doc));
  return substitutionTripwire(replaceSpans(text, ignored)) ?? classifySegments(replaceSpans(text, [...dataBodies, ...shellJoins]));
}

// The segment classifier splits on raw separators; these spans make it end a command only where the
// shell does: each line continuation joined and each separator inside quotes blanked (a substitution
// in double quotes is the tripwire's to judge) — in the command line and in every heredoc body not
// proven data, which a shell may yet run as a script.
function shellJoinSpans(text, scan, offset, isData) {
  const spans = scan.continuations.map((k) => [offset + k, offset + k + 2, ""]);
  for (const [start, end] of [...scan.singleQuotes, ...scan.doubleQuotes])
    for (let k = start; k < end; k += 1) if (/[;&|\n]/.test(text[k])) spans.push([offset + k, offset + k + 1, " "]);
  for (const doc of scan.heredocs) {
    if (!doc.top || isData(doc)) continue;
    const bodyText = text.slice(doc.start, doc.end);
    const body = scanShell(bodyText);
    if (body) spans.push(...shellJoinSpans(bodyText, body, offset + doc.start, () => false));
  }
  return spans;
}

const reason = verdict(command);
if (reason) deny(reason);
allow();
