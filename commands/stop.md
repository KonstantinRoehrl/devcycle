---
description: "Stop a devcycle cycle now, at any stage, and record where it was so /devcycle:continue resumes at that step. Side-effectful — signals what the cycle started and rewrites its state."
disable-model-invocation: true
---

# /devcycle:stop

Stop a cycle now and leave it ready to resume. Stopping is the point: once the cycle is chosen, act
immediately. Ask nothing and confirm nothing, and do not finish the work in hand first.

Every Bash call below is one plain `node` run of `stop-cycle.mjs`, exactly as written, with nothing
chained to it. From step 2 until step 4 returns, `hooks/stop-guard.mjs` denies a session joined to the
cycle every other tool call, so use no other tool for reading or checking, this session included.

1. **Choose the cycle.** Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-cycle.mjs" list
   ```

   Its `candidates` decide:

   - None: say no cycle is in flight in this repo, change nothing, and end here.
   - A candidate with `foreign: true`: its state file came from another checkout. Never stop it. Say
     so, and name its `request`, if it is the only one.
   - One other candidate: it is the cycle. Ask nothing.
   - Several: ask which with `AskUserQuestion`, naming each one's `request`, `stage` and `branch`.
     This is the only question this command asks, and it comes before the guard starts.

2. **Request the stop.** With the chosen candidate's `state` as `<state>`, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-cycle.mjs" request --state "<state>"
   ```

   This starts the guard, stops a running unattended driver and the on-device app, and prints the JSON
   the next steps read. With `requested: false`, report its `reason` and end here.

3. **Stop this session's own work.** For each entry in `owned`, call `TaskStop` with the literal input
   `{"task_id": "<id>"}`. If `TaskStop` is not loaded, load it with `ToolSearch` and the exact query
   `select:TaskStop`, the one search the guard allows; if that fails, call `TaskStop` directly anyway.
   A failed `TaskStop` does not end the stop: go on, and step 4 reports that entry as left running.
   Only the session that started a task can stop it, so `otherSessions` gets no call here.

4. **Finalize.** Run this once. It waits for the guard to go quiet, which takes ten to sixty seconds,
   so do not poll or retry it:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-cycle.mjs" finalize --state "<state>"
   ```

5. **Report, then end your turn.** From `finalize`'s JSON, in plain language:

   - The stage it stopped in and its position: `record.stage` and `record.position.summary`.
   - What was stopped: each `stopped` entry's `id`, `kind` and `how`.
   - What was left running: each `left` entry's `id`, `kind` and `reason`, word for word, since the
     `reason` says how to stop it. If `left` is empty, say only that the stop found nothing still
     running among the cycle's dispatch records and the background work it tracks.
   - That edits stay on disk, with the paths in `record.uncommitted`. A stop deletes, commits and
     resets nothing.
   - The stop record's `path`, and how to resume only as `references/handoff.md` § Never name the
     clear while work is in flight allows a stop to.

   Report per `${CLAUDE_PLUGIN_ROOT}/references/output.md`.

A stop that was cut short can simply be run again: each step repeats safely and keeps what the first
run recorded.
