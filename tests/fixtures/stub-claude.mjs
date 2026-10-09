// A stand-in for the `claude` CLI that tests/unit/drive-execution.test.mjs hands the driver through
// `--claude`; it never calls a model. Each invocation plays the next step of the JSON array named by
// STUB_CLAUDE_SCENARIO — editing the state file, the ledger and drive-stop.json the way a driven
// session would, then printing stream-json events — and first appends what it was given (its argv,
// whether DEVCYCLE_NESTED_RUN reached it, its pid, the DEVCYCLE_DRIVE_TOKEN it was handed and the
// drive lock's tokenHash at that moment) to the JSONL file named by STUB_CLAUDE_CALLS.
//
// A step's keys, all optional: `plugins` (the init event's list; default devcycle only),
// `pluginErrors`, `ledger` (lines appended after a `- [<stamp>] ` prefix), `stage` (rewrites the
// state's `- stage:` row), `stop` ({ reason, detail } written as drive-stop.json), `rateLimitInSec`
// (a rejected rate_limit_event resetting that many seconds from now), `result`, `isError`,
// `costUsd`, `denials`, `hangMs` (wait before the result event), `noResult` (exit without a result
// event, as a crashed session does), `noInit` (exit before even the init event, as a `claude` that
// fails at startup does; exit code 1 unless `exitCode` says otherwise), `exitCode`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const steps = JSON.parse(readFileSync(process.env.STUB_CLAUDE_SCENARIO, "utf8"));
const callsPath = process.env.STUB_CLAUDE_CALLS;
const n = existsSync(callsPath) ? readFileSync(callsPath, "utf8").split("\n").filter(Boolean).length : 0;
const step = steps[Math.min(n, steps.length - 1)] ?? {};
const argv = process.argv.slice(2);
let lockTokenHash = null;
try {
  lockTokenHash = JSON.parse(readFileSync(join(".devcycle", "drive.lock"), "utf8")).tokenHash ?? null;
} catch {
  // No lock: a dry run, or a test that drives without one.
}
appendFileSync(callsPath, JSON.stringify({ argv, nested: "DEVCYCLE_NESTED_RUN" in process.env, pid: process.pid,
  token: process.env.DEVCYCLE_DRIVE_TOKEN ?? null, lockTokenHash }) + "\n");
if (step.noInit) process.exit(step.exitCode ?? 1);

const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const statePath = prompt.match(/--drive (\S+)/)?.[1];
const emit = (event) => process.stdout.write(JSON.stringify({ session_id: `stub-session-${n + 1}`, ...event }) + "\n");

emit({
  type: "system",
  subtype: "init",
  plugins: step.plugins ?? [{ name: "devcycle", version: "0.0.0-stub" }],
  ...(step.pluginErrors ? { plugin_errors: step.pluginErrors } : {}),
});
for (const line of step.ledger ?? []) appendFileSync(join(".devcycle", "ledger.md"), `- [2026-10-08T00:00:00Z] ${line}\n`);
if (step.stage) writeFileSync(statePath, readFileSync(statePath, "utf8").replace(/^- stage: .*$/m, `- stage: ${step.stage}`));
if (step.stop)
  writeFileSync(
    join(".devcycle", "drive-stop.json"),
    JSON.stringify({ stage: "execution", stamp: "2026-10-08T00:00:00Z", sessionHash: "0".repeat(64), ...step.stop }),
  );
if (step.rateLimitInSec !== undefined)
  emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + step.rateLimitInSec } });
emit({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", name: "Bash" }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000 } },
});

const finish = () => {
  process.exitCode = step.exitCode ?? 0;
  if (step.noResult) return;
  emit({
    type: "result",
    subtype: step.isError ? "error_during_execution" : "success",
    is_error: Boolean(step.isError),
    result: step.result ?? "done",
    total_cost_usd: step.costUsd ?? 0.01,
    permission_denials: Array.from({ length: step.denials ?? 0 }, () => ({ tool_name: "Bash" })),
  });
};
if (step.hangMs) setTimeout(finish, step.hangMs);
else finish();
