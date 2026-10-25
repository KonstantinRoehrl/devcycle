// Claude Code's own settings, read as Claude Code reads them: the config home (CLAUDE_CONFIG_DIR when
// set, ~/.claude otherwise) and the effort a session started in a checkout runs at.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

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
// first value found decides: one outside EFFORT_LEVELS is unresolvable, never passed over for a later one.
export function resolveEffort({ env = process.env, cwd = process.cwd(), model }) {
  const level = (source, where, value) => (EFFORT_LEVELS.includes(value)
    ? { effort: value, source }
    : { effort: null, source, problem: `${where} is ${JSON.stringify(value)}, not one of ${EFFORT_LEVELS.join(", ")}` });
  if (env.CLAUDE_EFFORT) return level("env", "CLAUDE_EFFORT", env.CLAUDE_EFFORT);
  const files = settingsFiles(env, cwd);
  const perModel = model ? files.find(({ settings }) => settings?.modelSettings?.[model]?.effortLevel !== undefined) : undefined;
  if (perModel) return level("modelSettings", `modelSettings["${model}"].effortLevel in ${perModel.path}`, perModel.settings.modelSettings[model].effortLevel);
  const shared = files.find(({ settings }) => settings?.effortLevel !== undefined);
  if (shared) return level("effortLevel", `effortLevel in ${shared.path}`, shared.settings.effortLevel);
  return { effort: "default", source: "default" };
}
