// Proves one commit green where no sibling's uncommitted edit can reach it (#324, #336): the gate
// command runs in a scratch worktree detached at the commit, so a red there is the commit's own and
// a green is a green of the commit that landed. scripts/task-commit.mjs is its one caller, run by
// the coordinator; a guarded dispatch could not run it, since hooks/block-destructive-git.mjs denies
// it `git worktree`. A worktree a crash leaves registered names a directory makeTempDir's exit
// handler removes, and git's own gc prunes such registrations (gc.worktreePruneExpire).
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./temp-dir.mjs";
import { runShell } from "./evidence-capture.mjs";

export const PROOF_PREFIX = "# devcycle-proof:";
export const LIMIT_PREFIX = "# devcycle-proof-limit:";

const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.error || r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}`}`);
  return r.stdout;
}

export const proofLine = ({ sha, tree, parent }) => `${PROOF_PREFIX} sha=${sha} tree=${tree} parent=${parent}`;

// A gate capture proves `sha` green when its proof line names that sha and its run exited 0.
export function provesGreen(captureText, sha) {
  const lines = captureText.split("\n");
  return lines.includes("# exit 0") && lines.some((l) => l.startsWith(`${PROOF_PREFIX} sha=${sha} `));
}

// Runs `testCmd` in a scratch worktree detached at `sha` and always removes it again. A worktree that
// cannot be made is a failed run carrying the reason, never a throw: the caller undoes the commit
// either way.
export function proveCommit(root, sha, testCmd) {
  const [tree, parent = "none"] = gitOut(root, ["show", "-s", "--format=%T %P", sha]).trim().split(" ");
  const proof = { sha, tree, parent };
  let dir = null;
  try {
    dir = makeTempDir("devcycle-proof-");
    const add = git(root, ["worktree", "add", "--quiet", "--detach", dir, sha]);
    if (add.status !== 0)
      return { proof, limits: [], run: { cmd: testCmd, status: add.status ?? 1, output: `devcycle: the proof worktree could not be made: ${(add.stderr ?? "").trim()}\n` } };
    return { proof, limits: [], run: runShell(dir, testCmd) };
  } catch (err) {
    return { proof, limits: [], run: { cmd: testCmd, status: 1, output: `devcycle: the proof could not run: ${err.message}\n` } };
  } finally {
    if (dir) {
      git(root, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
