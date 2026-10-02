#!/usr/bin/env node
// Resolves devcycle's userConfig knobs from the placeholders an entry command renders. Only command
// text is templated -- a playbook or reference a stage opens with Read never sees a substituted
// value -- so every entry command passes all thirteen rendered placeholders here and stages read the
// printed `knobs:` line. references/config.md states the resolution order; this file is its
// executable form, and ROSTER is the roster's fifth hand-kept copy that golden-path holds in parity.
// Its enum `values` own each fixed set: validate.mjs holds plugin.json's `options` lists to them.
import { pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { parsePool } from "./model-pool.mjs";

const profileRow = (lean, standard, thorough) => ({ lean, standard, thorough });

// Roster order is references/config.md § The knob roster's order, and the order `knobs:` prints in.
export const ROSTER = [
  { key: "profile", kind: "enum", values: ["lean", "standard", "thorough"], fallback: "standard" },
  { key: "gitPolicy", kind: "enum", values: ["local-commits-only", "push-allowed", "open-pr"], fallback: "local-commits-only" },
  { key: "docTrackingPolicy", kind: "enum", values: ["all-local", "standard", "all-tracked"], fallback: "standard" },
  { key: "reviewDepth", kind: "enum", values: ["single", "panel"], fallback: profileRow("single", "single", "panel") },
  { key: "crossModelReview", kind: "boolean", fallback: "false" },
  { key: "onDeviceGate", kind: "enum", values: ["human-required", "auto-ok"], fallback: profileRow("auto-ok", "human-required", "human-required") },
  { key: "implementerModel", kind: "model", fallback: "auto" },
  { key: "taskReviewerModel", kind: "model", fallback: "auto" },
  { key: "branchReviewModel", kind: "model", fallback: "auto" },
  { key: "walkthroughModel", kind: "model", fallback: "auto" },
  { key: "learnStalenessSessions", kind: "count", min: 0, fallback: "5" },
  { key: "learnStalenessDays", kind: "count", min: 0, fallback: "14" },
  { key: "learnSessionCap", kind: "count", min: 1, fallback: "100" },
];

const ROSTER_KEYS = new Set(ROSTER.map(({ key }) => key));

// An unset option renders as its literal placeholder -- even when the manifest declares a default
// (docs/platform-notes.md) -- and `auto` is config.md's sanctioned "let the profile govern this".
export function isUnset(value) {
  const v = (value ?? "").trim();
  return v === "" || v === "auto" || v.startsWith("${user_config.");
}

// The value's normalized in-set form, or null when it lies outside the knob's allowed set.
function inSet(entry, value) {
  const v = value.trim();
  switch (entry.kind) {
    case "enum":
      return entry.values.includes(v) ? v : null;
    case "boolean":
      return v === "true" || v === "false" ? v : null;
    case "count":
      return /^\d+$/.test(v) && Number(v) >= entry.min ? String(Number(v)) : null;
    case "model": {
      // An id with whitespace inside it would print unquoted on the knobs: line and split apart
      // when parseRecordedLine reads that line back, so it is refused rather than normalized.
      const pool = parsePool(v);
      return pool.kind === "unset" || pool.entries.some((id) => /\s/.test(id)) ? null : pool.entries.join(",");
    }
    default:
      throw new Error(`unknown knob kind ${entry.kind}`);
  }
}

function allowedSet(entry) {
  switch (entry.kind) {
    case "enum":
      return entry.values.join(" | ");
    case "boolean":
      return "true | false";
    case "count":
      return `a whole number of at least ${entry.min}`;
    default:
      return "auto, a model id, or a comma-separated pool of ids";
  }
}

const fallbackFor = (entry, profile) => (typeof entry.fallback === "string" ? entry.fallback : entry.fallback[profile]);

export function resolveKnobs(raw) {
  const knobs = {};
  const explicit = [];
  const warnings = [];
  const resolveOne = (entry, profile) => {
    const value = raw[entry.key];
    if (isUnset(value)) return fallbackFor(entry, profile);
    const normalized = inSet(entry, value);
    if (normalized !== null) {
      explicit.push(entry.key);
      return normalized;
    }
    const fallback = fallbackFor(entry, profile);
    warnings.push(`${entry.key}=${value.trim()} is not one of ${allowedSet(entry)}; using ${fallback}`);
    return fallback;
  };
  const [profileEntry, ...rest] = ROSTER;
  knobs.profile = resolveOne(profileEntry, undefined);
  for (const entry of rest) knobs[entry.key] = resolveOne(entry, knobs.profile);
  return { knobs, explicit, warnings };
}

export const formatKnobsLine = (knobs) => "knobs: " + ROSTER.map(({ key }) => `${key}=${knobs[key]}`).join(" ");

export const formatExplicitLine = (explicit) => ["explicit:", ...explicit].join(" ");

// Reads `key=value` tokens from a recorded line -- a state file's `- knobs:` line or its
// `configured:` KEY=VALUE list. Tokens split on whitespace and one trailing comma (the
// `configured:` list's separator) is dropped; anything that is not a roster `key=value` -- the
// `knobs:` label, a date, the legacy `· profile-asked` marker -- is ignored.
export function parseRecordedLine(line) {
  const recorded = {};
  for (const token of line.trim().split(/\s+/)) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(token.replace(/,$/, ""));
    if (m && ROSTER_KEYS.has(m[1])) recorded[m[1]] = m[2];
  }
  return recorded;
}

// A recorded `auto` on a knob whose resolution never prints `auto` -- every knob but the four
// `*Model` ones -- says "let the profile govern", not a value, so it is no difference.
export function compareKnobs(recorded, knobs) {
  const changes = [];
  for (const entry of ROSTER) {
    if (!Object.hasOwn(recorded, entry.key)) continue;
    const old = recorded[entry.key];
    if (old === "auto" && entry.kind !== "model") continue;
    const comparable = entry.kind === "model" && old !== "auto" ? parsePool(old).entries.join(",") : old;
    if (comparable !== knobs[entry.key]) changes.push({ key: entry.key, old, new: knobs[entry.key] });
  }
  return changes;
}

const KNOWN_FLAGS = {
  ...Object.fromEntries(ROSTER.map(({ key }) => [`--${key}`, "value"])),
  "--compare": "value",
  "--json": "none",
};

function cli(argv) {
  const { flags } = parseFlags(argv, KNOWN_FLAGS);
  const missing = ROSTER.map(({ key }) => `--${key}`).filter((flag) => !(flag in flags));
  if (missing.length) throw new Error(`missing ${missing.join(", ")} -- pass every knob's rendered placeholder`);
  const raw = Object.fromEntries(ROSTER.map(({ key }) => [key, flags[`--${key}`] ?? ""]));
  const { knobs, explicit, warnings } = resolveKnobs(raw);
  for (const w of warnings) console.error(`resolve-knobs: warning: ${w}`);
  const compareLine = requireValue(flags, "--compare", "a recorded knobs: or configured: line");
  const changes = compareLine === undefined ? undefined : compareKnobs(parseRecordedLine(compareLine), knobs);
  if ("--json" in flags) {
    console.log(JSON.stringify(changes === undefined ? { knobs, explicit, warnings } : { knobs, explicit, warnings, changes }));
  } else if (changes !== undefined) {
    for (const c of changes) console.log(`${c.key}: ${c.old} → ${c.new}`);
  } else {
    console.log(formatKnobsLine(knobs));
    console.log(formatExplicitLine(explicit));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cli(process.argv.slice(2));
  } catch (e) {
    console.error(`resolve-knobs: ${e.message}`);
    process.exit(1);
  }
}
