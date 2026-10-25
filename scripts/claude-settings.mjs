// Claude Code's own settings, read as Claude Code reads them: the config home (CLAUDE_CONFIG_DIR when
// set, ~/.claude otherwise) and the effort a session started in a checkout runs at.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
// Claude Code's settings schema takes only these four: a "max" in a file is dropped as if unset, while
// --effort and CLAUDE_EFFORT (the active turn's effort) can carry it.
const SETTINGS_EFFORT_LEVELS = EFFORT_LEVELS.filter((level) => level !== "max");

export function claudeConfigHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// Local, then project, then user settings; a missing or unparseable file is skipped.
function settingsFiles(env, cwd) {
  const paths = [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(claudeConfigHome(env), "settings.json")];
  return paths.flatMap((path) => {
    try {
      return [{ path, settings: JSON.parse(readFileSync(path, "utf8")) }];
    } catch {
      return [];
    }
  });
}

// The effort precedence of docs/decisions/README.md (2026-10-25): CLAUDE_EFFORT, else the first
// modelSettings["<model>"].effortLevel, else the first effortLevel, else Claude Code's default. The
// first value found decides: one outside the levels its source takes is unresolvable, never passed over
// for a later one. A file's "max" is no value found at all, since Claude Code does not read it either.
export function resolveEffort({ env = process.env, cwd = process.cwd(), model }) {
  const level = (source, where, value, levels) => (levels.includes(value)
    ? { effort: value, source }
    : { effort: null, source, problem: `${where} is ${JSON.stringify(value)}, not one of ${levels.join(", ")}` });
  if (env.CLAUDE_EFFORT) return level("env", "CLAUDE_EFFORT", env.CLAUDE_EFFORT, EFFORT_LEVELS);
  const set = (value) => value !== undefined && value !== "max";
  const files = settingsFiles(env, cwd);
  const perModel = model ? files.find(({ settings }) => set(settings?.modelSettings?.[model]?.effortLevel)) : undefined;
  if (perModel) return level("modelSettings", `modelSettings["${model}"].effortLevel in ${perModel.path}`, perModel.settings.modelSettings[model].effortLevel, SETTINGS_EFFORT_LEVELS);
  const shared = files.find(({ settings }) => set(settings?.effortLevel));
  if (shared) return level("effortLevel", `effortLevel in ${shared.path}`, shared.settings.effortLevel, SETTINGS_EFFORT_LEVELS);
  return { effort: "default", source: "default" };
}
