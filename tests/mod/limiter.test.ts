import { test, expect } from 'claude-code/testing';
import { appended, complete, engine, mainCall, session, spawn, step, usage } from './harness.ts';

const note = (pct: number) =>
  `devcycle budget: this subagent is at ≈${pct}% of its context window (over budget at 15%, hard stop at 20%). Finish with what you have; name what you did not explore.`;
const DENY = 'devcycle budget: hard stop at 20% of the context window. Do not read further; return what you have and name what you did not explore.';
const READS = [
  { tool: 'Read', file_path: '/repo/a.md' }, { tool: 'Grep', pattern: 'x' }, { tool: 'Glob', pattern: '*.md' },
  { tool: 'WebFetch', url: 'https://example.com', prompt: 'p' }, { tool: 'WebSearch', query: 'q' },
];
const WRITES = [
  { tool: 'Write', file_path: '/repo/b.md', content: 'c' }, { tool: 'Edit', file_path: '/repo/b.md', old_string: 'c', new_string: 'd' },
  { tool: 'Bash', command: 'ls' },
];

async function subagentAt($: any) {
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($);
  await step($, 'a1');
}
const read = ($: any, i = 0) => $.tool.call({ tool: 'Read', file_path: `/repo/f${i}.md`, agentId: 'a1' });

test('warn: over budget, the first tool result and then every 5th carry the note on next\'s own result', async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(32_000), toolText: 'body' });
  await subagentAt($);
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await read($, i));
  expect(results.map((r: any) => r.context ?? [])).toEqual([[note(16)], [], [], [], [], [note(16)], []]);
  expect(results.every((r: any) => r.text === 'body')).toBe(true);
});

test('warn: below the over-budget band nothing is attached', async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(20_000) });
  await subagentAt($);
  expect((await read($)).context).toBeUndefined();
});

test('warn: an errored tool result past the budget carries the note too', async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(32_000), toolError: true });
  await subagentAt($);
  const r: any = await read($);
  expect([r.isError, r.context]).toEqual([true, [note(16)]]);
});

test('a result that already carries context keeps it, and the note comes after it', async ($, on) => {
  session(on);
  // The loader takes one tool.call per test, so the engine's own answer is extended in place.
  const withContext = (event: string, fn: any) =>
    on(event, event === 'tool.call' ? (...args: any[]) => ({ ...fn(...args), context: ['from beneath'] }) : fn);
  engine(withContext, { usage: () => usage(32_000) });
  await subagentAt($);
  expect((await read($)).context).toEqual(['from beneath', note(16)]);
});

test('an unrecognised tier reads as warn: the note is attached and nothing refused', { options: { subagentBudget: 'bogus' } }, async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(44_000) });
  await subagentAt($);
  const r: any = await read($);
  expect([r.deny, r.text, r.context]).toEqual([undefined, 'body', [note(22)]]);
});

test('once the run is no longer active, a tracked subagent past the budget gets no note and no deny', { options: { subagentBudget: 'enforce' } }, async ($, on) => {
  const world: { state?: string; mtime?: number } = {};
  session(on, world);
  engine(on, { usage: () => usage(44_000) });
  await subagentAt($);
  world.state = '# devcycle state\n- stage: done\n- run: none\n';
  await $.turn.start({ text: 'next', turnId: 'm2' });
  const r: any = await read($);
  expect([r.deny, r.text, r.context]).toEqual([undefined, 'body', undefined]);
});

test('warn never refuses, even at the hard stop', { options: { subagentBudget: 'warn' } }, async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(44_000) });
  await subagentAt($);
  const r: any = await read($);
  expect([r.text, r.context]).toEqual(['body', [note(22)]]);
});

test('enforce: at the hard stop reads are refused, Write, Edit and Bash pass, and the record counts both', { options: { subagentBudget: 'enforce' } }, async ($, on) => {
  const seen = session(on);
  engine(on, { usage: () => usage(44_000) });
  await subagentAt($);
  for (const input of READS) expect(await $.tool.call({ ...input, agentId: 'a1' } as never)).toEqual({ deny: DENY });
  for (const input of WRITES) expect(((await $.tool.call({ ...input, agentId: 'a1' } as never)) as any).text).toBe('body');
  await complete($, 'a1');
  const [{ record }] = appended(seen);
  expect([record.refused, record.warned]).toEqual([5, 1]);
});

test('enforce: over budget but below the hard stop a read is not refused, it carries the note', { options: { subagentBudget: 'enforce' } }, async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(32_000) });
  await subagentAt($);
  const r: any = await read($);
  expect([r.deny, r.text, r.context]).toEqual([undefined, 'body', [note(16)]]);
});

test('an assumed window counts: an unpriced model past 15% of 1M gets the note', async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(160_000, 'claude-mythos-9') });
  await subagentAt($);
  expect((await read($)).context).toEqual([note(16)]);
});

test('forks and teammates are never bounded', { options: { subagentBudget: 'enforce' } }, async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(44_000) });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($, { description: 'f1', fork: true });
  await step($, 'f1');
  await spawn($, { description: 't1', isTeammate: true });
  await step($, 't1');
  for (const agentId of ['f1', 't1']) {
    const r: any = await $.tool.call({ tool: 'Read', file_path: '/repo/a.md', agentId });
    expect([r.deny, r.text, r.context]).toEqual([undefined, 'body', undefined]);
  }
});

test('off: nothing is attached and nothing refused', { options: { subagentBudget: 'off' } }, async ($, on) => {
  const seen = session(on);
  engine(on, { usage: () => usage(44_000) });
  await subagentAt($);
  const r: any = await read($);
  expect([r.deny, r.text, r.context]).toEqual([undefined, 'body', undefined]);
  await complete($, 'a1');
  expect([appended(seen)[0].record.warned, appended(seen)[0].record.refused]).toEqual([0, 0]);
});

test('the main loop is never limited', { options: { subagentBudget: 'enforce' } }, async ($, on) => {
  session(on);
  engine(on, { usage: () => usage(44_000) });
  await subagentAt($);
  const r: any = await mainCall($);
  expect([r.deny, r.text]).toEqual([undefined, 'body']);
});
