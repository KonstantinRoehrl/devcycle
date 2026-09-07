// #257: a mkdtempSync fixture used to outlive the process that made it. On a machine whose
// tmpdir() is not cleared per run — Claude Code's sandboxed bash maps /tmp to a root that
// survives until reboot — that accumulated ~60GB/day of dead fixtures.
//
// The owner of a temp directory's lifetime is this module, not the call site: creation
// registers the directory, and one exit handler removes every registered directory when the
// process ends. Both the test suite and the scripts use it, which is why it lives under
// scripts/ rather than tests/ — tests/ is not importable from production code.
//
// What this does NOT cover: a process killed uncatchably (kill -9) runs no exit handler, so a
// fixture leaked that way stays leaked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pending = [];
let armed = false;

function removeAll() {
  while (pending.length > 0) {
    const dir = pending.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Deliberately swallowed, and only here. An exception thrown from an exit handler
      // changes the process's exit status, so one undeletable fixture would turn a passing
      // test run red — a worse failure than the leak this module exists to prevent.
    }
  }
}

// Creates a temp directory under tmpdir() and returns its absolute path. The directory is
// removed when this process exits; callers neither can nor should remove it themselves.
export function makeTempDir(prefix) {
  if (!armed) {
    // Armed once, not per call: tests/unit/doctor.test.mjs alone makes 30 of these, and one
    // listener each would trip Node's max-listeners warning on every run.
    process.on("exit", removeAll);
    armed = true;
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pending.push(dir);
  return dir;
}
