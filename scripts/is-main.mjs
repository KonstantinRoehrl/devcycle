import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// #147: Node runs a module from its real path, so comparing import.meta.url to the raw entry path
// silently skips main() whenever the entry is reached through a symlink (the plugin cache, macOS
// /var → /private/var). Resolve the entry first; an entry that does not resolve is not this file.
export function isMain(metaUrl, entryPath) {
  if (!entryPath) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}
