// scripts/md-field.mjs
// The single "- key: value" markdown-field-line reader for devcycle's state / checkpoint /
// record files, extracted from three drifted copies in dream.mjs, promotions.mjs, and
// resume-check.mjs (maintenance finding unrecorded-duplication:581e1153), and the single scan of
// a per-file record directory, which the promotions and maintenance-findings stores share.
// `[ \t]*` — never `\s*` — stops the capture at the field's own newline, so a field left blank on
// its own line cannot read the following "- key:" line back as its value. A miss returns null, the
// honest sentinel: "" is a legitimate present-but-blank value. Callers needing string semantics
// (`.split(",")`, defaulting) use fieldText.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function field(text, key) {
  const m = String(text).match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

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
