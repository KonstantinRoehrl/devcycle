// The "- key: value" markdown-field-line parser, with no import at all, so the hooks module
// (hooks/devcycle-mod.mjs), which runs without Node, reads the state file by the rule every script
// uses; scripts/md-field.mjs re-exports it beside the readers that need the filesystem.
// `[ \t]*` — never `\s*` — stops the capture at the field's own newline, so a field left blank on
// its own line cannot read the following "- key:" line back as its value. A miss returns null, the
// honest sentinel: "" is a legitimate present-but-blank value.
export function field(text, key) {
  const m = String(text).match(new RegExp(`^- ${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : null;
}
