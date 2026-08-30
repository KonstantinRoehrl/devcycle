// scripts/md-field.mjs
// The single "- key: value" markdown-field-line reader for devcycle's state / checkpoint /
// record files, extracted from three drifted copies in dream.mjs, promotions.mjs, and
// resume-check.mjs (maintenance finding unrecorded-duplication:581e1153). `[ \t]*` — never
// `\s*` — stops the capture at the field's own newline, so a field left blank on its own line
// cannot read the following "- key:" line back as its value. A miss returns null, the honest
// sentinel: "" is a legitimate present-but-blank value. Callers needing string semantics
// (`.split(",")`, defaulting) use fieldText.

export function field(text, key) {
  const m = String(text).match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

export const fieldText = (text, key) => field(text, key) ?? "";
