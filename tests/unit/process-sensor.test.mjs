import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "../../scripts/temp-dir.mjs";
import { gitToplevel, hashSession, repoSlug } from "../../scripts/run-record.mjs";
import { readProcesses, recordProcess } from "../../scripts/process-registry.mjs";
import { makeRepo, writeInto } from "./helpers.mjs";

const HOOK = fileURLToPath(new URL("../../hooks/process-sensor.mjs", import.meta.url));
const RUN = "00000000000000a1";
const SESSION = "joined-session";

function fixture({ joined = [SESSION], state = `# devcycle state\n- stage: execution\n- run: ${RUN}\n` } = {}) {
  const repo = makeRepo();
  writeInto(repo, ".devcycle/state.md", state);
  const runsDir = makeTempDir("process-sensor-runs-");
  const runFile = join(runsDir, repoSlug(gitToplevel(repo)), `${RUN}.jsonl`);
  mkdirSync(dirname(runFile), { recursive: true });
  writeFileSync(runFile, joined.map((id) => JSON.stringify({ kind: "session", runId: RUN, sessionHash: hashSession(id) }) + "\n").join(""));
  return { repo, runsDir, dir: join(repo, ".devcycle") };
}
function fire(fx, input) {
  const r = spawnSync("node", [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify({ cwd: fx.repo, session_id: SESSION, ...input }),
    encoding: "utf8", env: { ...process.env, DEVCYCLE_RUNS_DIR: fx.runsDir },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
}
const post = (tool_name, tool_response, tool_input = {}) => ({ hook_event_name: "PostToolUse", tool_name, tool_response, tool_input });
const AGENT = post("Agent", { isAsync: true, status: "async_launched", agentId: "a3174ecde36694932" });
const SHELL = post("Bash", { stdout: "", backgroundTaskId: "bbhrzj6qw" });
const byId = (fx, id) => readProcesses(fx.dir).find((e) => e.id === id);

test("a background Agent and a background shell are recorded under the session's hash, never its raw id", () => {
  const fx = fixture();
  fire(fx, AGENT);
  fire(fx, SHELL);
  const agent = byId(fx, "a3174ecde36694932");
  assert.deepEqual([agent.kind, agent.session, agent.run, agent.stage], ["subagent", hashSession(SESSION), RUN, "execution"]);
  assert.match(agent.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(byId(fx, "bbhrzj6qw").kind, "shell");
  assert.ok(!readFileSync(join(fx.dir, "processes.jsonl"), "utf8").includes(SESSION));
});

test("a Monitor expires at its timeout unless it is persistent", () => {
  const fx = fixture();
  const before = Date.now();
  fire(fx, post("Monitor", { taskId: "bnfjbygjw", timeoutMs: 300_000, persistent: false }));
  fire(fx, post("Monitor", { taskId: "bpersist", timeoutMs: 300_000, persistent: true }));
  const expiry = Date.parse(byId(fx, "bnfjbygjw").expiresAt);
  assert.ok(expiry >= before + 300_000 && expiry <= Date.now() + 300_000);
  assert.equal(byId(fx, "bpersist").expiresAt, undefined);
});

test("a foreground Agent, a foreground Bash and an unrelated tool record nothing", () => {
  const fx = fixture();
  fire(fx, post("Agent", { status: "completed", agentId: "a1" }));
  fire(fx, post("Bash", { stdout: "hi" }));
  fire(fx, post("Read", { taskId: "x" }));
  assert.equal(existsSync(join(fx.dir, "processes.jsonl")), false);
});

test("TaskStop retires its target, and SubagentStop retires only the stopping subagent", () => {
  const fx = fixture();
  fire(fx, AGENT);
  fire(fx, SHELL);
  fire(fx, post("TaskStop", { message: "stopped" }, { task_id: "bbhrzj6qw" }));
  assert.equal(byId(fx, "bbhrzj6qw").endedBy, "taskstop");
  fire(fx, post("Bash", { backgroundTaskId: "bother" }));
  fire(fx, { hook_event_name: "SubagentStop", agent_id: "a3174ecde36694932", background_tasks: [{ id: "a3174ecde36694932", type: "subagent", status: "running" }] });
  assert.equal(byId(fx, "a3174ecde36694932").endedBy, "finished");
  assert.equal(byId(fx, "bother").endedAt, undefined, "SubagentStop never reconciles");
});

test("Stop retires what its snapshot no longer lists, leaves Monitors alone, and repeats harmlessly", () => {
  const fx = fixture();
  fire(fx, AGENT);
  fire(fx, SHELL);
  fire(fx, post("Monitor", { taskId: "bnfjbygjw", persistent: true }));
  const stop = { hook_event_name: "Stop", background_tasks: [{ id: "a3174ecde36694932", type: "subagent", status: "running" }] };
  fire(fx, stop);
  fire(fx, stop);
  assert.equal(byId(fx, "bbhrzj6qw").endedBy, "absent");
  assert.equal(byId(fx, "a3174ecde36694932").endedAt, undefined);
  assert.equal(byId(fx, "bnfjbygjw").endedAt, undefined);
  fire(fx, { hook_event_name: "Stop" });
  assert.equal(byId(fx, "a3174ecde36694932").endedAt, undefined, "a Stop with no array proves nothing");
});

test("a session that never joined, a stage-less state file and malformed input write nothing", () => {
  const fx = fixture();
  fire(fx, { ...AGENT, session_id: "parallel-session" });
  fire(fx, { ...AGENT, session_id: undefined });
  fire(fx, "{not json");
  fire(fx, "null");
  assert.equal(existsSync(join(fx.dir, "processes.jsonl")), false);
  const none = fixture({ state: "# devcycle state\n- stage: done\n- run: none\n" });
  fire(none, AGENT);
  assert.equal(existsSync(join(none.dir, "processes.jsonl")), false);
  const bare = { ...fixture(), repo: makeTempDir("process-sensor-bare-") };
  fire(bare, AGENT);
});

test("another session's Stop never retires this session's entries", () => {
  const fx = fixture({ joined: [SESSION, "other-session"] });
  fire(fx, SHELL);
  fire(fx, { hook_event_name: "Stop", session_id: "other-session", background_tasks: [] });
  assert.equal(byId(fx, "bbhrzj6qw").endedAt, undefined);
  recordProcess(fx.dir, { id: "z", kind: "shell", session: hashSession(SESSION), run: RUN, stage: "execution", startedAt: "x" });
  fire(fx, { hook_event_name: "Stop", background_tasks: [] });
  assert.equal(byId(fx, "z").endedBy, "absent");
});

test("an ordinary Bash call imports nothing past the shape check", () => {
  assert.doesNotMatch(readFileSync(HOOK, "utf8"), /^import [^\n]*(run-context|run-record|process-registry)/m);
});
