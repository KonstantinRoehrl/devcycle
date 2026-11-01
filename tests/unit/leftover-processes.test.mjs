import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BOUNDED_FORM, MIN_AGE_SECONDS, MIN_GROUP_CPU, formatReport, leftoverGroups, parsePs } from "../../scripts/leftover-processes.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/leftover-processes.mjs", import.meta.url));
const row = (pid, ppid, pgid, tty, etime, cpu, command) => `${pid} ${ppid} ${pgid} ${tty} ${etime} ${cpu} ${command}`;
const orphan = (pid, pgid, cpu = 98, etime = "02:00") => row(pid, 1, pgid, "??", etime, cpu, "/bin/zsh -c while :; do :; done");

test("a group modelled on the incident is one leftover: thirty loops at 11% each", () => {
  const rows = Array.from({ length: 30 }, (_, k) => orphan(1000 + k, 500, 11));
  const [group, ...rest] = leftoverGroups(rows.join("\n"));
  assert.deepEqual(rest, []);
  assert.deepEqual([group.pgid, group.processes, Math.round(group.cpu)], [500, 30, 330]);
});

test("a live leader excludes the group", () => {
  assert.deepEqual(leftoverGroups([row(500, 400, 500, "??", "05:00", 0, "leader"), orphan(501, 500)].join("\n")), []);
});

test("a hot worker under an idle orphan wrapper counts, summed over the whole group", () => {
  const groups = leftoverGroups([row(601, 1, 600, "??", "05:00", 0, "npm test"), row(602, 601, 600, "??", "05:00", 98, "node worker")].join("\n"));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].command, "node worker");
});

test("a group with no parent-1 member, or only on a terminal, is not a leftover", () => {
  assert.deepEqual(leftoverGroups(row(701, 650, 700, "??", "05:00", 98, "x")), []);
  assert.deepEqual(leftoverGroups(row(701, 1, 700, "ttys003", "05:00", 98, "x")), []);
  assert.equal(leftoverGroups(row(701, 1, 700, "?", "05:00", 98, "x")).length, 1, "Linux spells no terminal as ?");
});

test("both thresholds are inclusive at the constant", () => {
  assert.equal(MIN_GROUP_CPU, 50);
  assert.equal(MIN_AGE_SECONDS, 60);
  assert.deepEqual(leftoverGroups(orphan(801, 800, 49.9)), []);
  assert.equal(leftoverGroups(orphan(801, 800, 50)).length, 1);
  assert.deepEqual(leftoverGroups(orphan(801, 800, 98, "00:59")), []);
  assert.equal(leftoverGroups(orphan(801, 800, 98, "01:00")).length, 1);
});

test("the group's age is its oldest member's", () => {
  const [group] = leftoverGroups([orphan(801, 800, 98, "00:10"), orphan(802, 800, 0, "03:00")].join("\n"));
  assert.equal(group.ageSeconds, 180);
});

test("every etime form parses", () => {
  const age = (etime) => parsePs(row(1, 1, 1, "??", etime, 0, "x"))[0].ageSeconds;
  assert.equal(age("00:59"), 59);
  assert.equal(age("01:00:00"), 3600);
  assert.equal(age("01-22:06:56"), 86400 + 22 * 3600 + 6 * 60 + 56);
});

test("idle helpers that match the signature stay out: the measured Chrome and npm rows", () => {
  const rows = [row(901, 1, 900, "??", "01-02:00:00", 0, "Chrome Helper"), row(911, 1, 910, "??", "03:00:00", 0, "npm exec ng serve")];
  assert.deepEqual(leftoverGroups(rows.join("\n")), []);
});

test("process group 1 and below is never reported: its kill would reach everything", () => {
  assert.deepEqual(leftoverGroups(row(50, 1, 1, "??", "05:00", 98, "x")), []);
  assert.deepEqual(leftoverGroups(row(50, 1, 0, "??", "05:00", 98, "x")), []);
});

test("a row that does not parse is skipped, never fatal", () => {
  assert.deepEqual(parsePs("\nnot a row\n  1 2\n"), []);
});

test("the report is one line per group, says whose it cannot know, and gives the kill and the form", () => {
  const groups = leftoverGroups([...Array.from({ length: 30 }, (_, k) => orphan(1000 + k, 500, 11)), orphan(2000, 1999, 11), orphan(2001, 1999, 50)].join("\n"));
  const report = formatReport(groups);
  assert.equal(report.split("\n").filter((line) => line.startsWith("- group ")).length, 2);
  assert.match(report, /- group 500: 30 processes, 330% CPU, oldest 2m,/);
  assert.match(report, /kill -- -500/);
  assert.match(report, /on this machine/);
  assert.doesNotMatch(report, /this session started/);
  assert.ok(report.includes(BOUNDED_FORM));
  assert.equal(formatReport([]), "");
});

test("a command in the report is truncated and cannot break out of its line or code span", () => {
  const [group] = leftoverGroups(row(801, 1, 800, "??", "05:00", 98, `sh -c \`x\`\u0007 ${"y".repeat(200)}`));
  const line = formatReport([group]).split("\n").find((l) => l.startsWith("- group "));
  const command = line.match(/`([^`]*)`: `kill/)[1];
  assert.ok(command.length <= 81, command);
  assert.doesNotMatch(command, /\u0007/);
});

test("the real ps parses: a bounded child appears with its own group, and is no leftover while it leads", async (t) => {
  const child = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));
  const output = spawnSync("ps", ["-axww", "-o", "pid=,ppid=,pgid=,tty=,etime=,pcpu=,command="], { encoding: "utf8" }).stdout;
  const seen = parsePs(output).find((p) => p.pid === child.pid);
  assert.equal(seen?.pgid, child.pid);
  assert.equal(leftoverGroups(output).some((g) => g.pgid === child.pid), false);
});

test("run directly it exits 0", () => {
  const r = spawnSync("node", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
