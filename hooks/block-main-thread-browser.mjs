#!/usr/bin/env node
// PreToolUse hook (#84): the coordinator must never drive the browser directly. Browser MCP tools
// are allowed only inside the on-device-driver subagent; every other origin — main thread or any
// other subagent — is denied, forcing dispatch to on-device-driver. Plugin hooks fire in subagents
// too, so origin is read from the hook input's agent_type (empty/absent on the main thread).
import { readFileSync } from "node:fs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* malformed stdin → treat as main thread */ }

const agentType = (input.agent_type ?? "").trim();

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

if (agentType === "on-device-driver") allow();
deny(
  "devcycle: the coordinator must not drive the browser directly. Dispatch the on-device-driver " +
  "subagent (devcycle:verify's on-device stage) for any mcp__claude-in-chrome__* call.",
);
