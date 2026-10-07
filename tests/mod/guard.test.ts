import { test, expect } from 'claude-code/testing';
import { appended, complete, engine, joinedChecks, mainCall, session, spawn, stateText, step } from './harness.ts';

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
  const world = { statThrows: false };
  session(on, world);
  engine(on, { toolText: 'still here' });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await mainCall($);
  world.statThrows = true;
  const result = await mainCall($);
  expect(result.text).toBe('still here');
});
