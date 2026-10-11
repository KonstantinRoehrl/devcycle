// scripts/md-field.mjs
// The single "- key: value" markdown-field-line reader for devcycle's state / checkpoint /
// record files, extracted from three drifted copies in dream.mjs, promotions.mjs, and
// resume-check.mjs (maintenance finding unrecorded-duplication:581e1153), and the single scan of
// a per-file record directory, which the promotions and maintenance-findings stores share.
// The parser itself is md-field-core.mjs's, re-exported here. Callers needing string semantics
// (`.split(",")`, defaulting) use fieldText.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { field } from "./md-field-core.mjs";

export { field };

export const fieldText = (text, key) => field(text, key) ?? "";

// A record's title is its first "# " heading; a record with none, or a blank one, reads as "".
export const recordTitle = (text) => (String(text).match(/^# (.*)$/m) ?? [, ""])[1].trim();

// Every record file in a store directory: each "*.md" but README.md, in name order, read whole.
// A missing directory is an empty store, not an error.
export function readRecordDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      return { file, text, title: recordTitle(text) };
    });
}
