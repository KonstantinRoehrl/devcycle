#!/usr/bin/env node
// Finds process groups that look leaked (#395): the leader is gone, a member was reparented to PID 1
// with no terminal, and the group as a whole is busy and old enough to count. CPU is summed over the
// group, since the incident's loops ran at about 11% each. The signature cannot prove who started a
// group, so this only ever reports. hooks/leftover-sensor.mjs and the finish stage read it.
import { spawnSync } from "node:child_process";
import { isMain } from "./is-main.mjs";

export const MIN_GROUP_CPU = 50;
export const MIN_AGE_SECONDS = 60;
// references/evidence.md § Background processes owns this form; tests/unit/background-idiom.test.mjs
// runs it and pins every copy.
export const BOUNDED_FORM = `set --; work & set -- "$@" $!; trap 'kill "$@" 2>/dev/null' EXIT`;

const PS_ARGS = ["-axww", "-o", "pid=,ppid=,pgid=,tty=,etime=,pcpu=,command="];
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+([\d.,]+)\s+(.*)$/;
const COMMAND_WIDTH = 80;

function etimeSeconds(etime) {
  const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const seconds = clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return Number(days) * 86400 + seconds;
}

export function parsePs(text) {
  return text.split("\n").flatMap((line) => {
    const m = PS_ROW.exec(line);
    if (!m) return [];
    return [{
      pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tty: m[4],
      ageSeconds: etimeSeconds(m[5]), cpu: Number(m[6].replace(",", ".")), command: m[7],
    }];
  });
}

export function leftoverGroups(psOutput) {
  const rows = parsePs(psOutput);
  const pids = new Set(rows.map((p) => p.pid));
  const byGroup = Map.groupBy(rows.filter((p) => p.pgid > 1 && !pids.has(p.pgid)), (p) => p.pgid);
  const groups = [];
  for (const [pgid, members] of byGroup) {
    if (!members.some((p) => p.ppid === 1 && p.tty.startsWith("?"))) continue;
    const cpu = members.reduce((sum, p) => sum + p.cpu, 0);
    const ageSeconds = Math.max(...members.map((p) => p.ageSeconds));
    if (cpu < MIN_GROUP_CPU || ageSeconds < MIN_AGE_SECONDS) continue;
    const hottest = members.reduce((a, b) => (b.cpu > a.cpu ? b : a));
    groups.push({ pgid, processes: members.length, cpu, ageSeconds, command: hottest.command });
  }
  return groups.sort((a, b) => b.cpu - a.cpu);
}

function formatAge(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// A command line is arbitrary text: keep it on its line and inside its code span.
function shortCommand(command) {
  const plain = command.replace(/[\u0000-\u001f\u007f`]/g, " ");
  return plain.length > COMMAND_WIDTH ? `${plain.slice(0, COMMAND_WIDTH)}…` : plain;
}

export function formatReport(groups) {
  if (!groups.length) return "";
  const lines = groups.map(({ pgid, processes, cpu, ageSeconds, command }) =>
    `- group ${pgid}: ${processes} ${processes === 1 ? "process" : "processes"}, ${Math.round(cpu)}% CPU, oldest ${formatAge(ageSeconds)}, \`${shortCommand(command)}\`: \`kill -- -${pgid}\``);
  return [
    "devcycle: leftover process groups are using CPU on this machine. Their leaders have exited, and nothing here can tell who started them:",
    ...lines,
    "If your own work started a group, run the kill on its line. Otherwise tell the user. devcycle killed nothing.",
    `To bound a background helper, one command per helper: ${BOUNDED_FORM}`,
  ].join("\n");
}

export function scanLeftovers() {
  const { status, stdout } = spawnSync("ps", PS_ARGS, { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 * 1024 });
  return status === 0 ? leftoverGroups(stdout) : [];
}

if (isMain(import.meta.url, process.argv[1])) {
  const report = formatReport(scanLeftovers());
  if (report) console.log(report);
}
