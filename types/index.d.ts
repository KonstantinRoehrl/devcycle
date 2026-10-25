// The hooks module's `$.state` contract (hooks/devcycle-mod.mjs), named by plugin.json's `types`.
// DriveProgress mirrors the file scripts/drive-progress.mjs writes, schema v 1.
export type DriveStep = 'pending' | 'implementing' | 'reviewing' | 'fixing' | 'committing' | 'committed' | 'needs-user';
export type DriveTask = { task: string; step: DriveStep; round: number; rejections: number };
export type DriveWave = { wave: number; committed: number; tasks: DriveTask[] };
export type DriveProgress = {
  v: 1;
  state: 'running' | 'waiting' | 'stopped' | 'ended';
  session: number;
  model: string;
  effort: string;
  startedAt: string;
  updatedAt: string;
  waitUntil: string | null;
  waitWhat: string | null;
  stopDetail: string | null;
  outcome: string | null;
  currentWave: number | null;
  committed: number;
  total: number;
  waves: DriveWave[];
};
// What the band draws from: the parsed file (null when absent or unreadable), the spinner frame and
// the time the timer last ticked, in `$.clock.now()` milliseconds.
export type DriveBand = { progress: DriveProgress | null; frame: number; now: number };

declare module 'claude-code' {
  interface PluginState {
    devcycle: { band: DriveBand };
  }
}
