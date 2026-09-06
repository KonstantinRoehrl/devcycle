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
// reached, and `<(`/`>(` are denied like backticks and `$(` — that spec's rule is that a missed
// destructive command is not acceptable.
//
// CANONICALIZE, THEN CLASSIFY (branch review round 4). The parser used to split on whitespace, which
// gave every rule keyed to a token boundary a twin spelling where the metacharacter sits flush
// against its neighbour — `f() {` vs `f(){` vs `f (){`, `2>&1` vs `2>& 1` — and three review rounds
// running closed one twin and left the next open. Enumerating them is unbounded, so the command is
// TOKENIZED first (tokenizeCommand) and only then split into segments and classified: every `(`,
// `)`, `;`, `&`, `|`, redirection operator and standalone `{`/`}` that is shell SYNTAX becomes a
// token of its own, while the same character inside `'…'`, `"…"`, `$'…'` or behind a backslash stays
// DATA. `f(){`, `f (){`, `f() {` and `f () {` all reduce to one stream (`f` `(` `)` `{`), so the
// class is closed as a class. Canonicalization runs to the WORD level, not just the token's ends:
// quoting and escapes written INSIDE a word (`gi\t`, `"g"'it'`, `g""it`, `g$'it'`) are what the
// shell resolves before it runs `git`, so normalizeHead resolves them the same way — dropping the
// quote characters, and DECODING the escapes an ANSI-C quote spells its characters with, so
// `$'\x67it'` reduces to `git` (round 8) while `$'gi\t'` stays `gi<TAB>`, which is not a command any
// shell has (round 6, round 8). The one resolution that is deliberately NOT done at the word level is
// a backslash-newline inside `'…'`: this shell keeps both characters literal, so joining the halves
// here would invent a git out of a command name that carries them — the wrapper check joins them
// instead, because that is where an inner shell genuinely re-reads the text (round 8, fix round).
// Telling a duplication's `&` (`2>&1`) from a background `&` is part of that tokenization — the
// descriptor and the `&` are glued into one redirection operator token — so
// a bare `&` token is always a command separator and the segment splitter needs no lookbehind.
// A case pattern label is dropped before segments are formed, because an alternated label spans the
// `|` the splitter cuts on. An unterminated quote is ambiguous, so the command is re-read with
// quoting disabled: the syntax the dangling quote would have hidden is still classified.
// The one place canonicalization deliberately classifies LESS is a heredoc body (`cat <<'EOF' … EOF`):
// those lines are data the shell writes, never commands it runs, and reading them as commands denied
// a guarded agent the report and fixture files this repo's own workflow asks it to write (round 6).
// An unterminated heredoc has no body boundary to trust, so it falls back to classifying the body.
// Scope is git-only; non-git commands (tests, greps) are allowed. Three dispatch origins are guarded
// by the allowlist — task-reviewer, red-team-reviewer and, since #235, implementer — and the main
// thread (no agent_type) is guarded for `git stash` alone, only while a .devcycle/state.md at or
// above the call's cwd reports a stage other than done. Every other origin is never guarded.
//
// WHAT THE EVIDENCE FOR THIS FILE DOES NOT COVER (branch review round 10). The differential corpus
// behind the "residual fail-opens: 0" claim (.devcycle/evidence/branch-fix-8-3-gen-corpus.mjs)
// crosses obfuscation SPELLINGS with syntactic CONTEXTS, and neither dimension contains a shell
// EXPANSION — so that 0 is 0 over what the corpus covers, not over every destructive spelling. These
// reach ALLOW and are real, executed destructive gits: `${x}git reset --hard`, `gi${x}t reset
// --hard`, `${x:-git} reset --hard`, `G=git; $G reset --hard`, and `git${IFS}reset --hard` (bash
// only; zsh does not word-split). Resolving them needs shell-level expansion this parser
// deliberately does not do, so the whole class is a stated bound rather than a backstopped case —
// the `$git` note in normalizeHead explains ONE spelling, not the bound on the measurement. Two
// further known allows, both pre-existing and both outside that corpus: on the main-thread arm
// `git -c alias.z=stash z` reaches allow, because `-c` is a VALUE_OPTIONS skip and the subcommand
// read lands on `z` (it also requires a configured alias); and a command ending in a dangling
// backslash — `git stash\` — reaches allow on that same arm, because the backslash stays in the
// `stash\` token while both shells drop it and run a real `git stash` (round 10 measured it; the
// guarded arm denies it, since there the head alone decides).
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

// The escapes an ANSI-C quote gives a NAME to. Each stands for one character, and the shell puts
// that character in the word — `$'\t'` is a tab, not the two characters `\t`. An escape the shell
// does not recognize keeps its backslash, which is what the default branch below reproduces.
const ANSI_C_NAMED = new Map(Object.entries({
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
}));

// Decode the body of an ANSI-C quote (`$'…'`), starting just past its opening `'`, exactly as the
// shell expands it; returns the decoded text and the index of the closing `'` (or the word's end,
// for an unterminated one). Decoding rather than merely dropping the quote is what closes the class
// BOTH ways: `\x67`, `\147` and `g` each spell `g`, so `$'\x67it'` IS the git binary and must
// deny — while `$'gi\t'` is `gi<TAB>`, a command no shell has, so consuming the backslash the way an
// unquoted word's rule does would deny a command that never runs. (`\u`/`\U` are zsh 5.9 escapes
// that bash 3.2 leaves literal; the shell running an agent's Bash call may be either, so the guard
// reads the union — the deny direction.)
function decodeAnsiC(word, from) {
  let text = "";
  let i = from;
  for (; i < word.length && word[i] !== "'"; i += 1) {
    if (word[i] !== "\\" || i + 1 >= word.length) { text += word[i]; continue; }
    const rest = word.slice(i + 1);
    const octal = /^[0-7]{1,3}/.exec(rest);
    if (octal) { text += String.fromCharCode(parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue; }
    const escape = rest[0];
    const hex = escape === "x" ? /^[0-9a-fA-F]{1,2}/.exec(rest.slice(1)) : null;
    if (hex) { text += String.fromCharCode(parseInt(hex[0], 16)); i += 1 + hex[0].length; continue; }
    const unicode = escape === "u" || escape === "U"
      ? new RegExp(`^[0-9a-fA-F]{1,${escape === "u" ? 4 : 8}}`).exec(rest.slice(1)) : null;
    // `\U` spells up to EIGHT hex digits, and above U+10FFFF there is no code point to put in the
    // word — String.fromCodePoint THROWS there, which killed the hook with exit 1 and empty stdout
    // (branch review round 10). Out of range, the escape keeps its literal text, which is what bash
    // 3.2 does with the whole sequence and what zsh's replacement bytes amount to: a command name
    // that is not git either way. `\u` is capped at four digits and can never reach the boundary.
    const codePoint = unicode ? parseInt(unicode[0], 16) : -1;
    if (unicode && codePoint <= 0x10ffff) { text += String.fromCodePoint(codePoint); i += 1 + unicode[0].length; continue; }
    if (escape === "c" && rest.length > 1) { text += String.fromCharCode(rest.charCodeAt(1) & 31); i += 2; continue; }
    text += ANSI_C_NAMED.get(escape) ?? ("\\" + escape);
    i += 1;
  }
  return { text, end: i };
}

// Remove the quoting a word carries, WHEREVER it sits in that word: a `'` or `"` is syntax the shell
// consumes rather than passes to the binary, a `$` in front of either opens an ANSI-C (`$'…'`) or a
// locale-translated (`$"…"`) quote and is consumed with it, and a backslash escapes the character
// behind it. So `"g"'it'`, `g""it`, `gi\t`, `g$'it'` and `$'\x67it'` are all spellings the shell runs
// as `git`. Doing this only at the word's ENDS — which is what a leading/trailing-run regex does —
// left every intra-word spelling reducing to a non-git head, and each of them reached ALLOW on both
// arms (branch review round 6, F3). Leaving the `$` of a mid-word ANSI-C quote in place did the same
// to that whole class: `$'git'` reduced to `git` (the leading-`$` run was stripped) while `g$'it'`
// stopped at `g$it`, so `g$'it' reset --hard` and `git st$'ash'` reached ALLOW (round 8, F1). A
// backslash with nothing behind it escapes nothing and is kept.
function stripQuoting(word) {
  let out = "";
  for (let i = 0; i < word.length; i += 1) {
    const c = word[i];
    if (c === "$" && (word[i + 1] === "'" || word[i + 1] === '"')) {
      if (word[i + 1] === '"') continue;         // `$"…"` translates its contents; the `$` is syntax
      const { text, end } = decodeAnsiC(word, i + 2);
      out += text;
      i = end;                                   // resume at the closing quote (or the word's end)
      continue;
    }
    if (c === "'" || c === '"') continue;
    if (c === "\\" && i + 1 < word.length) { out += word[i + 1]; i += 1; continue; }
    out += c;
  }
  return out;
}

// Normalize a command head to the bare command name so alternate spellings of the same binary all
// reduce to one token before classification (deny-on-ambiguity depends on this being total): drop
// the word's quoting and escapes (above), then a leading run of grouping characters and `$` (the
// variable spelling `$git`, which the shell expands to something this parser cannot see), then the
// same run of closers at the end, then the path basename (`/usr/bin/git`, `./git`). Grouping
// characters are tokens of their own since canonicalization, so `(`/`)`/`{`/`}` here only cover a
// quoted or malformed leftover. Whatever reduces to `git` is treated as git. Every reduction here
// resolves the word the way the shell does, so it adds the spellings the shell really runs as git
// and drops only the ones it does not (`$'gi\t'`) — never a spelling that reaches the git binary.
function normalizeHead(token) {
  const t = stripQuoting(token).replace(/^[({$]+/, "").replace(/[)}]+$/, "");
  const slash = t.lastIndexOf("/");
  return slash === -1 ? t : t.slice(slash + 1);
}

// git's own global options that take a VALUE. Written separated (`git --git-dir .git stash`) the
// value is a token of its own, so an option paired with nothing left the subcommand index on the
// VALUE: `.git` was compared against `stash` and the main-thread ban missed the stash, and a guarded
// origin's read-only `git --git-dir /r/.git log` was wrongly denied for the "subcommand" `/r/.git`.
// The attached spellings (`--git-dir=.git`) need no entry — the generic `-`-prefixed skip covers
// them. `--exec-path` and `--attr-source` also have valueless/attached uses; skipping a token that
// is not there runs the index off the end, and the two arms then part by design: a guarded origin
// reads an unclassifiable git → deny, while the main thread reads the missing token as `""` → not
// `stash` → allow. That is correct, not a gap — its ban is stash-only (spec §2), and a git left
// with no subcommand runs nothing at all (`git --git-dir` exits 129 with a usage error).
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
// tokens go through normalizeHead for the same reason heads do — a quote stays glued to the word it
// wraps (`git "stash"` tokenizes as `"stash"`, `git $'stash'` as `$'stash'`), and a raw comparison
// read those as "not stash" and allowed the one command this ban exists to stop (round-1 finding).
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

// ── Canonicalization ───────────────────────────────────────────────────────────────────────────
// Operator spellings the shell reads as syntax wherever they appear, longest match first so `&&` is
// never read as two background operators and a `2>&1` never loses its `&` to one. `{`/`}` are
// absent deliberately: the shell treats them as reserved WORDS, so they open a group only when they
// stand alone (`{ git …; }`) while `{a,b}` and `${X}` are ordinary words — tokenizeCommand applies
// that rule instead of splitting every brace.
const OPERATORS = [";;", "&&", "&>>", "&>", "||", "<<<", "<<", "<&", "<>", ">>", ">&", ">|", ";", "&", "|", "<", ">", "(", ")"];
// A redirection operator token, including the file descriptor the tokenizer glues onto its front
// (`2>&`) and the `&` of a descriptor duplication. This is where the old segment splitter's
// `(?<![<>])&` lookbehind now lives: a duplication's `&` is part of THIS token, so any `&` that
// survives as a token of its own is a background operator and separates commands.
const REDIRECTION_OP = /^(?:\d*(?:<{1,3}|>{1,2}|<>)&?|&>{1,2}|\d*>\|)$/;
const OPERATOR_TOKENS = new Set([...OPERATORS, "{", "}", "\n"]);
const isOperatorToken = (t) => OPERATOR_TOKENS.has(t) || REDIRECTION_OP.test(t);
// Tokens that separate one command from the next. An unquoted newline is one of them, which is why
// tokenizeCommand emits it as a token rather than as whitespace.
const SEPARATORS = new Set([";", ";;", "&&", "||", "|", "&", "\n"]);

// Split a command into shell tokens, giving every metacharacter that is SYNTAX a token of its own
// and leaving the same character alone where it is DATA: inside `'…'` (everything literal), `"…"`
// and `$'…'` (where a backslash still escapes), or behind a backslash outside quotes (`\git`, and a
// backslash-newline, which is a line continuation and joins its two halves). Whitespace ends a token
// inside quotes too — a wrapper's quoted script (`sh -c 'git stash'`) must still show its `git` to
// the wrapper check, exactly as the old whitespace split did. Quoting is the ONLY thing interpreted
// here: no expansion, no substitution, no word splitting. An unterminated quote is an ambiguous
// command, so it is re-read with quoting disabled (the deny direction: more syntax is seen, not
// less).
// Read the delimiter word a `<<` operator opens, starting just past that operator. `<<-` is the
// tab-stripping form, and the delimiter may be written quoted (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) or
// bare — the quoting only decides whether bash expands the body, which this parser never does, so
// the word is compared with its quoting removed. Returns null when no word follows (`cat <<`),
// which leaves the operator to tokenize as an ordinary redirection.
function readHeredocDelimiter(raw, from) {
  let j = from;
  let stripTabs = false;
  if (raw[j] === "-") { stripTabs = true; j += 1; }
  while (raw[j] === " " || raw[j] === "\t") j += 1;
  let word = "";
  let quote = null;
  while (j < raw.length) {
    const c = raw[j];
    if (quote) { word += c; if (c === quote) quote = null; j += 1; continue; }
    if (c === "'" || c === '"') { word += c; quote = c; j += 1; continue; }
    if (c === "\\" && j + 1 < raw.length) { word += c + raw[j + 1]; j += 2; continue; }
    if (/[\s;&|<>()]/.test(c)) break;
    word += c;
    j += 1;
  }
  return word ? { delim: stripQuoting(word), stripTabs, end: j } : null;
}

// A heredoc BODY is DATA, not commands: `cat <<'EOF' … EOF` writes those lines to a file, it never
// runs them, and writing a findings or report file that quotes `git reset --hard` is exactly what a
// reviewer or implementer in this repo does — classifying the body denied that work (branch review
// round 6, F4). Consume the bodies the line's heredoc operators opened, from `start` (just past that
// line's newline), and return the offset just past the last delimiter line; `<<-` strips leading
// TABS from the body and from its delimiter line. An unterminated heredoc is an ambiguous command,
// so it returns -1 and the caller tokenizes the body as commands instead — the same deny direction
// an unterminated quote takes.
function skipHeredocBodies(raw, start, heredocs) {
  let pos = start;
  for (const { delim, stripTabs } of heredocs) {
    let terminated = false;
    while (pos <= raw.length) {
      const eol = raw.indexOf("\n", pos);
      const lineEnd = eol === -1 ? raw.length : eol;
      let line = raw.slice(pos, lineEnd).replace(/\r$/, "");
      if (stripTabs) line = line.replace(/^\t+/, "");
      pos = eol === -1 ? raw.length : eol + 1;
      if (line === delim) { terminated = true; break; }
      if (eol === -1) break;
    }
    if (!terminated) return -1;
  }
  return pos;
}

function tokenizeCommand(raw, ignoreQuotes = false) {
  const tokens = [];
  const heredocs = []; // bodies opened on the line being read, consumed at that line's newline
  let word = "";
  const flush = () => { if (word) { tokens.push(word); word = ""; } };
  const push = (token) => { flush(); tokens.push(token); };
  let quote = null; // "'", '"' or "$'" while inside that quoting form
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const next = raw[i + 1];
    if (quote) {
      if (quote !== "'" && c === "\\" && next !== undefined) { // `"…"` and `$'…'` honour backslash escapes
        i += 1;
        if (next !== "\n") word += c + next;                   // a backslash-newline is a continuation
        continue;
      }
      // Inside `'…'` a backslash-newline is LITERAL — this shell performs no continuation and passes
      // both characters on. Whichever shell RE-READS that text (the inner `sh` of a wrapper) does
      // perform it, joining the halves, so `sh -c 'g\<newline>it stash'` runs a real git that neither
      // half spells. The pair is kept in the word instead of flushing at the newline, which is what
      // lets the wrapper check below rejoin the halves; it is kept rather than deleted so ONLY that
      // check sees the join, and a top-level `'g\<newline>it'` still classifies as the command name
      // carrying those two literal characters, which is what this shell would look for.
      if (quote === "'" && c === "\\" && (next === "\n" || (next === "\r" && raw[i + 2] === "\n"))) {
        word += "\\\n";
        i += next === "\r" ? 2 : 1;
        continue;
      }
      if (c === (quote === "$'" ? "'" : quote)) { word += c; quote = null; continue; }
      if (/\s/.test(c)) { flush(); continue; }
      word += c;
      continue;
    }
    if (!ignoreQuotes && (c === "'" || c === '"')) { word += c; quote = c; continue; }
    if (!ignoreQuotes && c === "$" && next === "'") { word += "$'"; i += 1; quote = "$'"; continue; }
    if (c === "\\") {
      if (next === undefined) { word += c; break; }
      i += 1;
      if (next === "\n") continue;                                            // line continuation
      if (next === "\r" && raw[i + 1] === "\n") { i += 1; continue; }
      word += c + next;
      continue;
    }
    if (c === "\n" || c === "\r") {
      push("\n");
      if (c === "\r" && next === "\n") i += 1;
      if (heredocs.length) {                                    // the bodies this line opened are data
        const bodyEnd = skipHeredocBodies(raw, i + 1, heredocs);
        heredocs.length = 0;
        if (bodyEnd !== -1) i = bodyEnd - 1;                    // resume just past the last delimiter line
      }
      continue;
    }
    if (/\s/.test(c)) { flush(); continue; }
    if ((c === "{" || c === "}") && !word && (next === undefined || /[\s;&|)]/.test(next))) { push(c); continue; }
    const op = OPERATORS.find((o) => raw.startsWith(o, i));
    if (op) {
      const fd = /^[<>]/.test(op) && /^\d+$/.test(word) ? word : ""; // in `2>&1` the descriptor is the operator's
      if (fd) word = "";
      push(fd + op);
      i += op.length - 1;
      if (op === "<<") { // a heredoc: its delimiter is data, and so is the body opened at the newline
        const here = readHeredocDelimiter(raw, i + 1);
        if (here) { heredocs.push(here); i = here.end - 1; }
      }
      continue;
    }
    word += c;
  }
  flush();
  return quote && !ignoreQuotes ? tokenizeCommand(raw, true) : tokens;
}

// Tokens a case pattern label may contain: an alternation, the `(*)` spelling's open paren, and a
// line break between `in`/`;;` and the pattern.
const LABEL_TOKENS = new Set(["|", "(", "\n"]);
// A `case` arm's pattern label (`*)`, `1)`, `(*)`, `git|sh)`) is syntax, never a command, whatever
// it happens to spell — the arm's real command is the `echo x` or `git log` behind the label. Labels
// are dropped BEFORE segments are formed because an alternated label spans the `|` the splitter cuts
// on: its first alternative used to reach the classifier alone, so `case $x in git|sh) echo ok;;
// esac` denied a command in which no git runs (branch review round 4). A label runs from `case … in`
// or from a `;;` up to and including its `)`, and the run is dropped only when that `)` is actually
// there, so a malformed `case` can never swallow the command behind it.
function dropCaseLabels(tokens) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "case") depth += 1;
    else if (token === "esac" && depth > 0) depth -= 1;
    out.push(token);
    if (depth === 0 || (token !== "in" && token !== ";;")) continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j] !== "case" && tokens[j] !== "esac" &&
      (LABEL_TOKENS.has(tokens[j]) || !isOperatorToken(tokens[j]))) j += 1;
    if (tokens[j] === ")") i = j; // the whole label, its `)` included, carries no command
  }
  return out;
}

// Split the token stream on the operators that separate commands; each segment is classified
// independently.
function splitSegments(tokens) {
  const segments = [[]];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) segments.push([]);
    else segments[segments.length - 1].push(token);
  }
  return segments;
}

// Shell reserved words that may precede a command inside one segment. They are neither a command
// nor a wrapper, so a segment whose head is one of them was skipped and the git after it never
// classified (`for f in a b; do git checkout -- "$f"; done`, `! git reset --hard`,
// `if git reset --hard; then :; fi` — audit 2026-09-05 H1; `case`/`esac` and `coproc` — branch
// review round 1). They are stripped until the real head is reached. `function` is handled
// separately in stripLeading: it is the only construct in which the NAME after it is not a command.
const RESERVED = new Set([
  "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "!", "{", "(", "}", ")",
  "esac", "coproc",
]);
// Compound-command headers: everything up to and including the terminator token carries no command,
// so it is dropped wholesale. `for`/`select` end at `do`; `case` ends at `in`. When the terminator
// sits after a `;` or a newline (the usual spelling) the header segment is simply empty — the body
// `git …` is then its own segment and classifies as git.
const BLOCK_HEADS = new Map([["for", "do"], ["select", "do"], ["case", "in"]]);

// A head that classification itself keys off: the git binary, or a recognized wrapper. The
// redirection lookahead below is gated on this so a bare `>` never swallows the command itself.
// The invariant stripping keeps is narrower than "it only ever adds denies": it is that stripping
// never lets a DESTRUCTIVE git through — a token consumed as syntax is never the command the shell
// runs, and whatever stands behind it is classified in its place. Dropping a `case` label that
// happens to spell `git)` or `sh)` does REMOVE a deny (branch review round 2, F4), deliberately:
// the arm's real command is the `echo x` or `git log` behind the label, and that is what gets
// classified. A `(git)` subshell is not a label and keeps its deny, because dropCaseLabels only
// drops inside a `case`.
const isClassifiedHead = (token) => {
  const h = normalizeHead(token);
  return h === "git" || WRAPPERS.has(h);
};
// Drop leading env-assignments, grouping tokens, reserved words, compound-command headers,
// redirections and function-definition heads so the head re-derives to the real command. Returns the
// remaining tokens (possibly none). Case labels are already gone (dropCaseLabels), and every
// metacharacter is already its own token (tokenizeCommand), so each rule below is written once per
// CLASS rather than once per spelling.
function stripLeading(tokens) {
  let t = tokens;
  let namedFunction = false; // `function f { … }` — the only construct where the name is not a command
  for (;;) {
    if (!t.length) return t;
    const head = t[0];
    if (head === "function") { namedFunction = true; t = t.slice(1); continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head) || RESERVED.has(head)) { t = t.slice(1); continue; }
    if (BLOCK_HEADS.has(head)) {
      const endAt = t.indexOf(BLOCK_HEADS.get(head));
      t = endAt === -1 ? [] : t.slice(endAt + 1);
      continue;
    }
    // A redirection in front of a command (`>/dev/null git …`, `2>&1 git …`, `2>& 1 git …`) is not a
    // command, so the git behind it must still be classified. The operator's target is the next
    // token and is dropped with it — unless that token is itself git or a wrapper, where dropping it
    // would hide the command instead of the syntax.
    if (REDIRECTION_OP.test(head)) { t = isClassifiedHead(t[1] ?? "") ? t.slice(1) : t.slice(2); continue; }
    // A function-definition head (`f ( )`, and `f` alone after the `function` keyword) is not a
    // command either; the body behind it is. Every glued spelling — `f(){`, `f (){`, `f()(` — reaches
    // this rule as the same `f` `(` stream, and the grouping tokens behind it fall to RESERVED.
    if (t[1] === "(" || (namedFunction && t[1] === "{")) { t = t.slice(1); namedFunction = false; continue; }
    return t;
  }
}

// Canonicalize, then classify: tokenize once (quote-aware), drop case labels, split on the
// separator tokens, and classify each segment independently. A lone `&` token is a background
// operator and separates commands just as `;` does (`true & git reset --hard` is two commands); a
// duplication's `&` never reaches this point as a token of its own, because tokenizeCommand glued it
// into its redirection operator.
// Every throw inside the classifier ends in a DENY, never in an uncaught exception. A crash exits 1
// with empty stdout, which a PreToolUse harness reads as "no decision" — the fail-open this whole
// file exists to prevent — and heads are normalized segment by segment in order, so a crashing token
// placed in FRONT of a git segment killed the process before any deny() was written and disarmed the
// guard for the entire command (branch review round 10). The catch is on the CLASS, not on the one
// input that reached it: the next parser change that throws lands here instead of failing open. On
// the main thread it denies a command the parser could not read even when no stash is visible in it,
// deliberately — a command this file cannot parse is exactly the one whose stash it cannot rule out.
try {
  for (const seg of splitSegments(dropCaseLabels(tokenizeCommand(command)))) {
    // stripLeading drops env-assignments, `{`/`(` grouping tokens, reserved words, redirections and
    // function-definition heads so the head is the real command — `{ git reset; }`, `( git reset )`
    // and `do git reset` must not hide the git. (normalizeHead additionally reduces a quoted or
    // path-qualified head, e.g. `"git"` or `/usr/bin/git`.)
    const tokens = stripLeading(seg);
    if (!tokens.length) continue;
    const head = normalizeHead(tokens[0]);
    if (WRAPPERS.has(head)) {
      // A wrapper's argument is often a quoted script (`sh -c 'git checkout -- x'`), so the naive
      // whitespace split leaves a quote character glued to the word (`'git`, `"git`), and a wrapper may
      // also name git by path — normalizeHead reduces every such spelling to `git` before comparing.
      // A wrapper's argument is also RE-READ by the shell it starts, so the backslash-newline the outer
      // single quotes made literal (tokenizeCommand kept the pair in the word) is a line continuation
      // to that inner shell and joins the halves: `sh -c 'g\<newline>it stash'` runs a real git that
      // neither `'g\` nor `it` spells (branch review round 8, fix round). Resolving the continuation
      // HERE and nowhere else is the bound. This arm already denies any git token behind a recognized
      // wrapper, so it adds no class of deny — only the spellings of that deny it was missing — while
      // the head path keeps reading a top-level `'g\<newline>it'` as the literal command name the shell
      // would actually look for. The narrower alternative, resolving it only behind a wrapper this file
      // could name as a shell, was rejected: the set of launchers that hand their argument to `sh -c`
      // is not enumerable here, and this file's rule is that a missed destructive git is not
      // acceptable. Its cost is an over-deny on `sudo 'g\<newline>it' …`, a command name no shell has.
      const inner = tokens.map((t) => t.replace(/\\\n/g, ""));
      if (inner.slice(1).some((t) => normalizeHead(t) === "git") && (guarded || mentionsStash(inner))) // git behind a wrapper we cannot see into
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
} catch {
  deny(denyReason(
    "run a command this guard could not parse (deny-on-ambiguity).",
    "this command could not be parsed, so a git stash inside it cannot be ruled out (deny-on-ambiguity)."
  ));
}

allow();
