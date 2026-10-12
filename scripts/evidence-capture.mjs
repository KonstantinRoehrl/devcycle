// One owner for running a verification command and writing its capture, in the shape
// references/evidence.md § File-backed evidence pins: `# devcycle-cmd: <the string run>`, the output,
// then `# exit <n>`. The header is the very string handed to the shell, so a capture cannot name a
// command other than the one it ran.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "./atomic-write.mjs";

// The command runs through the shell exactly as typed; its output goes to the capture, never to the
// caller's stdout.
export function runShell(cwd, cmd) {
  const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`cannot run "${cmd}": ${r.error.message}`);
  return { cmd, status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

export function writeCapture(root, rel, runs) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWrite(abs, runs.map((r) => `# devcycle-cmd: ${r.cmd}\n${r.output}# exit ${r.status}\n`).join("\n"));
  return rel;
}
