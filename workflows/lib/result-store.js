// result-store.js — the per-lens result files both branch-review engines keep under
// .devcycle/review/<round>/, so a stopped round loses nothing that finished.
//
// `<dir>/<lens>.json` maps a job key to `{ findings, strengths }`, and `_refutation.json` maps a
// refutation key to `{ verified, verification }`. `_args.json` holds the panel's arguments and
// `_lenses.json` the single engine's lens set; they are separate files so neither engine's resume
// can pick up the other's. An entry is keyed by a hash of what it reviewed, so a moved branch, a
// changed charter or an edited spec re-runs rather than replays.
//
// CommonJS because workflows/review-panel.js requires it synchronously; scripts/lens-results.mjs
// default-imports it.

"use strict";

const { createHash } = require("node:crypto");
const { readFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const RESULT_DIR_SHAPE = /(^|\/)\.devcycle\/review\/[^/]+$/;
const SAVED_ARGS_FILE = "_args.json";
const LENS_SET_FILE = "_lenses.json";
const REFUTATION_FILE = "_refutation.json";

const contentKey = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

// A caller-supplied lens key becomes one path component: encoding removes every "/", and the
// ".json" suffix means no key can resolve to "." or "..".
const lensResultFile = (lensKey) => `${encodeURIComponent(lensKey)}.json`;

// A verdict holds only for the input it was reached on, so the reviewed input is part of the key.
const refutationKey = (reviewedInput, f) =>
  contentKey(reviewedInput, f.file, f.line, f.claim, f.severity, f.measuredAgainst, f.needsExecution, f.lens);

function readJsonObject(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The review must survive a write that fails: a lost result file costs one re-run on resume, and
// failing the review for it would cost the whole round.
function createResultStore(dir, { atomicWrite, log }) {
  const write = (name, value) => {
    try {
      mkdirSync(dir, { recursive: true });
      atomicWrite(join(dir, name), JSON.stringify(value, null, 2) + "\n");
      return true;
    } catch (e) {
      log(`result file ${name} not written: ${e.message}`);
      return false;
    }
  };
  const files = new Map();
  const entriesOf = (name) => {
    if (!files.has(name)) files.set(name, readJsonObject(join(dir, name)) ?? {});
    return files.get(name);
  };
  return {
    get: (name, key) => entriesOf(name)[key] ?? null,
    put(name, key, value) {
      entriesOf(name)[key] = value;
      return write(name, entriesOf(name));
    },
    save: (name, value) => write(name, value),
  };
}

module.exports = {
  RESULT_DIR_SHAPE,
  SAVED_ARGS_FILE,
  LENS_SET_FILE,
  REFUTATION_FILE,
  contentKey,
  lensResultFile,
  refutationKey,
  readJsonObject,
  createResultStore,
};
