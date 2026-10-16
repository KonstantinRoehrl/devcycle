import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { notifyLines, notificationKnob, parseHandoff, withHandoffRow } from "../../scripts/handoff-mark.mjs";

const SCRIPT = join(process.cwd(), "scripts/handoff-mark.mjs");
const DRIVE = "- drive: auto model=claude-haiku-4-5 opted=2026-10-08T10:00:00Z via=answer";
const STATE = ["# devcycle state", "- stage: planning", "- run: abc", DRIVE, "- knobs: profile=standard handoffNotification=both", "- updated: 2026-10-16T09:00:00Z", ""].join("\n");
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function stateFile(text = STATE) {
  const p = join(makeTempDir("handoff-mark-"), "state.md");
  writeFileSync(p, text, "utf8");
  return p;
}
const run = (args, env = {}) => {
  const { DEVCYCLE_DRIVE_TOKEN, ...rest } = process.env;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...rest, ...env } });
};

test("parseHandoff: pending and ready rows parse; no row, an empty or an unknown value reads as ready", () => {
  assert.deepEqual(parseHandoff("pending 2026-10-16T10:00:00Z"), { state: "pending", stamp: "2026-10-16T10:00:00Z" });
  assert.deepEqual(parseHandoff("ready 2026-10-16T10:00:00Z"), { state: "ready", stamp: "2026-10-16T10:00:00Z" });
  for (const v of [null, "", "garbage"]) assert.deepEqual(parseHandoff(v), { state: "ready", stamp: null }, String(v));
});

test("withHandoffRow adds the row after the last row when absent and replaces it when present, every other line byte-identical", () => {
  const added = withHandoffRow(STATE, "pending", "2026-10-16T10:00:00Z");
  assert.equal(added, STATE.replace("- updated: 2026-10-16T09:00:00Z\n", "- updated: 2026-10-16T09:00:00Z\n- handoff: pending 2026-10-16T10:00:00Z\n"));
  const replaced = withHandoffRow(added, "ready", "2026-10-16T11:00:00Z");
  assert.equal(replaced, added.replace("- handoff: pending 2026-10-16T10:00:00Z", "- handoff: ready 2026-10-16T11:00:00Z"));
  assert.equal(replaced.split("\n").filter((l) => l.startsWith("- handoff:")).length, 1);
  assert.ok(replaced.includes(DRIVE), "the drive: row is carried byte for byte");
});

test("notifyLines: one line per channel the knob names, only for clear, fresh and stopped", () => {
  const done = "devcycle: planning done — safe to /clear + /devcycle:continue";
  assert.deepEqual(notifyLines({ knob: "both", action: "clear", completed: "planning" }), [`notify: terminal ${done}`, `notify: push ${done}`]);
  assert.deepEqual(notifyLines({ knob: "terminal", action: "fresh", completed: "branch-review" }),
    ["notify: terminal devcycle: branch-review done — safe to start a fresh session and run /devcycle:continue"]);
  assert.deepEqual(notifyLines({ knob: "push", action: "stopped", reason: "stalled" }), ["notify: push devcycle: unattended run stopped — stalled, needs you"]);
  for (const action of ["continue", "started"]) assert.deepEqual(notifyLines({ knob: "both", action, completed: "x" }), [], action);
  assert.deepEqual(notifyLines({ knob: "off", action: "clear", completed: "planning" }), []);
});

test("notificationKnob reads the state file's knobs: line; a line without it, or no line, is off", () => {
  assert.equal(notificationKnob(STATE), "both");
  assert.equal(notificationKnob(STATE.replace(" handoffNotification=both", "")), "off");
  assert.equal(notificationKnob(STATE.replace("handoffNotification=both", "handoffNotification=loud")), "off");
  assert.equal(notificationKnob("# devcycle state\n- stage: planning\n"), "off");
});

test("cli --pending writes the row and prints it, with no notification", () => {
  const p = stateFile();
  const r = run(["--state", p, "--pending"]);
  assert.equal(r.status, 0, r.stderr);
  const [line, ...rest] = r.stdout.trim().split("\n");
  const [, state, stamp] = line.split(" ");
  assert.deepEqual([line.startsWith("handoff: "), state, STAMP.test(stamp), rest], [true, "pending", true, []]);
  assert.equal(readFileSync(p, "utf8"), withHandoffRow(STATE, "pending", stamp));
});

test("cli --ready --action clear prints the notify lines after the mark; continue and started print none", () => {
  const p = stateFile();
  const clear = run(["--state", p, "--ready", "--action", "clear", "--completed", "planning"]);
  assert.equal(clear.status, 0, clear.stderr);
  const lines = clear.stdout.trim().split("\n");
  assert.match(lines[0], /^handoff: ready \S+$/);
  assert.deepEqual(lines.slice(1), ["notify: terminal devcycle: planning done — safe to /clear + /devcycle:continue",
    "notify: push devcycle: planning done — safe to /clear + /devcycle:continue"]);
  for (const action of ["continue", "started"]) {
    const r = run(["--state", p, "--ready", "--action", action]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, action);
  }
});

test("cli in a driven session writes nothing and says so", () => {
  const p = stateFile();
  const r = run(["--state", p, "--ready", "--action", "clear", "--completed", "wave 1 of 2"], { DEVCYCLE_DRIVE_TOKEN: "t" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "handoff: unchanged — a driven session never marks the handoff");
  assert.equal(readFileSync(p, "utf8"), STATE);
});

test("cli usage errors exit 1 naming what is wrong, and leave the file alone", () => {
  const p = stateFile();
  const cases = [
    [["--state", p], "pass exactly one of --pending and --ready"],
    [["--state", p, "--pending", "--ready"], "pass exactly one of --pending and --ready"],
    [["--state", p, "--ready"], "--ready needs --action"],
    [["--state", p, "--ready", "--action", "later"], "--ready needs --action"],
    [["--state", p, "--ready", "--action", "clear"], "--action clear needs --completed"],
    [["--state", p, "--ready", "--action", "stopped"], "--action stopped needs --reason"],
    [["--state", p, "--pending", "--action", "clear"], "--pending takes no --action, --completed or --reason"],
    [["--state", p, "--ready", "--action", "clear", "--completed", "a\nb"], "--completed must be one line"],
    [["--pending"], "--state is required"],
  ];
  for (const [args, message] of cases) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.ok(r.stderr.includes(`handoff-mark: ${message}`), `${args.join(" ")}: ${r.stderr}`);
    assert.ok(r.stderr.includes("handoff-mark: usage:"), r.stderr);
  }
  assert.equal(readFileSync(p, "utf8"), STATE);
});

test("the script never writes a drive: row", () => {
  assert.ok(!readFileSync(SCRIPT, "utf8").includes("- drive:"), "handoff-mark.mjs names a drive: row");
});
