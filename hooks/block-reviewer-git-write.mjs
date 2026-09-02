#!/usr/bin/env node
// PreToolUse Bash hook (#165): a reviewer-role dispatch must never run a destructive git command
// against the shared checkout. agents/task-reviewer.md and agents/red-team-reviewer.md carry a prose
// ban and references/evidence.md forbids `git stash`, but `tools:` still grants full Bash and nothing
// intercepts the call — prose is exactly what failed in the incident that destroyed an uncommitted
// round-2 diff. This is the structural backstop, mirroring hooks/block-main-thread-browser.mjs:
// origin is read from the hook input's agent_type (namespaced for a plugin agent, per
// docs/platform-notes.md § (e)); for a GUARDED reviewer origin every git invocation must reduce to an
// allowlisted read-only subcommand or the call is denied. Deny-on-ambiguity carries the safety: any
// git form the parser cannot confidently classify as read-only — including git behind sh -c, xargs,
// eval, a process/privilege/scheduling wrapper (setsid/sudo/taskset/…), a `{ … }` group or `( … )`
// subshell, backticks, a write-capable option (git diff --output=<file>), or an unrecognized option
// shape — is denied. Scope is git-only; non-git commands
// (tests, greps) are allowed, and a non-reviewer origin (implementer, on-device-driver, main thread)
// is never guarded.
import { readFileSync } from "node:fs";

let input = {};
try {
  const parsed = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
} catch { /* malformed stdin → no origin → not a guarded reviewer → allow */ }

const rawAgentType = input.agent_type;
const agentType = typeof rawAgentType === "string" ? rawAgentType.trim() : "";

// The inverse of block-main-thread-browser.mjs's ALLOWED list: these origins are GUARDED. Both the
// bare frontmatter name and the <plugin>:<name> spelling the harness passes are pinned (stripping a
// prefix would admit another plugin's identically-named agent, widening a guard whose only job is to
// narrow). tests/unit/golden-path.test.mjs ties this list to agents/task-reviewer.md and
// agents/red-team-reviewer.md's name: frontmatter, so a rename fails the suite instead of disarming.
const GUARDED_AGENT_TYPES = ["task-reviewer", "devcycle:task-reviewer", "red-team-reviewer", "devcycle:red-team-reviewer"];

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

if (!GUARDED_AGENT_TYPES.includes(agentType)) allow();

const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";

// Clearly read-only git subcommands (unconditional).
const READ_ONLY = new Set([
  "diff", "log", "show", "status", "blame", "rev-parse", "ls-files", "ls-tree", "cat-file",
  "describe", "grep", "shortlog", "merge-base", "rev-list", "name-rev", "for-each-ref",
  "diff-tree", "diff-index", "symbolic-ref", "whatchanged",
]);
// Shell/exec wrappers that could execute a git we cannot see into → deny-on-ambiguity when git
// appears. This is a bounded denylist (per the design's § Parser robustness): it need not be
// exhaustive because deny-on-ambiguity backstops it — a wrapper not listed here still cannot make a
// destructive git read-only, it only fails to short-circuit. Covered: shell interpreters and
// exec/eval helpers, plus the common process/privilege/scheduling launchers (setsid/sudo/doas/
// taskset/chrt/ionice/stdbuf/unshare/unbuffer) that otherwise pass a destructive git straight through.
const WRAPPERS = new Set([
  "sh", "bash", "zsh", "dash", "eval", "xargs", "env", "command", "nice", "nohup", "time",
  "timeout", "watch", "setsid", "sudo", "doas", "taskset", "chrt", "ionice", "stdbuf", "unshare",
  "unbuffer",
]);

// Normalize a command head to the bare command name so alternate spellings of the same binary all
// reduce to one token before classification (deny-on-ambiguity depends on this being total): strip a
// leading grouping token (`(`/`{`, the subshell/brace-group spelling `(git`/`{git`), then surrounding
// quotes (`"git"`), then a single leading backslash (`\git`, the alias-bypass spelling), then the path
// basename (`/usr/bin/git`, `./git`). Whatever reduces to `git` is treated as git.
function normalizeHead(token) {
  let t = token.replace(/^[({]+/, "").replace(/^['"]+|['"]+$/g, "").replace(/^\\/, "");
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

// Command substitution can hide a git write we cannot classify.
if (/`|\$\(/.test(command) && /\bgit\b/.test(command))
  deny(`devcycle: reviewer dispatch (${agentType}) may not run git inside a command substitution (deny-on-ambiguity). command: ${command.slice(0, 200)}`);

// Split on shell operators that separate commands; classify each segment independently. A lone `&`
// (background operator) separates commands just as `;` does, so `true & git reset --hard` must split
// into two segments — `&&` is matched first so a logical-AND is never mis-split on its first `&`.
for (const seg of command.split(/(?:&&|\|\||;|\||&|\n)/)) {
  let tokens = seg.trim().split(/\s+/).filter(Boolean);
  // Drop leading env-assignments and bare grouping tokens (`{`/`(`, a brace group or subshell) so the
  // head re-derives to the real command — `{ git reset; }` and `( git reset )` must not hide the git.
  // (normalizeHead additionally strips a grouping char glued to the head, e.g. `(git`.)
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || tokens[0] === "{" || tokens[0] === "(")) tokens.shift();
  if (!tokens.length) continue;
  const head = normalizeHead(tokens[0]);
  if (WRAPPERS.has(head)) {
    // A wrapper's argument is often a quoted script (`sh -c 'git checkout -- x'`), so the naive
    // whitespace split leaves a quote character glued to the word (`'git`, `"git`), and a wrapper may
    // also name git by path — normalizeHead reduces every such spelling to `git` before comparing.
    if (tokens.slice(1).some((t) => normalizeHead(t) === "git")) // git behind a wrapper we cannot see into
      deny(`devcycle: reviewer dispatch (${agentType}) may not run git behind a shell wrapper (deny-on-ambiguity). command: ${command.slice(0, 200)}`);
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
  if (!gitSegmentIsReadOnly(tokens, i))
    deny(`devcycle: reviewer dispatch (${agentType}) may not run destructive/ambiguous git — reviewers are read-only apart from \`git add -N\` (${(tokens[i] ?? "git")}). command: ${command.slice(0, 200)}`);
}

allow();
