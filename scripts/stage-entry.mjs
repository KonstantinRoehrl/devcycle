// Which playbook or skill each stage is entered through, and its re-entry note, read from
// references/stages.json — the stage dispatch's single owner. resume-check.mjs and
// find-state-files.mjs print the same two lines, so neither command opens references/resume.md
// to find an entry.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
// DEVCYCLE_STAGES_PATH lets a test point the loader at a broken table; nothing else sets it.
export const stagesPath = () => process.env.DEVCYCLE_STAGES_PATH || join(PLUGIN_ROOT, "references/stages.json");

const ENTRY = /^(?:playbooks\/[a-z0-9-]+\.md|superpowers:[a-z-]+)$/;
const BARE_PATH = /(?<![\w./}-])((?:references|playbooks|commands)\/[a-z0-9-]+\.md)/g;

export function loadStages(path = stagesPath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  let table;
  try {
    table = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON — ${err.message}`);
  }
  if (typeof table !== "object" || table === null || Array.isArray(table))
    throw new Error(`${path} must be a JSON object mapping each stage to { entry, note }`);
  for (const [stage, spec] of Object.entries(table)) {
    if (typeof spec?.entry !== "string" || !ENTRY.test(spec.entry))
      throw new Error(`${path}: "${stage}".entry must be playbooks/<file>.md or superpowers:<skill>, got ${JSON.stringify(spec?.entry)}`);
    if (typeof spec.note !== "string")
      throw new Error(`${path}: "${stage}".note must be a string (empty when the entry needs no note)`);
  }
  return table;
}

// The session reading these lines runs in the user's repo, where a plugin-relative path resolves
// to nothing — so a playbook entry, and any surface path in the note, prints absolute.
export function stageEntry(stage, { path = stagesPath(), root = PLUGIN_ROOT } = {}) {
  const table = loadStages(path);
  if (!Object.hasOwn(table, stage)) throw new Error(`no entry for stage "${stage}" in ${path}`);
  const { entry, note } = table[stage];
  return {
    entry: entry.startsWith("playbooks/") ? join(root, entry) : entry,
    note: note.replace(BARE_PATH, (m) => join(root, m)),
  };
}

export const entryLines = ({ entry, note }) => [`entry: ${entry}`, `note: ${note || "none"}`];
