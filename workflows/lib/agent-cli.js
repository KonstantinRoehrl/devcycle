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

// After the child exits, output still in flight in the pipes is drained for this long, then whatever
// is buffered is returned — the promise never waits on a pipe-holder the caller cannot see.
const DRAIN_GRACE_MS = 1000;

// Every child run() has started and not yet seen exit. A detached child leads its own process group,
// so it no longer receives the terminal's Ctrl-C; the parent's own termination must reach it.
const live = new Set();
let signalsHooked = false;
function hookSignals() {
  if (signalsHooked) return;
  signalsHooked = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      for (const child of live) killGroup(child);
      process.kill(process.pid, sig); // re-raise with the default disposition now that the listener is gone
    });
  }
}

// Kill the child's whole process group (audit H5: a grandchild that inherited the stdio pipes —
// `sh -c "sleep 4; echo done"`, a backgrounded server in a verify command — survived a kill of the
// direct child).
//
// `-pid` names a process group, not this child, and once the leader has been reaped that number is
// only still ours while the group exists: POSIX will not recycle a pid that is an existing group's
// pgid, but the moment the group empties the kernel may hand the pid to a stranger who leads a
// group of their own. So for a reaped leader the group is probed with signal 0 and killed only if
// it answers — which loses nothing, because an empty group is exactly the case where the kill had
// nothing to kill. While the leader is still alive (timeout, overflow, the signal sweep) the pid
// cannot have moved, so the kill goes out unconditionally and falls back to the direct child if the
// group kill throws — ESRCH in the window before the child has finished becoming its own leader.
function killGroup(child) {
  const reaped = child.exitCode !== null || child.signalCode !== null;
  if (!reaped) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, 0);
  } catch {
    return; // ESRCH: the group is empty, and this pid may already belong to someone else
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch { /* the last member exited between the probe and the kill */ }
}

// Spawn a child as the leader of its own process group, buffer its output, SIGKILL the group after
// timeoutMs. Settles on the child's `exit`, draining for DRAIN_GRACE_MS, not on `close`. Settling
// ends the call by contract, so it also sweeps any survivor left in the group and destroys the
// stdio pipes: a grandchild that inherited them would otherwise hold the parent's event loop open
// long after the promise resolved (the engine writes its report and then hangs). Never rejects:
// transport failures come back on the resolved value as { spawnError } or { timedOut } so callers
// branch on them instead of catching.
function run(cmd, args, { cwd, timeoutMs, maxBufferBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    hookSignals();
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    live.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let timer = null;
    let drainTimer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      // `value` already carries the output buffered so far, so releasing the child cannot discard
      // it. Sweep the group before dropping the child from `live`, so nothing leaves the sweep set
      // still running. On the ordinary path the child exited and left an empty group behind and
      // killGroup sends nothing; when a grandchild is still holding the pipes the group is provably
      // this run's own, and it takes the SIGKILL that stops it outliving the call.
      killGroup(child);
      live.delete(child);
      for (const stream of [child.stdout, child.stderr, child.stdin]) stream?.destroy();
      resolve(value);
    };
    const result = (code) =>
      overflow ? { code, stdout, stderr, timedOut: false, overflow: true } : { code, stdout, stderr, timedOut };
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs ?? AGENT_TIMEOUT_MS);
    const guard = () => {
      if (!overflow && stdout.length + stderr.length > maxBufferBytes) {
        overflow = true;
        // A single "data" event can deliver a whole write in one chunk, so the
        // accumulator can already sit well past the cap by the time this fires —
        // truncate what's kept, not just what's kept from growing further.
        if (stdout.length > maxBufferBytes) stdout = stdout.slice(0, maxBufferBytes);
        killGroup(child);
      }
    };
    child.stdout.on("data", (d) => { stdout += d; guard(); });
    child.stderr.on("data", (d) => { stderr += d; guard(); });
    child.on("error", (err) => settle({ code: null, stdout, stderr: String(err), timedOut, spawnError: err }));
    child.on("exit", (code) => {
      // The child exited on its own; without this the timeout could still fire inside the drain
      // window and flip `timedOut` on a run that never timed out.
      clearTimeout(timer);
      drainTimer = setTimeout(() => settle(result(code)), DRAIN_GRACE_MS);
      child.once("close", () => settle(result(code)));
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
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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
    let envelope;
    try {
      envelope = JSON.parse(res.stdout);
    } catch {
      if (attempt === attempts) {
        return { ok: false, error: `unparseable ${errors.output} output: ${(res.stderr || res.stdout).slice(0, 300)}` };
      }
      continue;
    }
    if (!envelope.is_error && envelope.structured_output !== undefined) {
      // Every schema both engines pass is an object schema, so null / an array / a primitive here
      // is a validation failure (audit 2026-09-05 L3) and takes the retry path like an is_error envelope.
      if (!isPlainObject(envelope.structured_output)) {
        if (attempt === attempts) return { ok: false, error: `${errors.agent} returned a non-object structured output` };
        continue;
      }
      const cost = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
      return { ok: true, value: envelope.structured_output, cost };
    }
    if (attempt === attempts) {
      return { ok: false, error: `${errors.agent} error: ${envelope.result ?? res.stderr}`.slice(0, errors.cap) };
    }
  }
  return { ok: false, error: "unreachable" };
}

module.exports = { makeLogger, run, claudeStructured, DRAIN_GRACE_MS };
