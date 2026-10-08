import { test, expect } from 'claude-code/testing';
import { SESSION_APPEND, bash, engine, joinedChecks, joinsOnAppend, mainCall, session, spawn, stateText, step } from './harness.ts';
import type { World } from './harness.ts';

const text = (stage: string, calls: number, files: number, ctx = '–') =>
  `${stage} · calls ${calls}/~30 · files ${files}/~15 · ctx ${ctx}%`;

test('counts main-loop calls and distinct files read, and shows them with the stage', async ($, on) => {
  const seen = session(on, { surfaces: ['terminal'] });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($, '/repo/a.md');
  await mainCall($, '/repo/a.md');
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as never);
  await mainCall($, '/repo/b.md');
  expect(seen.status.at(-1)).toBe(text('execution', 4, 2));
});

test('the context percent comes from session.measure', async ($, on) => {
  const seen = session(on, { surfaces: ['terminal'] });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await $.session.measure({ context: { window: 1_000_000, percent: 12.4 }, rateLimits: [], changed: [] });
  await mainCall($);
  expect(seen.status.at(-1)).toBe(text('execution', 1, 1, '12'));
});

test('a stage change resets the counters', async ($, on) => {
  const world: { surfaces: string[]; state?: string; mtime?: number } = { surfaces: ['terminal'] };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($, '/repo/a.md');
  await mainCall($, '/repo/b.md');
  world.state = stateText('branch-review');
  world.mtime = 2;
  await mainCall($, '/repo/c.md');
  expect(seen.status.slice(-2)).toEqual([text('execution', 2, 2), text('branch-review', 1, 1)]);
});

test('subagent tool calls are not the coordinator\'s and are not counted', async ($, on) => {
  const seen = session(on, { surfaces: ['terminal'] });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($);
  await step($, 'a1');
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.md', agentId: 'a1' });
  await mainCall($, '/repo/b.md');
  expect(seen.status).toEqual([text('execution', 1, 1)]);
});

test('inert with no surface: a claude -p session never touches the status line', async ($, on) => {
  const seen = session(on, { surfaces: [] });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  expect(seen.status).toEqual([]);
});

test('the status line is cleared once when the run stops being active', async ($, on) => {
  const world: { surfaces: string[]; state?: string; mtime?: number } = { surfaces: ['terminal'] };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.state = '# devcycle state\n- stage: done\n- run: none\n';
  world.mtime = 2;
  await mainCall($);
  await mainCall($);
  expect(seen.status).toEqual([text('execution', 1, 1), undefined]);
});

test('a state file created during the turn shows the meter from the next main-loop call', async ($, on) => {
  const world: { surfaces: string[]; cwd: string; state: string | null } = { surfaces: ['terminal'], cwd: '/repo', state: null };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($, '/repo/a.md');
  world.state = stateText();
  await mainCall($, '/repo/b.md');
  expect(seen.status).toEqual([text('execution', 1, 1)]);
});

test('a fresh cycle writes its state file before joining: the session append shows the meter on that call', async ($, on) => {
  const world: World = { surfaces: ['terminal'], cwd: '/repo', state: null, joined: false };
  const seen = session(on, world);
  engine(on, joinsOnAppend(world));
  await $.turn.start({ text: 'go', turnId: 'm1' });
  world.state = stateText('brainstorm');
  await $.tool.call({ tool: 'Write', file_path: '/repo/.devcycle/state.md', content: world.state } as never);
  await bash($, SESSION_APPEND);
  expect([joinedChecks(seen), seen.status]).toEqual([2, [text('brainstorm', 1, 0)]]);
});

test('a resumed cycle joins with no state-file write: the session append shows the meter on that call', async ($, on) => {
  const world: World = { surfaces: ['terminal'], joined: false };
  const seen = session(on, world);
  engine(on, joinsOnAppend(world));
  await $.turn.start({ text: 'continue', turnId: 'm1' });
  await mainCall($, '/repo/a.md');
  await bash($, SESSION_APPEND);
  await mainCall($, '/repo/b.md');
  expect([joinedChecks(seen), seen.status]).toEqual([2, [text('execution', 1, 0), text('execution', 2, 1)]]);
});

test('in a subdirectory session, a state file appearing at the repo root shows the meter', async ($, on) => {
  const world: World = { surfaces: ['terminal'], cwd: '/repo/src', state: null };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($, '/repo/a.md');
  world.state = stateText();
  await mainCall($, '/repo/b.md');
  expect(seen.status).toEqual([text('execution', 1, 1)]);
});

test('a state file deleted mid-turn clears the status line', async ($, on) => {
  const world: { surfaces: string[]; state?: string | null } = { surfaces: ['terminal'] };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.state = null;
  await mainCall($);
  expect(seen.status).toEqual([text('execution', 1, 1), undefined]);
});

test('the meter never refuses a call', async ($, on) => {
  session(on, { surfaces: ['terminal'] });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  for (let i = 0; i < 40; i++) expect(((await mainCall($, `/repo/f${i}.md`)) as any).deny).toBeUndefined();
});
