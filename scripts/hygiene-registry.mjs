// The hygiene sweeps' registry loader and structural validator. references/hygiene-sweeps.json is the
// single owner of the stacks, culprit kinds, scanners, config defaults and tool pins/invocations;
// scripts/validate.mjs (check 30) runs validateRegistry on it at every gate.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REGISTRY_PATH = fileURLToPath(new URL("../references/hygiene-sweeps.json", import.meta.url));

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SIGNAL_RE = /^(\*\.[A-Za-z0-9]+|[^/*]+)$/;
const VERSION_RE = /^v?\d+(\.\d+)*$/;
const SEVERITIES = ["critical", "high", "medium", "low"];
const ADAPTERS = ["knip", "tsc", "raw"];
const OUTPUT_FORMATS = ["lines", "cargo-machete", "purgecss-json"];
const MODES = ["static", "executing"];
const FORBIDDEN_ARGS = ["--fix", "--write", "--with-metadata", "--output-file"];
// `{scratch}` is a placeholder everywhere; `{project}` and `{projectSlug}` only for a tool with `projects`.
// A brace group with commas is a glob, not a placeholder.
const PLACEHOLDER_RE = /\{([A-Za-z_][\w-]*)\}/g;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const isNonEmptyStringArray = (v) => isStringArray(v) && v.length > 0;
const subsetOf = (values, allowed) => values.every((v) => allowed.includes(v));

const PROJECT_PLACEHOLDERS = ["project", "projectSlug"];

function placeholderErrors(path, value, allowProject = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [...text.matchAll(PLACEHOLDER_RE)]
    .filter(([, name]) => name !== "scratch" && !(allowProject && PROJECT_PLACEHOLDERS.includes(name)))
    .map(([token]) => `${path}: placeholder ${token} is not supported; ${allowProject ? "only {scratch}, {project} and {projectSlug} are" : "only {scratch} is"}`);
}

function argErrors(path, args) {
  const errors = [];
  args.forEach((arg, i) => {
    if (FORBIDDEN_ARGS.includes(arg)) errors.push(`${path}: forbidden arg ${arg}; an invocation must stay read-only`);
    if (arg === "--cache" && !(args[i + 1] === "--cache-location" && String(args[i + 2]).startsWith("{scratch}/")))
      errors.push(`${path}: --cache must be followed by --cache-location {scratch}/..., or the tool writes its cache into the repo`);
  });
  return errors;
}

function modeErrors(path, mode, hasProjects) {
  if (!isObject(mode)) return [`${path}: must be an object`];
  const errors = [];
  const { invocations, files, env } = mode;
  if (!Array.isArray(invocations) || !invocations.length) errors.push(`${path}.invocations: must be a non-empty array`);
  else {
    const seen = new Set();
    invocations.forEach((inv, i) => {
      const label = isObject(inv) && typeof inv.id === "string" ? inv.id : String(i);
      const at = `${path}.invocations[${label}]`;
      if (!isObject(inv) || typeof inv.id !== "string" || !inv.id) return errors.push(`${at}: must be { id, args } with a non-empty string id`);
      if (seen.has(inv.id)) errors.push(`${at}: duplicate id`);
      seen.add(inv.id);
      if (!isStringArray(inv.args)) return errors.push(`${at}.args: must be an array of strings`);
      errors.push(...argErrors(`${at}.args`, inv.args), ...placeholderErrors(`${at}.args`, inv.args, hasProjects));
      if (hasProjects && !inv.args.includes("{project}"))
        errors.push(`${at}.args: a tool with projects must name its checked project as {project}`);
    });
  }
  if (files !== undefined) {
    if (!isObject(files) || !Object.values(files).every((v) => typeof v === "string" || isObject(v))) errors.push(`${path}.files: must be an object of strings or objects`);
    else errors.push(...placeholderErrors(`${path}.files`, files));
  }
  if (env !== undefined) {
    if (!isObject(env) || !Object.values(env).every((v) => typeof v === "string")) errors.push(`${path}.env: must be an object of strings`);
    else errors.push(...placeholderErrors(`${path}.env`, env));
  }
  return errors;
}

function knipConfigErrors(path, tool) {
  const cfg = tool.modes?.static?.files?.["knip.json"];
  if (!isObject(cfg) || !isStringArray(cfg.entry)) return [`${path}: static mode needs knip.json as an object with an entry array`];
  const others = Object.entries(cfg).filter(([k]) => k !== "entry");
  if (!others.length) return [`${path}: knip.json must switch plugins off, so no config file of the repo is loaded`];
  const on = others.filter(([, v]) => v !== false).map(([k]) => k);
  return on.length ? [`${path}: knip.json keys other than entry must be false; ${on.join(", ")} is not`] : [];
}

function commandErrors(path, tool) {
  const { command, version } = tool;
  if (!isObject(command)) return [`${path}.command: must be an object`];
  const errors = [];
  if (!["local", "path", "fetch"].some((k) => command[k] !== undefined)) errors.push(`${path}.command: needs at least one of local, path, fetch`);
  if (command.local !== undefined && (typeof command.local !== "string" || !command.local || command.local.startsWith("/") || command.local.split("/").includes("..")))
    errors.push(`${path}.command.local: must be a relative path inside the repo`);
  if (command.path !== undefined && (typeof command.path !== "string" || !command.path || command.path.includes("/")))
    errors.push(`${path}.command.path: must be a bare executable name`);
  if (command.fetch !== undefined) {
    const pinned = version === "repo-toolchain" ? /@v?\d+(\.\d+)*$/ : new RegExp(`@${String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    if (!isNonEmptyStringArray(command.fetch) || !command.fetch.some((a) => pinned.test(a)))
      errors.push(`${path}.command.fetch: must be a non-empty argv with one element pinned to @${version}`);
  }
  if (command.versionArgs !== undefined && !isStringArray(command.versionArgs)) errors.push(`${path}.command.versionArgs: must be an array of strings`);
  return errors;
}

function optionalFieldErrors(path, tool) {
  const errors = [];
  if (tool.when !== undefined && !(isObject(tool.when) && (tool.when.anyFile === undefined || isStringArray(tool.when.anyFile))))
    errors.push(`${path}.when.anyFile: must be an array of strings`);
  if (tool.okExit !== undefined && !(Array.isArray(tool.okExit) && tool.okExit.every(Number.isInteger)))
    errors.push(`${path}.okExit: must be an array of integers`);
  if (tool.lineFilter !== undefined) {
    try {
      if (typeof tool.lineFilter !== "string") throw new Error("not a string");
      new RegExp(tool.lineFilter);
    } catch {
      errors.push(`${path}.lineFilter: must be a string that is a valid regular expression`);
    }
  }
  if (tool.needsDependencies !== undefined && typeof tool.needsDependencies !== "boolean") errors.push(`${path}.needsDependencies: must be a boolean`);
  if (tool.outputFormat !== undefined && (!OUTPUT_FORMATS.includes(tool.outputFormat) || tool.adapter !== "raw"))
    errors.push(`${path}.outputFormat: must be one of ${OUTPUT_FORMATS.join(", ")}, and only on a raw-adapter tool`);
  if (tool.projects !== undefined) {
    const { config, cap } = isObject(tool.projects) ? tool.projects : {};
    const inRepo = typeof config === "string" && config && !config.startsWith("/") && !config.split("/").includes("..");
    if (!inRepo || !Number.isInteger(cap) || cap <= 0)
      errors.push(`${path}.projects: must be { config: a relative path inside the repo, cap: a positive integer }`);
  }
  return errors;
}

function toolErrors(tool, index, stackKeys, sweeps) {
  const label = isObject(tool) && typeof tool.id === "string" && tool.id ? tool.id : String(index);
  const path = `tools[${label}]`;
  if (!isObject(tool)) return [`${path}: must be an object`];
  const errors = [];
  if (typeof tool.id !== "string" || !SLUG_RE.test(tool.id)) errors.push(`${path}.id: must be a lowercase slug`);
  const sweepKinds = isObject(sweeps[tool.sweep]?.kinds) ? Object.keys(sweeps[tool.sweep].kinds) : null;
  if (!sweepKinds) errors.push(`${path}.sweep: ${JSON.stringify(tool.sweep)} is not a sweep`);
  if (!isNonEmptyStringArray(tool.stacks) || !subsetOf(tool.stacks, stackKeys)) errors.push(`${path}.stacks: must be a non-empty subset of the stacks [${stackKeys.join(", ")}]`);
  if (!isNonEmptyStringArray(tool.kinds) || (sweepKinds && !subsetOf(tool.kinds, sweepKinds))) errors.push(`${path}.kinds: must be a non-empty subset of its sweep's kinds`);
  if (!ADAPTERS.includes(tool.adapter)) errors.push(`${path}.adapter: must be one of ${ADAPTERS.join(", ")}`);
  if (tool.version !== "repo-toolchain" && !(typeof tool.version === "string" && VERSION_RE.test(tool.version)))
    errors.push(`${path}.version: must be a pinned version or "repo-toolchain"`);
  errors.push(...commandErrors(path, tool), ...optionalFieldErrors(path, tool));
  if (!isObject(tool.modes) || !Object.keys(tool.modes).length || !subsetOf(Object.keys(tool.modes), MODES))
    errors.push(`${path}.modes: must be a non-empty object keyed by ${MODES.join(" | ")}`);
  else for (const [name, mode] of Object.entries(tool.modes)) errors.push(...modeErrors(`${path}.modes.${name}`, mode, tool.projects !== undefined));
  if (tool.adapter === "knip" && isObject(tool.modes) && tool.modes.static) errors.push(...knipConfigErrors(`${path}.modes.static.files`, tool));
  return errors;
}

function sweepErrors(sweeps) {
  const errors = [];
  for (const [name, sweep] of Object.entries(sweeps)) {
    const path = `sweeps.${name}`;
    if (!isObject(sweep) || !isObject(sweep.kinds) || !Object.keys(sweep.kinds).length) {
      errors.push(`${path}.kinds: must be a non-empty object`);
    } else {
      for (const [kind, def] of Object.entries(sweep.kinds)) {
        if (!SLUG_RE.test(kind)) errors.push(`${path}.kinds: ${JSON.stringify(kind)} must be a lowercase slug`);
        if (!isObject(def) || !SEVERITIES.includes(def.severity)) errors.push(`${path}.kinds.${kind}.severity: must be one of ${SEVERITIES.join(", ")}`);
      }
    }
    if (!isStringArray(sweep?.notCovered)) errors.push(`${path}.notCovered: must be an array of strings`);
  }
  return errors;
}

function scannerErrors(scanners, stackKeys, sweeps) {
  const errors = [];
  for (const [name, scanner] of Object.entries(scanners)) {
    const path = `scanners.${name}`;
    if (!isObject(scanner)) { errors.push(`${path}: must be an object`); continue; }
    const sweepKinds = isObject(sweeps[scanner.sweep]?.kinds) ? Object.keys(sweeps[scanner.sweep].kinds) : null;
    if (!sweepKinds) errors.push(`${path}.sweep: ${JSON.stringify(scanner.sweep)} is not a sweep`);
    if (!isNonEmptyStringArray(scanner.kinds) || (sweepKinds && !subsetOf(scanner.kinds, sweepKinds))) errors.push(`${path}.kinds: must be a non-empty subset of its sweep's kinds`);
    if (scanner.stacks !== null && (!isStringArray(scanner.stacks) || !subsetOf(scanner.stacks, stackKeys))) errors.push(`${path}.stacks: must be null or a subset of the stacks`);
  }
  return errors;
}

export function validateRegistry(registry) {
  if (!isObject(registry)) return ["<root>: must be an object"];
  const errors = [];
  if (registry.version !== 1) errors.push("version: must be 1");
  const stacks = isObject(registry.stacks) ? registry.stacks : {};
  const sweeps = isObject(registry.sweeps) ? registry.sweeps : {};
  if (!isObject(registry.stacks)) errors.push("stacks: must be an object");
  if (!isObject(registry.sweeps)) errors.push("sweeps: must be an object");
  if (!isObject(registry.scanners)) errors.push("scanners: must be an object");
  if (!Array.isArray(registry.tools)) errors.push("tools: must be an array");
  for (const [name, stack] of Object.entries(stacks)) {
    const ok = isObject(stack) && isNonEmptyStringArray(stack.signals) && stack.signals.every((s) => SIGNAL_RE.test(s));
    if (!ok) errors.push(`stacks.${name}.signals: must be a non-empty array of bare file names or *.ext patterns`);
  }
  errors.push(...sweepErrors(sweeps));
  const stackKeys = Object.keys(stacks);
  if (isObject(registry.scanners)) errors.push(...scannerErrors(registry.scanners, stackKeys, sweeps));
  const config = registry.config;
  if (!isObject(config) || !Number.isInteger(config.staleTodoDays) || config.staleTodoDays <= 0) errors.push("config.staleTodoDays: must be a positive integer");
  if (!isObject(config) || typeof config.configFile !== "string" || !config.configFile) errors.push("config.configFile: must be a non-empty string");
  if (Array.isArray(registry.tools)) {
    const seen = new Set();
    registry.tools.forEach((tool, i) => {
      errors.push(...toolErrors(tool, i, stackKeys, sweeps));
      if (isObject(tool) && typeof tool.id === "string") {
        if (seen.has(tool.id)) errors.push(`tools[${tool.id}]: duplicate id`);
        seen.add(tool.id);
      }
    });
  }
  return errors;
}

// The kinds of one sweep that some tool or scanner produces: only those can be swept in full, so
// only those a stored record's resolution waits on a finalized sweep for.
export function sourcedKinds(registry, sweep) {
  return Object.keys(registry.sweeps[sweep].kinds).filter((kind) =>
    registry.tools.some((t) => t.sweep === sweep && t.kinds.includes(kind)) ||
    Object.values(registry.scanners).some((sc) => sc.sweep === sweep && sc.kinds.includes(kind)));
}

export function loadRegistry(path = REGISTRY_PATH) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  const errors = validateRegistry(registry);
  if (errors.length) throw new Error(`invalid hygiene registry: ${errors.join("; ")}`);
  return registry;
}
