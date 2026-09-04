// agent-cli.js — the subprocess layer both workflow engines share.
//
// review-panel.js and mechanical-sweep.js each drive `claude` in print mode with
// a schema-validated envelope, and each needs the same three pieces: a tagged
// stderr logger, a buffered subprocess runner with a kill timeout, and the
// structured-agent call itself. They differ only in retry count, working
// directory, permission mode, and the words they put in their error strings —
// all parameters here, so neither engine keeps a private copy.

"use strict";

const { spawn } = require("node:child_process");

const AGENT_TIMEOUT_MS = 15 * 60 * 1000;

// Tagged stderr logging. Each engine makes its own pair so its lines stay
// attributable: makeLogger("review-panel"), makeLogger("mechanical-sweep").
function makeLogger(tag) {
  const log = (msg) => process.stderr.write(`[${tag}] ${msg}\n`);
  const fatal = (msg) => {
    process.stderr.write(`[${tag}] ERROR: ${msg}\n`);
    process.exit(1);
  };
  return { log, fatal };
}

// Spawn a child, buffer its output, SIGKILL it after timeoutMs. Never rejects:
// transport failures come back on the resolved value as { spawnError } or
// { timedOut } so callers branch on them instead of catching.
function run(cmd, args, { cwd, timeoutMs, maxBufferBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs ?? AGENT_TIMEOUT_MS);
    const guard = () => {
      if (!overflow && stdout.length + stderr.length > maxBufferBytes) {
        overflow = true;
        // A single "data" event can deliver a whole write in one chunk, so the
        // accumulator can already sit well past the cap by the time this fires —
        // truncate what's kept, not just what's kept from growing further.
        if (stdout.length > maxBufferBytes) stdout = stdout.slice(0, maxBufferBytes);
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (d) => { stdout += d; guard(); });
    child.stderr.on("data", (d) => { stderr += d; guard(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err), timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(overflow ? { code, stdout, stderr, timedOut: false, overflow: true } : { code, stdout, stderr, timedOut });
    });
    child.stdin.end();
  });
}

// Run a claude print-mode subagent with a schema-validated structured output.
// Retries transport and validation failures up to `attempts` times.
// Returns { ok: true, value } | { ok: false, error }.
//
// `errors` supplies the caller's own vocabulary: { agent, output, cap } — the
// name used for the agent in timeout/error messages, the name used in the
// unparseable-output message, and the character cap on a relayed error.
//
// --tools is a VARIADIC option in the claude CLI: in the space-separated
// form ("--tools", value) it greedily consumes following positionals, so if
// its value is the last thing before the prompt, the prompt is swallowed
// into the tools list and the call fails. The equals-form pins exactly one
// value to the flag — never change this back to the two-element form.
async function claudeStructured({ prompt, tools, schema, model, cwd, permissionMode, attempts = 1, errors }) {
  const argv = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--json-schema", JSON.stringify(schema),
    `--tools=${tools}`,
  ];
  if (permissionMode) argv.push("--permission-mode", permissionMode);
  if (model) argv.push("--model", model);
  argv.push(prompt);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await run("claude", argv, { cwd });
    if (res.spawnError) return { ok: false, error: `claude CLI not runnable: ${res.stderr}` };
    if (res.timedOut) {
      if (attempt === attempts) return { ok: false, error: `${errors.agent} timed out` };
      continue;
    }
    if (res.overflow) {
      if (attempt === attempts) return { ok: false, error: `${errors.agent} output exceeded the buffer cap` };
      continue;
    }
    try {
      const envelope = JSON.parse(res.stdout);
      if (!envelope.is_error && envelope.structured_output !== undefined) {
        const cost = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
        return { ok: true, value: envelope.structured_output, cost };
      }
      if (attempt === attempts) {
        return { ok: false, error: `${errors.agent} error: ${envelope.result ?? res.stderr}`.slice(0, errors.cap) };
      }
    } catch {
      if (attempt === attempts) {
        return { ok: false, error: `unparseable ${errors.output} output: ${(res.stderr || res.stdout).slice(0, 300)}` };
      }
    }
  }
  return { ok: false, error: "unreachable" };
}

module.exports = { makeLogger, run, claudeStructured };
