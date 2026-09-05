// Bounded upward walk from `start` for the directory holding `.devcycle/state.md`. Shared by the
// PostToolUse commit-sensor (hooks/workload-sensor.mjs) and the PreToolUse git guard
// (hooks/block-destructive-git.mjs), which both key off the hook input's `cwd`. No git spawn: the
// idle path — a Bash call outside any cycle, the common case — must stay near-free.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export function findStateFile(start) {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const p = join(dir, ".devcycle", "state.md");
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
