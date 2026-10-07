import { test, expect } from 'claude-code/testing';
import { HAIKU, RUN, appended, complete, engine, mainCall, session, spawn, step, usage } from './harness.ts';

const RECORD = {
  agentId: 'a1', agentType: 'devcycle:implementer', requestedModel: 'haiku', resolvedModel: HAIKU, parentAgentId: null,
  background: false, fork: false, steps: 2, peakDepth: 32_000, window: 200_000, windowAssumed: false, peakBand: 'over-budget',
  toolResultChars: 42, warned: 0, refused: 0, reason: 'answer', isAborted: false,
};

test('spawn, steps and complete start one agent-trace flush through the sink without waiting on it', async ($, on) => {
  const seen = session(on, { hangAppend: true });
  engine(on, { usage: (i) => usage(i === 0 ? 20_000 : 32_000), toolText: 'x'.repeat(42) });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($, { model: 'haiku' });
  await step($, 'a1', 0);
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.md', agentId: 'a1' });
  await step($, 'a1', 1);
  await complete($, 'a1');
  expect(seen.runs.filter((r) => r.argv[2] === 'append').map((r) => r.argv.length)).toEqual([3]);
  expect(appended(seen)).toEqual([{ run: RUN, session: 'session-a', cwd: '/repo/src', record: RECORD }]);
});

test('an agent first seen at its first step is tracked anyway, with null enrichment', async ($, on) => {
  const seen = session(on);
  engine(on, { usage: () => usage(20_000) });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await step($, 'b2');
  await complete($, 'b2');
  expect(appended(seen).map((e) => e.record)).toEqual([{
    agentId: 'b2', agentType: null, requestedModel: null, resolvedModel: null, parentAgentId: null, background: false,
    fork: false, steps: 1, peakDepth: 20_000, window: 200_000, windowAssumed: false, peakBand: 'ok', toolResultChars: 0,
    warned: 0, refused: 0, reason: 'answer', isAborted: false,
  }]);
});

test('a step with no usage is skipped: it neither counts nor moves the peak', async ($, on) => {
  const seen = session(on);
  engine(on, { usage: (i) => (i === 1 ? null : usage(20_000)) });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($);
  await step($, 'a1', 0);
  await step($, 'a1', 1);
  await complete($, 'a1');
  const [{ record }] = appended(seen);
  expect([record.steps, record.peakDepth]).toEqual([1, 20_000]);
});

test('an aborted turn is recorded, with its reason and isAborted', async ($, on) => {
  const seen = session(on);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($);
  await step($, 'a1');
  await complete($, 'a1', 'aborted');
  const [{ record }] = appended(seen);
  expect([record.reason, record.isAborted]).toEqual(['aborted', true]);
});

test('a model with no knowable window records null window and band; an unpriced one records the assumed window', async ($, on) => {
  const seen = session(on);
  engine(on, { usage: (_i, agentId) => usage(20_000, agentId === 'a1' ? 'claude-sonnet-4-5-20250929' : 'claude-mythos-9') });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($);
  await step($, 'a1');
  await complete($, 'a1');
  await spawn($, { description: 'a2' });
  await step($, 'a2');
  await complete($, 'a2');
  const records = appended(seen).map((e) => e.record);
  expect([records[0].window, records[0].peakBand, records[0].windowAssumed]).toEqual([null, null, false]);
  expect([records[1].window, records[1].peakBand, records[1].windowAssumed]).toEqual([1_000_000, 'ok', true]);
});

test('a continued agent writes another record under the same agentId, its counters reset and its identity kept', async ($, on) => {
  const seen = session(on);
  engine(on, { usage: () => usage(20_000) });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await spawn($);
  await step($, 'a1');
  await step($, 'a1', 1);
  await complete($, 'a1');
  await step($, 'a1', 2);
  await complete($, 'a1');
  const records = appended(seen).map((e) => e.record);
  expect(records.map((r) => [r.agentId, r.agentType, r.steps])).toEqual([['a1', 'devcycle:implementer', 2], ['a1', 'devcycle:implementer', 1]]);
});

test('main-loop steps and completions write nothing', async ($, on) => {
  const seen = session(on);
  engine(on);
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await step($);
  await $.turn.complete({ turnId: 'm1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' });
  await mainCall($);
  expect(appended(seen)).toEqual([]);
});
