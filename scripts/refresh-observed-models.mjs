#!/usr/bin/env node
// Regenerates tests/fixtures/observed-model-ids.json — the snapshot of model ids a real doctor
// corpus recorded — so the pricing-coverage guard in tests/unit/pricing.test.mjs checks
// scripts/pricing.mjs against evidence instead of against a hand-copied list of the price table's
// own keys, a comparison that could never fail and let `claude-fable-5-1` ship unpriced.
//
// Human-run and occasional: refresh the snapshot when a new model id shows up, then price
// whatever it reports as unpriced. Reading ~/.claude/projects happens here and only when someone
// runs this without --dir. The tests always pass --dir — at a throwaway corpus, or at the
// committed one, tests/fixtures/observed-corpus. That corpus keeps the snapshot honest: the guard in
// tests/unit/pricing.test.mjs fails when an id the corpus records is missing from the snapshot.
//
// The refresh is therefore additive, not a replacement: it adds what the corpus it read records
// and keeps every id already in the snapshot. Two reasons. The snapshot is the price table's
// coverage floor, and doctor prices historical transcripts, so an id one machine no longer records
// still has to stay priced for the sessions that used it. And a replacing refresh run the
// documented way — no --dir, over one operator's real corpus — would drop the fixture corpus's ids
// and red that guard, leaving no way to tell the collision from a real coverage regression.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFlags, requireValue } from "./cli-flags.mjs";
import { atomicWrite } from "./atomic-write.mjs";
import { findTranscriptFiles, owningSession, parseArgs, readRecords, summarizeSession } from "./doctor.mjs";
import { priceFor } from "./pricing.mjs";

const DEFAULT_OUT = fileURLToPath(new URL("../tests/fixtures/observed-model-ids.json", import.meta.url));

// Every model id the transcripts under dir recorded, sorted and deduped. Null when there is no
// such corpus, which main reports rather than turning into an empty snapshot.
export function collectModelIds(dir) {
  const files = findTranscriptFiles(dir);
  if (files === null) return null;
  const ids = new Set();
  for (const file of files) {
    // summarizeSession applies doctor's own definition of a counted turn (assistant-side,
    // carrying usage, synthetic placeholders excluded), so the snapshot holds exactly the ids
    // doctor has to price — including ones the table has never heard of.
    for (const id of Object.keys(summarizeSession(owningSession(file), readRecords(file)).models)) ids.add(id);
  }
  return [...ids].sort();
}

// Which of these observed ids scripts/pricing.mjs cannot price. Empty is the healthy state.
export function unpricedIds(ids) {
  return ids.filter((id) => !priceFor(id));
}

// The snapshot a refresh writes: everything it already held plus everything the corpus records,
// sorted and deduped. Removing an id is deliberate and manual by design — nothing a refresh reads
// can justify dropping a model doctor may still have to price.
export function mergeIds(existing, observed) {
  return [...new Set([...existing, ...observed])].sort();
}

export function readFixture(path) {
  const ids = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    throw new Error(`${path}: expected a JSON array of model id strings`);
  return ids;
}

// One writer, one shape: sorted, deduped, two-space JSON with a trailing newline. The test
// compares the committed file against this, so a hand-edited snapshot shows up as a diff.
export function formatFixture(ids) {
  return JSON.stringify([...new Set(ids)].sort(), null, 2) + "\n";
}

function main(argv) {
  let flags;
  try {
    ({ flags } = parseFlags(argv, { "--dir": "value", "--out": "value" }));
  } catch (err) {
    console.error(`refresh-observed-models: ${err.message}`);
    console.error("refresh-observed-models: usage: refresh-observed-models.mjs [--dir <corpus>] [--out <path>]");
    process.exit(1);
  }
  let dir, out;
  try {
    const dirFlag = requireValue(flags, "--dir");
    // doctor.mjs owns where the corpus lives; ask it for the default rather than restating it.
    dir = parseArgs(dirFlag ? ["--dir", dirFlag] : []).dir;
    out = requireValue(flags, "--out") ?? DEFAULT_OUT;
  } catch (err) {
    console.error(`refresh-observed-models: ${err.message}`);
    process.exit(1);
  }

  let ids;
  try {
    ids = collectModelIds(dir);
  } catch (err) {
    // findTranscriptFiles re-throws a permissions or I/O failure rather than reading it as an
    // absent corpus, so it surfaces here. Report it the way every other failure in main does.
    console.error(`refresh-observed-models: cannot read the corpus under ${dir}: ${err.message}`);
    process.exit(1);
  }
  if (!ids?.length) {
    // An empty snapshot would make the coverage guard vacuous again — the exact defect this
    // script exists to remove — so a corpus that yields nothing is an error, not a write.
    console.error(`refresh-observed-models: no model ids found under ${dir} — leaving the snapshot alone`);
    process.exit(1);
  }
  let existing = [];
  if (existsSync(out)) {
    try {
      existing = readFixture(out);
    } catch (err) {
      // The snapshot is an input now, so a malformed one is an error rather than something to
      // overwrite — overwriting would throw away the very ids the merge exists to keep.
      console.error(`refresh-observed-models: cannot read the existing snapshot ${out}: ${err.message}`);
      process.exit(1);
    }
  }
  const merged = mergeIds(existing, ids);
  try {
    atomicWrite(out, formatFixture(merged));
  } catch (err) {
    // atomicWrite stages its temp file beside the target and creates no parent directory, so an
    // --out under a missing one fails here rather than at flag parsing.
    console.error(`refresh-observed-models: cannot write ${out}: ${err.message}`);
    process.exit(1);
  }
  const added = merged.filter((id) => !existing.includes(id));
  console.error(
    `refresh-observed-models: wrote ${merged.length} observed model id(s) to ${out}`
    + (added.length ? `, ${added.length} added by this refresh: ${added.join(", ")}` : ", none added by this refresh"));
  const unpriced = unpricedIds(merged);
  if (unpriced.length)
    console.error(`refresh-observed-models: unpriced by scripts/pricing.mjs: ${unpriced.join(", ")} — price them there`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
