// Doubles for the hooks module's tests: the session ops the module calls, read from a mutable
// `world` so a test can change the state file, the joined answer or the clock between turns, and the
// engine's answers beneath every hook. Register both before the test's first call on `$`.
export const RUN = '00000000000000a1';
// A 200k window: over budget from 30k, hard stop from 40k.
export const HAIKU = 'claude-haiku-4-5-20251001';
export const stateText = (stage = 'execution', run = RUN) => `# devcycle state\n- stage: ${stage}\n- run: ${run}\n`;
export const usage = (depth: number, model = HAIKU) =>
  ({ input_tokens: depth, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model });

export type World = {
  base?: string; nested?: string; state?: string | null; joined?: boolean; mtime?: number;
  statThrows?: boolean; surfaces?: string[]; hangAppend?: boolean;
};
export type Run = { argv: string[]; init?: { stdin?: string } };
export type Seen = { runs: Run[]; status: (string | undefined)[]; versionReads: number };

export function session(on: any, world: World = {}): Seen {
  const seen: Seen = { runs: [], status: [], versionReads: 0 };
  const state = () => (world.state === undefined ? stateText() : world.state);
  on('session.version', () => {
    seen.versionReads += 1;
    const v = world.base ?? '2.1.292';
    return { value: { version: v, base: v } };
  });
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'DEVCYCLE_NESTED_RUN' ? world.nested : undefined }));
  on('session.cwd', () => ({ value: '/repo/src' }));
  on('session.id', () => ({ value: 'session-a' }));
  on('session.surfaces', () => ({ value: world.surfaces ?? [] }));
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: state() !== null && e.path === '/repo/.devcycle/state.md' }));
  on('fs.read', () => ({ value: state() ?? '' }));
  on('fs.stat', () => {
    if (world.statThrows) throw new Error('state file gone');
    return { value: { kind: 'file', size: 1, mtimeMs: world.mtime ?? 1, isLink: false } };
  });
  on('ui.status', (_$: unknown, e: { text: string | undefined }) => (seen.status.push(e.text), { value: undefined }));
  on('process.run', (_$: unknown, e: Run) => {
    seen.runs.push(e);
    if (e.argv[2] === 'append' && world.hangAppend) return new Promise(() => {});
    const stdout = e.argv[2] === 'check-joined' ? ((world.joined ?? true) ? 'joined\n' : 'not-joined\n') : '';
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return seen;
}

export type Engine = {
  usage?: (index: number, agentId?: string) => ReturnType<typeof usage> | null; toolText?: string; toolError?: boolean;
};

// The bottom of every chain: a spawned agent's id is its `description`, so a test names its agents.
export function engine(on: any, eng: Engine = {}) {
  const text = eng.toolText ?? 'body';
  on('agent.spawn', (_$: unknown, e: { description: string }) => ({ model: HAIKU, agentId: e.description }));
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }));
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; agentId?: string }) {
    const u = eng.usage ? eng.usage(e.index, e.agentId) : usage(10_000);
    yield { kind: 'stop', stopReason: 'end_turn', usage: u };
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: u };
  });
  on('turn.complete', () => ({ text: '' }));
  on('tool.call', () => (eng.toolError ? { isError: true, result: text, text } : { result: { text }, text }));
  on('session.measure', (_$: unknown, e: { changed: unknown[] }) => ({ changed: e.changed }));
  on('session.end', (_$: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }));
}

export const spawn = ($: any, extra: Record<string, unknown> = {}) => $.agent.spawn({
  tool_use_id: 'tu1', prompt: 'p', description: 'a1', subagentType: 'devcycle:implementer', provider: 'claude',
  parentModel: 'claude-opus-5', background: false, fork: false, ...extra,
});
export async function step($: any, agentId?: string, index = 0) {
  for await (const _chunk of $.turn.step({ turnId: 't1', index, model: HAIKU, messageCount: 1, ...(agentId ? { agentId } : {}) })) { /* drain */ }
}
export const complete = ($: any, agentId: string, reason = 'answer') =>
  $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: reason === 'aborted', reason, agentId });
// A main-loop call: also what makes a test wait until the scope a turn.start began resolving is settled.
export const mainCall = ($: any, file_path = '/repo/README.md') => $.tool.call({ tool: 'Read', file_path });
export const appended = (seen: Seen) => seen.runs.filter((r) => r.argv[2] === 'append').map((r) => JSON.parse(r.init?.stdin ?? 'null'));
export const joinedChecks = (seen: Seen) => seen.runs.filter((r) => r.argv[2] === 'check-joined').length;
