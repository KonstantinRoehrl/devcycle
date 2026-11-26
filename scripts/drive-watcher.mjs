// Which session is the driver session of an unattended run, and that session's last usage record. Every
// driver session waits through `--wait` (references/drive.md), and its `--wait` registers it here; the
// band's heartbeat takes the latest live registration. A `--detach` driver outlives the session that
// started it, which is why the session id is not captured once at start. The file sits beside the state
// file and its readers are the driver's heartbeat and the driver sessions' own `--wait`.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { contextDepth, lastUsageOf } from "./depth-probe.mjs";
import { sessionSlugDir } from "./dispatch-health.mjs";
import { isLiveHolder, processStartTime } from "./file-lock.mjs";
import { lastRecord } from "./jsonl.mjs";

export const WATCHER_FILE = "drive-watcher.json";

export const watcherPath = (statePath) => join(dirname(statePath), WATCHER_FILE);

// The recorded start time is what tells a watcher's pid from a later process the OS gave the same pid;
// an entry without one (written before it was recorded, or its start unreadable) reads live while its pid exists.
const isLive = (w) => isLiveHolder({ pid: w.pid, startTime: w.startTime ?? null });

// A missing or unparseable file reads as no watchers; only entries of the written shape are kept.
function readWatchers(statePath) {
  try {
    const { watchers } = JSON.parse(readFileSync(watcherPath(statePath), "utf8"));
    return Array.isArray(watchers) ? watchers.filter((w) => typeof w?.sessionId === "string" && Number.isInteger(w.pid)) : [];
  } catch {
    return [];
  }
}

function writeWatchers(statePath, watchers) {
  if (watchers.length === 0) rmSync(watcherPath(statePath), { force: true });
  else atomicWrite(watcherPath(statePath), `${JSON.stringify({ v: 1, watchers })}\n`);
}

export function registerWatcher({ statePath, sessionId, pid = process.pid, now = Date.now(), isAlive = isLive }) {
  const kept = readWatchers(statePath).filter((w) => w.sessionId !== sessionId && w.pid !== pid && isAlive(w));
  const startTime = processStartTime(pid);
  writeWatchers(statePath, [...kept, { sessionId, pid, ...(startTime && { startTime }), startedAt: new Date(now).toISOString() }]);
}

export function unregisterWatcher({ statePath, pid = process.pid }) {
  if (!existsSync(watcherPath(statePath))) return;
  writeWatchers(statePath, readWatchers(statePath).filter((w) => w.pid !== pid));
}

export function liveWatcher({ statePath, isAlive = isLive }) {
  const live = readWatchers(statePath).filter((w) => isAlive(w));
  return live.length ? live.at(-1) : null;
}

export function driverTier({ statePath, env = process.env, isAlive = isLive }) {
  const watcher = liveWatcher({ statePath, isAlive });
  const dir = watcher && sessionSlugDir(watcher.sessionId, env);
  if (!dir) return null;
  const r = lastRecord(join(dir, `${watcher.sessionId}.jsonl`), (rec) => (lastUsageOf(rec) ? rec : null));
  return r && {
    watcher: true,
    model: r.message.model,
    effort: typeof r.effort === "string" ? r.effort : null,
    tokens: contextDepth(r.message.usage),
  };
}
