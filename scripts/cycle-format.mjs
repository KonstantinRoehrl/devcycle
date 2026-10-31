// The cycle's on-disk format: one version per cycle, an ordered migration list and the settle that
// runs it. references/resume.md owns what the `format:` row means; CONTRIBUTING.md owns when to bump
// it. scripts/resume-check.mjs's checkState stays pure and reports the verdict, and the two callers
// that may write -- its CLI and scripts/wave-setup.mjs -- settle here.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { LockTimeoutError, withFileLock } from "./file-lock.mjs";
import { readLiveDriveLock } from "./drive-lock.mjs";
import { field } from "./md-field.mjs";
import { CLOSED_STAGE } from "./stage-entry.mjs";
import { LEDGER_LINE_RE, LEDGER_PLAN_RE, parseLedgerLine } from "./task-ledger.mjs";
import { LEDGER_RUN_RE } from "./ledger-slot.mjs";
import { KNOB_RENAMES } from "./resolve-knobs.mjs";

export const CURRENT_FORMAT = 1;

const STATE = "state.md";
const LEDGER = "ledger.md";
const UNSET = new Set(["", "none", "<tbd>"]);
const ANY_PLAN_HEADER = /^Plan:/m;
const BARE_PLAN_HEADER = /^Plan:[ \t]*([^`\s]+)[ \t]*$/m;
const EVENT_SHAPED = /^- \[/;

const eventLines = (text) => text.split("\n").filter((line) => parseLedgerLine(line));

// Format 0 covers every cycle written before the row existed, including ledgers whose `Plan:` header
// has no backticks or is missing. A script cannot prove a headerless ledger is this cycle's, and
// adopting a previous cycle's lines would skip real work, so that one case is the user's answer.
function migrateZeroToOne(files, { answer }) {
  const ledger = files[LEDGER];
  const plan = (field(files[STATE], "plan") ?? "").split(/\s+/)[0];
  if (ledger === null || UNSET.has(plan)) return { files, notes: [] };
  const bare = ledger.match(BARE_PLAN_HEADER);
  if (bare) {
    if (bare[1] !== plan) return { files, notes: [] };
    return { files: { ...files, [LEDGER]: ledger.replace(BARE_PLAN_HEADER, `Plan: \`${plan}\``) }, notes: [`${LEDGER}: its Plan: header now has the backticks the reader needs`] };
  }
  if (ANY_PLAN_HEADER.test(ledger)) return { files, notes: [] };
  const events = eventLines(ledger).length;
  if (events === 0) return { files, notes: [] };
  if (!answer) return { files, notes: [], question: `This cycle's ledger has ${events} events and doesn't say which plan it belongs to. Is it this cycle's?` };
  if (answer !== "yes") return { files, notes: [] };
  return { files: { ...files, [LEDGER]: `Plan: \`${plan}\`\n${ledger}` }, notes: [`${LEDGER}: gained a Plan: header naming ${plan}, as you confirmed`] };
}

// No gaps from 0, and never retired, so every older format always has a path. `renames` maps a
// retired stage name to its replacement: the settle rewrites the row, and validate check 29 reads it.
export const MIGRATIONS = [{ from: 0, to: 1, renames: {}, migrate: migrateZeroToOne }];

export function formatVerdict(text, current = CURRENT_FORMAT) {
  const raw = field(text, "format");
  if (raw === null) return { verdict: "older", from: 0 };
  if (!/^\d+$/.test(raw)) return { verdict: "unparseable", row: raw };
  const from = Number(raw);
  return { verdict: from === current ? "equal" : from < current ? "older" : "newer", from };
}

export function formatStopMessage(verdict, current = CURRENT_FORMAT) {
  if (verdict.verdict === "newer")
    return `This cycle's files are format ${verdict.from}, and the installed devcycle plugin only reads up to format ${current}. Run claude plugin update devcycle@devcycle, restart Claude Code, then run /devcycle:continue again.`;
  return `The state file's format row reads "${verdict.row}", which is not a number. Correct it by hand to the number the file was written under, or remove the row to re-run every migration step.`;
}

// A stage an older file may still name, because a step it has yet to run renames it.
export const isPendingRename = (stage, from, migrations = MIGRATIONS) =>
  migrations.some((step) => step.from >= from && Object.hasOwn(step.renames, stage));

export function stampFormat(text, n) {
  const row = `- format: ${n}`;
  if (/^- format:.*$/m.test(text)) return text.replace(/^- format:.*$/m, row);
  const [first, ...rest] = text.split("\n");
  return first.startsWith("# ") ? [first, row, ...rest].join("\n") : `${row}\n${text}`;
}

const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

function applySteps(files, from, { migrations, current, answer }) {
  let next = files;
  const notes = [];
  for (let at = from; at < current; at++) {
    const step = migrations.find((m) => m.from === at);
    if (!step) throw new Error(`no migration step from format ${at}`);
    const result = step.migrate(next, { answer });
    if (result.question) return { question: result.question };
    next = result.files;
    notes.push(...result.notes);
    const stage = field(next[STATE], "stage");
    if (stage && Object.hasOwn(step.renames, stage)) {
      next = { ...next, [STATE]: next[STATE].replace(/^- stage:.*$/m, `- stage: ${step.renames[stage]}`) };
      notes.push(`${STATE}: stage ${stage} is now ${step.renames[stage]}`);
    }
  }
  return { files: next, notes };
}

function migrateLocked(statePath, ledgerPath, { answer, migrations, current, write }) {
  const dir = dirname(statePath);
  const stateText = readFileSync(statePath, "utf8");
  const verdict = formatVerdict(stateText, current);
  // Another session may have migrated while this one waited for the lock.
  if (verdict.verdict !== "older") return { status: "none", report: [] };
  const originals = { [STATE]: stateText, [LEDGER]: readIfPresent(ledgerPath) };
  const applied = applySteps(originals, verdict.from, { migrations, current, answer });
  if (applied.question) return { status: "question", question: applied.question, report: [] };

  const changed = Object.keys(originals).filter((name) => applied.files[name] !== originals[name]);
  const rejected = originals[LEDGER] === null ? 0 : originals[LEDGER].split("\n").filter((line) => EVENT_SHAPED.test(line) && !parseLedgerLine(line)).length;
  const backupDir = join(dir, `format-backup-${verdict.from}`);
  const pathOf = (name) => (name === STATE ? statePath : ledgerPath);
  const rootOf = dirname(dir);
  for (const name of changed) {
    mkdirSync(backupDir, { recursive: true });
    // An existing copy is the true original: a re-run after a crash must not back up half-migrated files.
    if (!existsSync(join(backupDir, name))) copyFileSync(pathOf(name), join(backupDir, name));
  }
  try {
    if (changed.includes(LEDGER)) write(ledgerPath, applied.files[LEDGER]);
    // The row goes last: a crash before this write leaves an older row, and the next resume re-runs.
    write(statePath, stampFormat(applied.files[STATE], current));
  } catch (err) {
    for (const name of changed) write(pathOf(name), readFileSync(join(backupDir, name), "utf8"));
    if (!changed.includes(STATE)) write(statePath, stateText);
    return { status: "failed", report: [], detail: `The cycle's files were not migrated and are as they were: ${err.message}` };
  }
  const report = [
    ...applied.notes,
    ...(rejected ? [`${LEDGER}: ${rejected} event-shaped line${rejected === 1 ? "" : "s"} can't be read and stay ignored, as before`] : []),
    ...(changed.length ? [`originals are in ${relative(rootOf, backupDir)}/`] : []),
  ];
  return { status: "migrated", report };
}

// The one writer of a cycle's format. `checked` is scripts/resume-check.mjs's checkState result: the
// ownership and stale checks run there first, so a foreign or leftover file is never migrated or
// backed up here. Beside a live driver nothing migrates: state writers take no lock, so the lock
// below could not keep them out. `driven` names a session that driver started, which passed the
// token and version checks before getting here.
export function settleFormat(statePath, {
  checked, answer = null, driven = false, migrations = MIGRATIONS, current = CURRENT_FORMAT, write = atomicWrite, lockTimeoutMs = 5000,
} = {}) {
  if (!checked?.ok || checked.stage === CLOSED_STAGE || checked.format?.verdict !== "older") return { status: "none", report: [] };
  const dir = dirname(statePath);
  if (!driven && readLiveDriveLock(dirname(dir))) return { status: "driver-live", report: [] };
  const ledgerPath = join(dir, LEDGER);
  try {
    return withFileLock(statePath, () => withFileLock(ledgerPath, () => migrateLocked(statePath, ledgerPath, { answer, migrations, current, write }),
      { timeoutMs: lockTimeoutMs }), { timeoutMs: lockTimeoutMs });
  } catch (err) {
    if (err instanceof LockTimeoutError) return { status: "locked", report: [], detail: "Another session is migrating this cycle's files. Wait for it to finish, then run /devcycle:continue again." };
    return { status: "failed", report: [], detail: `The cycle's files were not migrated and are as they were: ${err.message}` };
  }
}

export const liveLedgerPatterns = () => ({ eventLine: LEDGER_LINE_RE.source, planHeader: LEDGER_PLAN_RE.source, runHeader: LEDGER_RUN_RE.source });

const CONTRACT_PATH = "tests/fixtures/cycle-format-contract.json";
const BUMP = "this needs a format bump: raise CURRENT_FORMAT in scripts/cycle-format.mjs, add a migration step, then refresh";

// Validate check 29. What it leaves out, deliberately, is in CONTRIBUTING.md: the plan's Dispatch Map,
// per-task files and the stop record have tolerant readers or live for one task.
export function contractErrors(live, contract, { current = CURRENT_FORMAT, migrations = MIGRATIONS, knobRenames = KNOB_RENAMES } = {}) {
  if (contract.format !== current)
    return [`${CONTRACT_PATH} records format ${contract.format}, and scripts/cycle-format.mjs is at format ${current}: refresh the fixture in the same change`];
  const errors = [];
  const gone = (from, to) => from.filter((name) => !to.includes(name));
  const renamedStages = new Set(migrations.flatMap((step) => Object.keys(step.renames ?? {})));
  const retired = new Set(contract.retiredKnobs ?? []);
  for (const [what, name] of [...gone(live.stages, contract.stages).map((n) => ["stage", n]), ...gone(live.knobs, contract.knobs).map((n) => ["knob", n]), ...gone(live.stateRows, contract.stateRows).map((n) => ["state row", n])])
    errors.push(`${what} "${name}" is new: record it in ${CONTRACT_PATH} in the same change`);
  for (const stage of gone(contract.stages, live.stages))
    if (!renamedStages.has(stage)) errors.push(`stage "${stage}" was removed or renamed with no migration step declaring it under renames: a live cycle at that stage would read as abandoned`);
  for (const knob of gone(contract.knobs, live.knobs))
    if (!Object.hasOwn(knobRenames, knob) && !retired.has(knob)) errors.push(`knob "${knob}" was removed or renamed: add it to KNOB_RENAMES in scripts/resolve-knobs.mjs, or declare it under retiredKnobs in ${CONTRACT_PATH}`);
  for (const row of gone(contract.stateRows, live.stateRows))
    errors.push(`state row "${row}" was removed or renamed; ${BUMP} ${CONTRACT_PATH}`);
  for (const key of Object.keys(contract.ledger))
    if (live.ledger[key] !== contract.ledger[key]) errors.push(`the ledger pattern ${key} changed; ${BUMP} ${CONTRACT_PATH}`);
  return errors;
}
