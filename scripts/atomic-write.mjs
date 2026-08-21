// One owner for crash- and concurrency-safe file writes across the scripts. A bare writeFileSync
// truncates the target before writing, so a reader (or a parallel worktree) can catch it empty or
// half-written; the .devcycle sidecars a playbook reads back must never be seen in that state.
// Writing a temp file in the SAME directory and renameSync-ing it into place is atomic on one
// filesystem — the target flips from old to new in a single step, never a truncated middle.
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
