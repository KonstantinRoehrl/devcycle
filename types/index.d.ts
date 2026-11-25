// The hooks module's `$.state` contract (hooks/devcycle-mod.mjs), named by plugin.json's `types`.
// DriveProgress mirrors the file scripts/drive-progress.mjs writes: schema v 2, and v 1 for a file an older driver left.
export type DriveStep = 'pending' | 'implementing' | 'reviewing' | 'fixing' | 'committing' | 'committed' | 'needs-user';
export type DriveHealth = { state: string; elapsedMs: number; toolUses: number; sinceActivityMs: number };
// The live dispatch behind a running or quiet task: who runs it, how deep it is and how it was routed.
export type DriveDispatch = {
  role: string; model?: string; effort?: string; tokens?: number; window?: number; windowAssumed?: true; routing?: string;
};
// One tier of the band: the driver session or the driven session. `window` is the model's context window.
export type DriveTier = { model?: string; effort?: string; tokens?: number; window?: number; windowAssumed?: true };
export type DriveTaskV1 = { task: string; step: DriveStep; round: number; rejections: number; health?: DriveHealth };
export type DriveTaskV2 = DriveTaskV1 & { dispatch?: DriveDispatch };
export type DriveWave<T = DriveTaskV2> = { wave: number; committed: number; tasks: T[] };
export type DriveRun = {
  state: 'running' | 'waiting' | 'stopped' | 'ended';
  startedAt: string;
  updatedAt: string;
  waitUntil: string | null;
  waitWhat: string | null;
  stopDetail: string | null;
  outcome: string | null;
  currentWave: number | null;
  committed: number;
  total: number;
};
export type DriveProgressV1 = DriveRun & {
  v: 1;
  session: number;
  model: string;
  effort: string;
  waves: DriveWave<DriveTaskV1>[];
};
export type DriveProgressV2 = DriveRun & {
  v: 2;
  driver: DriveTier & { watcher: boolean };
  session: (DriveTier & { n: number; startedAt: string }) | null;
  waves: DriveWave<DriveTaskV2>[];
};
export type DriveProgress = DriveProgressV1 | DriveProgressV2;
// What the band draws from: the parsed file (null when absent or unreadable), the spinner frame and
// the time the timer last ticked, in `$.clock.now()` milliseconds.
export type DriveBand = { progress: DriveProgress | null; frame: number; now: number };

declare module 'claude-code' {
  interface PluginState {
    devcycle: { band: DriveBand };
  }
}
