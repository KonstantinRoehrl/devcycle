import { test, expect } from 'claude-code/testing';
import { SESSION_APPEND, appended, bash, complete, engine, joinedChecks, joinsOnAppend, mainCall, session, spawn, stateText, step } from './harness.ts';
import type { World } from './harness.ts';

async function oneSubagentTurn($: any) {
  await spawn($);
  await step($, 'a1');
  await complete($, 'a1');
}

test('below Claude Code 2.1.287 the module is inert: no joined check, no record', async ($, on) => {
  const seen = session(on, { base: '2.1.286' });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await oneSubagentTurn($);
  expect(seen.runs).toEqual([]);
});

test('in a devcycle claude -p child (DEVCYCLE_NESTED_RUN set) the module is inert', async ($, on) => {
  const seen = session(on, { nested: '1' });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await oneSubagentTurn($);
  expect(seen.runs).toEqual([]);
});

test('with no state file, or one naming no active run, the module is inert', async ($, on) => {
  const world = { state: null as string | null };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await oneSubagentTurn($);
  world.state = '# devcycle state\n- stage: done\n- run: none\n';
  await $.turn.start({ text: 'again', turnId: 'm2' });
  await oneSubagentTurn($);
  expect(seen.runs).toEqual([]);
});

test('a session that has not joined the run writes nothing', async ($, on) => {
  const seen = session(on, { joined: false });
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await oneSubagentTurn($);
  // turn.start asked once; the spawn, finding the session still not joined, asked again.
  expect([joinedChecks(seen), appended(seen).length]).toEqual([2, 0]);
});

test('a join that lands mid-turn is seen at the next spawn; once joined, a spawn asks no more', async ($, on) => {
  const world = { joined: false };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.joined = true;
  await oneSubagentTurn($);
  await spawn($, { description: 'a2' });
  await step($, 'a2');
  await complete($, 'a2');
  expect([joinedChecks(seen), appended(seen).length]).toEqual([2, 2]);
});

test('only a Bash call appending a session row asks the joined question mid-turn, and only until the session has joined', async ($, on) => {
  const world: World = { joined: false };
  const seen = session(on, world);
  engine(on, joinsOnAppend(world));
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await bash($, 'git status --short');
  await bash($, 'node scripts/run-record.mjs append --run 00000000000000a1 --kind event --event x');
  await mainCall($);
  expect(joinedChecks(seen)).toBe(1);
  await bash($, SESSION_APPEND);
  await bash($, SESSION_APPEND);
  expect(joinedChecks(seen)).toBe(2);
});

test('outside a devcycle run a main-loop call costs one exists per state-file candidate: the repo root\'s and the cwd\'s', async ($, on) => {
  const world: World = { cwd: '/repo/src', state: null };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  const before = seen.exists.length;
  await mainCall($);
  await bash($, 'ls');
  expect(seen.exists.slice(before)).toEqual(['/repo/.devcycle/state.md', '/repo/src/.devcycle/state.md',
    '/repo/.devcycle/state.md', '/repo/src/.devcycle/state.md']);
  world.root = null;
  world.cwd = '/elsewhere';
  await $.turn.start({ text: 'again', turnId: 'm2' });
  await mainCall($);
  const outside = seen.exists.length;
  await mainCall($);
  expect(seen.exists.slice(outside)).toEqual(['/elsewhere/.devcycle/state.md']);
});

test('a negative joined answer is asked again on the next turn.start; a positive one is cached', async ($, on) => {
  const world = { joined: false };
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.joined = true;
  await $.turn.start({ text: 'again', turnId: 'm2' });
  await oneSubagentTurn($);
  await $.turn.start({ text: 'third', turnId: 'm3' });
  await mainCall($);
  expect([joinedChecks(seen), appended(seen).length]).toEqual([2, 1]);
});

test('session.end with reason clear drops the cached joined answer', async ($, on) => {
  const seen = session(on);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  await $.turn.start({ text: 'again', turnId: 'm2' });
  await mainCall($);
  expect(joinedChecks(seen)).toBe(1);
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: 'none' } as never);
  await $.turn.start({ text: 'after clear', turnId: 'm3' });
  await mainCall($);
  expect(joinedChecks(seen)).toBe(2);
});

test('the version is read once per load, however many turns follow', async ($, on) => {
  const seen = session(on);
  engine(on);
  for (const turnId of ['m1', 'm2', 'm3']) {
    await $.turn.start({ text: 'go', turnId });
    await mainCall($);
  }
  expect(seen.versionReads).toBe(1);
});

test('a state-file change seen after a main-loop tool call re-derives the scope before the next subagent finishes', async ($, on) => {
  const world: { state?: string; mtime?: number } = {};
  const seen = session(on, world);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.state = '# devcycle state\n- stage: done\n- run: none\n';
  world.mtime = 2;
  await mainCall($);
  await oneSubagentTurn($);
  expect(appended(seen)).toEqual([]);
  world.state = stateText('branch-review');
  world.mtime = 3;
  await mainCall($);
  await oneSubagentTurn($);
  expect(appended(seen).length).toBe(1);
});

test('a tool.call hook that throws after next passes the tool result through', async ($, on) => {
  const world = { surfaces: ['terminal'], statusThrows: false };
  session(on, world);
  engine(on, { toolText: 'still here' });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.statusThrows = true;
  const result = await mainCall($);
  expect(result.text).toBe('still here');
});

// commands/continue.md § Execution resume runs scripts/wave-setup.mjs and then the session append as
// two main-loop Bash calls. hooks/devcycle-mod.mjs joins on the second alone; folding the append
// into the first would leave a resumed execution session untraced and its subagents unbudgeted.
test('a continue resume at stage execution joins on its own session append, never on the wave-setup call', async ($, on) => {
  const world: World = { joined: false };
  const seen = session(on, world);
  engine(on, joinsOnAppend(world));
  await $.turn.start({ text: '/devcycle:continue', turnId: 'm1' });
  await bash($, "node scripts/wave-setup.mjs --state /repo/.devcycle/state.md --knobs 'knobs: profile=standard'");
  await oneSubagentTurn($);
  expect([joinedChecks(seen), appended(seen).length]).toEqual([2, 0]);
  await bash($, SESSION_APPEND);
  await spawn($, { description: 'a2' });
  await step($, 'a2');
  await complete($, 'a2');
  expect([joinedChecks(seen), appended(seen).length]).toEqual([3, 1]);
});
