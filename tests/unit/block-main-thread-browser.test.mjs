// Field contract confirmed against the installed Claude Code binary (2.1.235): `strings -a`
// on the binary surfaced
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

test("denies a main-thread browser call (empty agent_type)", () => {
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

test("allows the on-device-driver subagent under the plugin-namespaced agent type", () => {
  const r = call(browserCall({ agent_type: "devcycle:on-device-driver", agent_id: "abc123" }));
  const decision = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : undefined;
  assert.notEqual(decision, "deny");
  assert.equal(r.status, 0);
});

// QC3: the allowlist is two literals rather than a `<plugin>:` prefix strip, so a same-named
// agent from a different plugin stays denied. A strip-based fix passes every other test here.
test("denies another plugin's agent that shares the driver's bare name", () => {
  const r = call(browserCall({ agent_type: "otherplugin:on-device-driver", agent_id: "ghi789" }));
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

// F29: the real main-thread shape. `agent_type` is absent from the stdin JSON entirely (see this
// file's header), not an empty string — the case the suite named but never sent.
test("denies a main-thread browser call when agent_type is absent entirely", () => {
  const r = call(browserCall({}));
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /on-device-driver/);
});

// F29: the malformed-stdin fallback at block-main-thread-browser.mjs:9 must deny, not throw.
test("denies when stdin is not valid JSON", () => {
  const r = spawnSync("node", [HOOK], { input: "{not json", encoding: "utf8" });
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(r.status, 0);
});

// branch-fix-1-1 (1): a body of `null` parses fine, so the try/catch never fires, and reading
// `.agent_type` off `null` used to throw — an uncaught throw exits 1 with nothing on stdout,
// which is a non-blocking error to the harness (the browser call proceeds). Must deny instead.
test("denies when stdin parses to null", () => {
  const r = spawnSync("node", [HOOK], { input: "null", encoding: "utf8" });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

// branch-fix-1-1 (1): a non-string agent_type used to throw on `.trim()`. None of these shapes
// is a spelling the allowlist can hold, so all three must deny rather than crash.
for (const [shapeName, agentType] of [
  ["a number", 5],
  ["an object", {}],
  ["an array", []],
]) {
  test(`denies a browser call when agent_type is ${shapeName}`, () => {
    const r = call(browserCall({ agent_type: agentType, agent_id: "abc123" }));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  });
}

// branch-fix-1-1 (3): a right-origin/wrong-spelling agent_type must be distinguishable in the
// deny reason from an ordinary main-thread denial, so the reason names the value actually seen.
test("names the received agent_type in the deny reason for a wrong-spelling origin", () => {
  const r = call(browserCall({ agent_type: "devcycle@devcycle:on-device-driver", agent_id: "abc123" }));
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /on-device-driver/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /devcycle@devcycle:on-device-driver/);
});
