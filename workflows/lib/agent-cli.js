// agent-cli.js — the subprocess layer both workflow engines share.
//
// review-panel.js and mechanical-sweep.js each drive `claude` in print mode with
// a schema-validated envelope, and each needs the same three pieces: a tagged
// stderr logger, a buffered subprocess runner with a kill timeout, and the
// structured-agent call itself. They differ only in retry count, working
// directory, permission mode, and the words they put in their error strings —
// all parameters here, so neither engine keeps a private copy.
//
// spawnStreaming serves a third, different caller: the unattended execution
// driver, which streams one long `claude -p` session line by line instead of
// buffering a structured call.

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

// Every child run() has started and not yet settled. A detached child leads its own process group,
// so it no longer receives the terminal's Ctrl-C; the parent's own termination must reach it. A
// child is dropped from this set by settle(), which runs when `close` fires or the drain grace
// elapses, so a member is always either unreaped or still waiting on a holder of its pipes — the
// same evidence settle() kills on below.
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
// only still this run's while the group still has a member: POSIX will not recycle a pid that is an
// existing group's pgid, but the moment the group empties the kernel may hand the pid to a stranger
// who leads a group of their own. Asking the kernel does not separate the two — `kill(-pid, 0)`
// answers "some group has this pgid", which the stranger answers as well as we do — so the evidence
// has to come from the caller: call this only while the child is unreaped (timeout, overflow, the
// signal sweep), or while something is still demonstrably holding the group open (see settle()).
// The fallback to the direct child covers ESRCH in the window before the child has finished
// becoming its own group leader; after the reap its pid is no safer a target than its pgid, so the
// fallback stays on the unreaped side of the same rule.
function killGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }
}

// Spawn a child as the leader of its own process group, buffer its output, SIGKILL the group after
// timeoutMs. Settles on the child's `exit`, draining for DRAIN_GRACE_MS, not on `close`. Settling
// ends the call by contract, so it destroys the stdio pipes on every path and, where a survivor is
// still holding them, sweeps the group first: a grandchild that inherited those pipes would
// otherwise hold the parent's event loop open long after the promise resolved (the engine writes
// its report and then hangs). Never rejects:
// transport failures come back on the resolved value as { spawnError } or { timedOut } so callers
// branch on them instead of catching.
function run(cmd, args, { cwd, env, timeoutMs, maxBufferBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    hookSignals();
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    live.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let closed = false;
    let timer = null;
    let drainTimer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      // `value` already carries the output buffered so far, so releasing the child cannot discard
      // it. Sweep the group before dropping the child from `live`, so nothing leaves the sweep set
      // still running — but only on the evidence that the group still has a member. `close` fires
      // once every holder of the stdio pipes has let go, so settling without it means a survivor is
      // holding them: the group is non-empty, its pgid cannot have been recycled underneath us, and
      // the SIGKILL is exactly the one H5 is about. Settling with `close` already fired leaves no
      // holder to kill, and an empty group is precisely the pgid that may since have become a
      // stranger's — so that path signals nothing at all.
      if (!closed) killGroup(child);
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
      child.once("close", () => { closed = true; settle(result(code)); });
    });
    child.stdin.end();
  });
}

// Calls onLine once per complete line of `stream` as it arrives; the returned flush delivers a final
// line that had no trailing newline. Every chunk is consumed even without an onLine, so a chatty
// child never blocks on a full pipe.
function lineReader(stream, onLine) {
  let partial = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    if (onLine) for (const line of lines) onLine(line);
  });
  return () => {
    if (partial && onLine) onLine(partial);
    partial = "";
  };
}

// Spawn a long-running child — the unattended driver's `claude -p` session — as the leader of its
// own process group and stream its output line by line. Unlike run() there is no timeout, no output
// cap and no signal hook: a caller that lives for hours installs its own SIGINT/SIGTERM/SIGHUP
// handlers and ends the child through killGroup. `env` is passed through exactly as given. `done`
// settles the way run() does — on `close`, or DRAIN_GRACE_MS after `exit` with a sweep of a group a
// survivor still holds — and resolves { code, signal }; both are null only when the binary never
// started, because a process that ran always exits with one or the other.
function spawnStreaming(cmd, args, { cwd, env, onStdoutLine, onStderrLine } = {}) {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const flushes = [lineReader(child.stdout, onStdoutLine), lineReader(child.stderr, onStderrLine)];
  const done = new Promise((resolve) => {
    let settled = false;
    let closed = false;
    let drainTimer = null;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      if (!closed) killGroup(child); // same evidence rule as run(): no `close` means a survivor holds the group
      for (const flush of flushes) flush();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(status);
    };
    child.on("error", () => {
      closed = true; // nothing was started, so there is no group to sweep
      settle({ code: null, signal: null });
    });
    child.on("exit", (code, signal) => {
      drainTimer = setTimeout(() => settle({ code, signal }), DRAIN_GRACE_MS);
      child.once("close", () => {
        closed = true;
        settle({ code, signal });
      });
    });
  });
  return { child, done };
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
    // Marks the child as devcycle's own `claude -p`, where the hooks module (hooks/devcycle-mod.mjs)
    // stays inert; codex and /bin/sh children go through run() without it.
    const res = await run("claude", argv, { cwd, env: { ...process.env, DEVCYCLE_NESTED_RUN: "1" } });
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

module.exports = { makeLogger, run, spawnStreaming, killGroup, claudeStructured, DRAIN_GRACE_MS };
