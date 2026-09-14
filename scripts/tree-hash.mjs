// Content-identity for a directory tree: which exact bytes are installed, independent of any
// version string or VCS state. Used by the self-development landing guard (is the installed plugin
// being written to?) and by the run record's plugin identifier (which bits produced this run?).
// lstat, not stat: a symlink is never followed, so a cyclic link cannot make the walk unbounded.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function hashTree(root) {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile())
        files[relative(root, abs).split(sep).join("/")] =
          createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(root);
  // Sorted path+hash pairs, so the rolling digest is stable across filesystems whose readdir
  // order differs. The NUL separators keep "ab"+"c" from colliding with "a"+"bc".
  const roll = createHash("sha256");
  for (const p of Object.keys(files).sort()) roll.update(`${p}\0${files[p]}\0`);
  return { files, digest: roll.digest("hex") };
}

// The run-record schema pins pluginSha to ^[0-9a-f]{7,40}$, so a full SHA-256 does not fit.
// Truncating keeps every existing record valid and needs no schema migration.
export const digest40 = (digest) => digest.slice(0, 40);

export function compareManifests(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const p of Object.keys(after)) {
    if (!(p in before)) added.push(p);
    else if (before[p] !== after[p]) changed.push(p);
  }
  for (const p of Object.keys(before)) if (!(p in after)) removed.push(p);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}
