// What a cycle started that only its session can stop: subagents, background shells, Monitors and
// workflows, none of which the platform gives a pid for. Append-only JSONL: this
// module writes it, hooks/process-sensor.mjs feeds it, and reads fold every line of an id into one entry.
import { appendFileSync } from "node:fs";
import { withFileLock } from "./file-lock.mjs";
import { eachRecord } from "./jsonl.mjs";
import { stopPaths } from "./stop-files.mjs";

const KINDS = new Set(["subagent", "shell", "monitor", "workflow"]);
const END_REASONS = new Set(["taskstop", "finished", "absent"]);
// The only kinds Stop's background_tasks lists: a running Monitor is absent from it, so its absence
// proves nothing (docs/platform-notes.md).
const SNAPSHOT_KINDS = new Set(["shell", "subagent"]);
// Well inside the sensor's 5 s hook timeout, so a stuck lock costs one line and never the hook.
const LOCK = { timeoutMs: 2000 };

const processesFile = (devcycleDir) => stopPaths(devcycleDir).processes;
const locked = (devcycleDir, fn) => withFileLock(processesFile(devcycleDir), fn, LOCK);
const append = (devcycleDir, line) => appendFileSync(processesFile(devcycleDir), JSON.stringify(line) + "\n");

export function readProcesses(devcycleDir) {
  const byId = new Map();
  eachRecord(processesFile(devcycleDir), (line) => {
    if (typeof line?.id === "string") byId.set(line.id, { ...byId.get(line.id), ...line });
  });
  return [...byId.values()];
}

const isKnown = (devcycleDir, id) => readProcesses(devcycleDir).some((entry) => entry.id === id);

export function recordProcess(devcycleDir, { id, kind, session, run, stage, startedAt, expiresAt, ref }) {
  if (!KINDS.has(kind)) throw new Error(`a process kind is subagent, shell, monitor or workflow, got "${kind}"`);
  return locked(devcycleDir, () => {
    if (isKnown(devcycleDir, id)) return false;
    append(devcycleDir, { id, kind, session, run, stage, startedAt, expiresAt, ref });
    return true;
  });
}

const retireLine = (id, { endedAt, endedBy }) => {
  if (!END_REASONS.has(endedBy)) throw new Error(`a process ends by taskstop, finished or absent, got "${endedBy}"`);
  return { id, endedAt, endedBy };
};

// The first end stands, and an id the registry never recorded stays unrecorded: a foreground subagent's
// SubagentStop lands here too.
export function retireProcess(devcycleDir, id, { endedAt, endedBy }) {
  const line = retireLine(id, { endedAt, endedBy });
  return locked(devcycleDir, () => {
    const entry = readProcesses(devcycleDir).find((e) => e.id === id);
    if (!entry || entry.endedAt) return false;
    append(devcycleDir, line);
    return true;
  });
}

const isOpen = (entry, now) => !entry.endedAt && !(entry.expiresAt && Date.parse(entry.expiresAt) <= now);

export function openProcesses(devcycleDir, { run, now = Date.now() }) {
  return readProcesses(devcycleDir).filter((entry) => entry.run === run && isOpen(entry, now));
}

export function reconcileSnapshot(devcycleDir, { session, run, tasks, now = Date.now() }) {
  const listed = new Set(tasks.map((task) => task?.id));
  const endedAt = new Date(now).toISOString();
  return locked(devcycleDir, () => {
    const gone = readProcesses(devcycleDir).filter((entry) =>
      entry.session === session && entry.run === run && SNAPSHOT_KINDS.has(entry.kind) && !entry.endedAt && !listed.has(entry.id));
    for (const entry of gone) append(devcycleDir, retireLine(entry.id, { endedAt, endedBy: "absent" }));
    return gone.map((entry) => entry.id);
  });
}
