#!/usr/bin/env node
// PreToolUse hook (#84): the coordinator must never drive the browser directly. Browser MCP tools
// are allowed only inside the on-device-driver subagent; every other origin — main thread or any
// other subagent — is denied, forcing dispatch to on-device-driver. Plugin hooks fire in subagents
// too, so origin is read from the hook input's agent_type (empty/absent on the main thread).
// The origin read below is total: malformed JSON, a body that doesn't parse to a plain object
// (e.g. `null`, an array, a bare number), and an `agent_type` that isn't a string are all shapes
// that carry no origin the allowlist could hold, so every one of them falls through to the same
// empty-string agentType a genuine main-thread call produces — never an uncaught throw.
import { readFileSync } from "node:fs";

let input = {};
try {
  const parsed = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
} catch { /* malformed stdin → treat as main thread */ }

const rawAgentType = input.agent_type;
const agentType = typeof rawAgentType === "string" ? rawAgentType.trim() : "";

// Renders whatever agent_type actually arrived, unambiguous between "absent", "empty string",
// and "present but not a spelling the allowlist holds" — so a deny reason names the origin the
// harness reported instead of leaving a spelling mismatch indistinguishable from an ordinary
// main-thread denial.
const describeAgentType = (value) => {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return value.trim() === "" ? "(empty)" : JSON.stringify(value);
  return `(non-string: ${JSON.stringify(value)})`;
};

// The harness passes the PLUGIN-NAMESPACED agent type, not the bare frontmatter name. Observed
// 2026-08-20 over this repo's own transcripts, where the same `agentType` field this hook's input
// is built from appears only ever namespaced for a plugin-provided agent:
//   grep -roh '"agentType":"[^"]*"' ~/.claude/projects/<this repo's transcript dir>
//   → devcycle:implementer (449), devcycle:task-reviewer (342), devcycle:red-team-reviewer (23)
// Recorded with its provenance in docs/platform-notes.md § (e). Both spellings are pinned rather
// than a `<plugin>:` prefix being stripped: stripping would also admit a different plugin's agent
// that happens to be named on-device-driver, widening a guard whose only job is to narrow.
// tests/unit/golden-path.test.mjs ties these two literals to agents/on-device-driver.md's `name:`
// and the plugin's own name, so a rename on either side fails the suite instead of disarming this.
const ALLOWED_AGENT_TYPES = ["on-device-driver", "devcycle:on-device-driver"];

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

if (ALLOWED_AGENT_TYPES.includes(agentType)) allow();
deny(
  "devcycle: the coordinator must not drive the browser directly. Dispatch the on-device-driver " +
  "subagent (devcycle:verify's on-device stage) for any mcp__claude-in-chrome__* call. " +
  `(agent_type seen: ${describeAgentType(rawAgentType)})`,
);
