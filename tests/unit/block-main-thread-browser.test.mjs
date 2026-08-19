// Field contract confirmed against the installed Claude Code binary (2.1.235,
// /Users/konstantin/.local/share/claude/versions/2.1.235): `strings -a` on the binary surfaced
// the un-minified-enough source of the hook-input builder `Ly(e,t,r,n)`, which returns
// `{ session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id: n?.agentId,
// agent_type: o, effort }` where `o = n?.agentType ?? Z$()`. On the main thread `Z$()` resolves
// to `hookRegistry.mainThreadAgentType()`, whose backing field `#t` starts as `void 0` and is
// only set via `replaceMainThreadAgentType` when a subagent is active — so on the main thread
// `agent_type` is `undefined` and JSON.stringify drops it from the emitted stdin JSON entirely
// (absent key, not empty string). Confirms the brief's expected shape: field name `agent_type`
// (also `agent_id`), empty/absent on the main thread, set to the subagent's name inside one.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HOOK = join(process.cwd(), "hooks/block-main-thread-browser.mjs");
const call = (input) => spawnSync("node", [HOOK], { input: JSON.stringify(input), encoding: "utf8" });

const browserCall = (extra) => ({
  hook_event_name: "PreToolUse",
  tool_name: "mcp__claude-in-chrome__computer",
  tool_input: {},
  ...extra,
});

test("denies a main-thread browser call (no agent_type)", () => {
  const r = call(browserCall({ agent_type: "", agent_id: "" }));
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /on-device-driver/);
});

test("allows an on-device-driver subagent browser call", () => {
  const r = call(browserCall({ agent_type: "on-device-driver", agent_id: "abc123" }));
  // allow = either an explicit allow decision or no deny (exit 0, empty/allow output)
  const decision = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined;
  assert.notEqual(decision, "deny");
  assert.equal(r.status, 0);
});

test("denies a browser call from any other subagent", () => {
  const r = call(browserCall({ agent_type: "implementer", agent_id: "def456" }));
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});
