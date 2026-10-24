// Proves one commit green where no sibling's uncommitted edit can reach it (#324, #336): the gate
// command runs in a scratch worktree detached at the commit, so a red there is the commit's own and
// a green is a green of the commit that landed. scripts/task-commit.mjs is its one caller, and running
// the gate, committing and the ledger are coordinator duties (references/delegation.md § Coordinator
// duties), never a dispatch's. A worktree a crash leaves registered names a directory makeTempDir's
// exit handler removes, and git's own gc prunes such registrations (gc.worktreePruneExpire).
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./temp-dir.mjs";
import { runShell } from "./evidence-capture.mjs";

export const PROOF_PREFIX = "# devcycle-proof:";
export const LIMIT_PREFIX = "# devcycle-proof-limit:";
const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv", "vendor"]);
const SUBMODULE_LIMIT = "submodules (.gitmodules) are not populated in the proof worktree";

const git = (cwd, args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.error || r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(r.stderr ?? "").trim() || r.error?.message || `exit ${r.status}`}`);
  return r.stdout;
}

export const proofLine = ({ sha, tree, parent }) => `${PROOF_PREFIX} sha=${sha} tree=${tree} parent=${parent}`;

// A gate capture proves `sha` green when its proof line names that sha and the run's own exit line,
// the one right before it, reads 0. The gate's output may print an exit line of its own.
export function provesGreen(captureText, sha) {
  const lines = captureText.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${PROOF_PREFIX} sha=${sha} `));
  return at > 0 && lines[at - 1] === "# exit 0";
}

// The path inside the shared checkout a symlink resolves to, or null when it resolves outside it or
// nowhere.
function checkoutRelative(realRoot, linkPath) {
  let real;
  try {
    real = realpathSync(linkPath);
  } catch {
    return null;
  }
  const rel = relative(realRoot, real);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : null;
}

// npm, yarn and pnpm link workspace packages from node_modules back into the checkout's own sources,
// at its top level and under @scope/. Keyed by the entry's path inside node_modules.
function workspaceLinks(realRoot, nodeModules) {
  const links = new Map();
  const visit = (rel) => {
    for (const entry of readdirSync(join(nodeModules, rel), { withFileTypes: true })) {
      const entryRel = join(rel, entry.name);
      if (!rel && entry.isDirectory() && entry.name.startsWith("@")) visit(entryRel);
      else if (entry.isSymbolicLink()) {
        const inside = checkoutRelative(realRoot, join(nodeModules, entryRel));
        if (inside !== null) links.set(entryRel, inside);
      }
    }
  };
  visit("");
  return links;
}

// Linked whole, a node_modules holding workspace links would hand the proof the shared checkout's
// uncommitted sources. Such a one is rebuilt as a real directory of per-entry links instead, each
// in-checkout link pointed at the same path inside the worktree. `.bin` is rebuilt too, its links
// copied verbatim: a relative one (`../<package>/cli.js`) then resolves through the worktree's
// retargeted package links rather than through the shared checkout's.
function linkNodeModules(realRoot, worktree, source, target) {
  const links = workspaceLinks(realRoot, source);
  if (!links.size) return symlinkSync(source, target);
  const scopes = new Set([...links.keys()].filter((k) => k.includes("/")).map((k) => k.split("/")[0]));
  const build = (rel) => {
    mkdirSync(join(target, rel), { recursive: true });
    for (const entry of readdirSync(join(source, rel), { withFileTypes: true })) {
      const entryRel = join(rel, entry.name);
      if (links.has(entryRel)) symlinkSync(join(worktree, links.get(entryRel)), join(target, entryRel));
      else if (!rel && (scopes.has(entry.name) || (entry.name === ".bin" && entry.isDirectory()))) build(entryRel);
      else if (rel === ".bin" && entry.isSymbolicLink()) symlinkSync(readlinkSync(join(source, entryRel)), join(target, entryRel));
      else symlinkSync(join(source, entryRel), join(target, entryRel));
    }
  };
  build("");
}

// An editable install (`pip install -e`) points a venv back at the shared checkout's sources. It is
// reported as a known limit of the proof, never rewritten.
function editableInstalls(realRoot, root, venvRel) {
  const venv = join(root, venvRel);
  const sitePackages = [join(venv, "Lib", "site-packages")];
  if (existsSync(join(venv, "lib")))
    for (const python of readdirSync(join(venv, "lib"))) sitePackages.push(join(venv, "lib", python, "site-packages"));
  const limits = [];
  for (const dir of sitePackages.filter((d) => existsSync(d)))
    for (const name of readdirSync(dir)) {
      if (!/\.(pth|egg-link)$/.test(name) && !name.startsWith("__editable__")) continue;
      const file = join(dir, name);
      if (!lstatSync(file).isFile()) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes(realRoot) || text.includes(root))
        limits.push(`editable install ${relative(root, file)} points into the shared checkout`);
    }
  return limits;
}

// Ignored dependency directories at any depth, listed once by git: --directory collapses an ignored
// directory to one entry, so nothing inside one is walked. Each is linked into the worktree at the
// same path, unless that path exists there already or its parent does not. A link is a symlink, which
// a `dir/` ignore pattern does not match, so the worktree's own `git status` lists it as untracked.
export function linkDependencyDirs(root, worktree) {
  const realRoot = realpathSync(root);
  const dirs = gitOut(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
    .split("\0").filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1))
    .filter((p) => DEPENDENCY_DIRS.has(basename(p)));
  const limits = [];
  for (const rel of dirs) {
    const target = join(worktree, rel);
    if (existsSync(target) || !existsSync(dirname(target))) continue;
    if (basename(rel) === "node_modules") linkNodeModules(realRoot, worktree, join(root, rel), target);
    else {
      symlinkSync(join(root, rel), target);
      if (basename(rel) === "vendor") limits.push(`${rel} is linked whole: a Composer path repository in it can read the shared checkout`);
      else limits.push(...editableInstalls(realRoot, root, rel));
    }
  }
  return limits;
}

// Runs `testCmd` in a scratch worktree detached at `sha` and always removes it again. A proof that
// cannot run — no worktree, temp dir, link or spawn — is a failed run carrying the reason and marked
// `unrunnable`, never a throw: the caller undoes the commit either way, but a gate that never ran
// says nothing about the task.
export function proveCommit(root, sha, testCmd) {
  const [tree, parent = "none"] = gitOut(root, ["show", "-s", "--format=%T %P", sha]).trim().split(" ");
  const proof = { sha, tree, parent };
  let dir = null;
  try {
    dir = makeTempDir("devcycle-proof-");
    const add = git(root, ["worktree", "add", "--quiet", "--detach", dir, sha]);
    if (add.status !== 0)
      return { proof, limits: [], unrunnable: true, run: { cmd: testCmd, status: add.status ?? 1, output: `devcycle: the proof worktree could not be made: ${(add.stderr ?? "").trim()}\n` } };
    const limits = [...(existsSync(join(dir, ".gitmodules")) ? [SUBMODULE_LIMIT] : []), ...linkDependencyDirs(root, dir)];
    return { proof, limits, unrunnable: false, run: runShell(dir, testCmd) };
  } catch (err) {
    return { proof, limits: [], unrunnable: true, run: { cmd: testCmd, status: 1, output: `devcycle: the proof could not run: ${err.message}\n` } };
  } finally {
    if (dir) {
      git(root, ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
