import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// #147: comparing import.meta.url to the raw entry path silently skips main() whenever the entry
// is reached through a symlink (the plugin cache, macOS /var → /private/var). Node usually runs a
// module from its real path, but --preserve-symlinks-main keeps import.meta.url on the symlink, so
// both sides are resolved. An entry that does not resolve is not this file.
export function isMain(metaUrl, entryPath) {
  if (!entryPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}
