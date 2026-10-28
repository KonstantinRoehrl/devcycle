import { test, expect, mock } from 'claude-code/testing';
import { engine, session } from './harness.ts';
import type { World } from './harness.ts';

const START = Date.parse('2026-10-25T08:00:00Z');
const AT = (iso: string) => Date.parse(iso);
const task = (id: string, step: string, round = 0, rejections = 0) => ({ task: id, step, round, rejections });
const RUNNING = {
  v: 1, state: 'running', session: 4, model: 'claude-opus-5-5', effort: 'high',
  startedAt: '2026-10-25T08:00:00Z', updatedAt: '2026-10-25T09:12:00Z', waitUntil: null, waitWhat: null,
  stopDetail: null, outcome: null, currentWave: 3, committed: 6, total: 14,
  waves: [
    { wave: 1, committed: 3, tasks: [task('1', 'committed'), task('2', 'committed'), task('3', 'committed')] },
    { wave: 2, committed: 2, tasks: [task('4', 'committed'), task('5', 'committed')] },
    { wave: 3, committed: 1, tasks: [task('7', 'reviewing', 2, 1), task('8', 'implementing'), task('9', 'committed')] },
    { wave: 4, committed: 0, tasks: [task('10', 'pending'), task('11', 'pending')] },
    { wave: 5, committed: 0, tasks: [task('12', 'pending'), task('13', 'pending')] },
    { wave: 6, committed: 0, tasks: [task('14', 'pending')] },
  ],
};
const progress = (over: Record<string, unknown> = {}) => JSON.stringify({ ...RUNNING, ...over });
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const BAND = (bodyColumns: number, hasSurvey = false) => ({
  plugin: 'devcycle', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}) as const;

// Mounts the band after the session starts and the timer ticks once (frame 1). `lines` reads each
// drawn row whole; the engine's own drawing, beneath the module, is a Text reading `engine`.
async function drawn($: any, on: any, world: World, now: number, opts: { columns?: number; hasSurvey?: boolean } = {}) {
  const clock = mock.clock(on, { now });
  world.surfaces ??= ['terminal'];
  session(on, world);
  engine(on);
  on('ui.render', ($$: any, e: any) => { const { Text } = $$.ui.resolve(e); return h(Text, null, 'engine'); });
  await $.session.start({ cwd: '/repo/src', surface: 'terminal', isInteractive: true });
  await clock.advance(300);
  const ui = await $.ui.mount(BAND(opts.columns ?? 115, opts.hasSurvey));
  return { ui, clock };
}
const texts = async (ui: any) => await ui.findAll({ type: 'Text' });
const lines = async (ui: any) => (await texts(ui)).filter((t: any) => t.props.wrap === 'truncate').map((t: any) => t.text);
// A colored part is a Text inside its row's Text.
const colorOf = async (ui: any, text: string) => (await texts(ui)).find((t: any) => !t.props.wrap && t.text === text)?.props.color;
const engineDrew = async (ui: any) => (await lines(ui)).length === 0 && (await texts(ui)).some((t: any) => t.text === 'engine');

const RUNNING_ROWS = [
  '  wave 3  ⠙ task 7  reviewing · round 2 (1 rejection)',
  '          ⠙ task 8  implementing',
  '          ✓ task 9  committed',
];

test('a running driver: header, wave strip with the total right-aligned, and the current wave\'s tasks', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:12:10Z'));
  expect(await lines(ui)).toEqual([
    '⠙ devcycle drive · session 4 · claude-opus-5-5 · high · 1h12m',
    `  waves  ✓1 3/3 · ✓2 2/2 · ●3 1/3 · ○4 0/2 · ○5 0/2 · ○6 0/1${' '.repeat(41)}6/14 committed`,
    ...RUNNING_ROWS,
  ]);
  expect(await colorOf(ui, '✓1 3/3')).toBe('success');
  expect(await colorOf(ui, '●3 1/3')).toBe('claude');
  expect(await colorOf(ui, '○4 0/2')).toBe('subtle');
  expect(await colorOf(ui, ' (1 rejection)')).toBe('warning');
  await ui.unmount();
});

test('the spinner turns once per 300 ms tick while the driver runs', async ($, on) => {
  const { ui, clock } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:12:10Z'));
  await clock.advance(300);
  expect((await lines(ui))[0]).toBe('⠹ devcycle drive · session 4 · claude-opus-5-5 · high · 1h12m');
  await ui.unmount();
});

test('waiting: the wait replaces the task rows and the spinner keeps turning', async ($, on) => {
  const wait = { state: 'waiting', waitWhat: 'usage limit', waitUntil: '2026-10-25T10:30:00Z' };
  const { ui, clock } = await drawn($, on, { progress: progress(wait) }, AT('2026-10-25T09:12:10Z'));
  await clock.advance(300);
  const shown = await lines(ui);
  expect(shown[0]).toBe('⠹ devcycle drive · session 4 · claude-opus-5-5 · high · 1h12m');
  expect(shown.slice(2)).toEqual([`  ⏸ usage limit — resumes ${hhmm('2026-10-25T10:30:00Z')}`]);
  expect(await colorOf(ui, shown[2])).toBe('warning');
  await ui.unmount();
});

test('stopped for the user: the stop replaces the task rows, no spinner, elapsed frozen at the last write', async ($, on) => {
  const stop = { state: 'stopped', stopDetail: 'gate-fail: task 7' };
  const { ui, clock } = await drawn($, on, { progress: progress(stop) }, AT('2026-10-25T11:00:00Z'));
  await clock.advance(300);
  const shown = await lines(ui);
  expect(shown[0]).toBe('devcycle drive · session 4 · claude-opus-5-5 · high · 1h12m');
  expect(shown.slice(2)).toEqual(['  ✖ stopped for you — gate-fail: task 7']);
  expect(await colorOf(ui, shown[2])).toBe('error');
  await ui.unmount();
});

test('an ended run: complete in success, any other outcome in error, both pointing at /devcycle:continue', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progress({ state: 'ended', outcome: 'complete', currentWave: null }) }, AT('2026-10-25T11:00:00Z'));
  const shown = await lines(ui);
  expect(shown.slice(2)).toEqual(['  ✓ run complete — run /devcycle:continue']);
  expect(await colorOf(ui, shown[2])).toBe('success');
  await ui.unmount();
});

test('an ended run with an outcome other than complete names it', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progress({ state: 'ended', outcome: 'no-progress' }) }, AT('2026-10-25T11:00:00Z'));
  const shown = await lines(ui);
  expect(shown.slice(2)).toEqual(['  ✖ run ended: no-progress — run /devcycle:continue']);
  expect(await colorOf(ui, shown[2])).toBe('error');
  await ui.unmount();
});

test('a driver silent past 120 s: the header says since when, in warning, and nothing turns', async ($, on) => {
  const { ui, clock } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:14:01Z'));
  await clock.advance(300);
  const shown = await lines(ui);
  const header = `? driver silent since ${hhmm('2026-10-25T09:12:00Z')} · devcycle drive · session 4 · claude-opus-5-5 · high`;
  expect(shown[0]).toBe(header);
  expect(await colorOf(ui, header)).toBe('warning');
  expect(shown[2]).toBe('  wave 3  ? task 7  reviewing · round 2 (1 rejection)');
  await ui.unmount();
});

test('a rewritten file is read on the next tick', async ($, on) => {
  const world: World = { progress: progress(), progressMtime: 1 };
  const { ui, clock } = await drawn($, on, world, AT('2026-10-25T09:12:10Z'));
  world.progress = progress({ state: 'stopped', stopDetail: 'user-stop: asked' });
  world.progressMtime = 2;
  await clock.advance(300);
  expect((await lines(ui)).slice(2)).toEqual(['  ✖ stopped for you — user-stop: asked']);
  await ui.unmount();
});

test('a narrow band drops the separators, then windows the strip around the current wave, never wrapping', async ($, on) => {
  const narrow = `  waves  … ✓2 2/2 ●3 1/3 ○4 0/2 ○5 0/2 …${' '.repeat(6)}6/14 committed`;
  const { ui } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:12:10Z'), { columns: 60 });
  expect((await lines(ui))[1]).toBe(narrow);
  await ui.unmount();
});

test('on 2.1.287 bodyColumns still counts the band\'s five mark cells, so the band lays out five narrower', async ($, on) => {
  const narrow = `  waves  … ✓2 2/2 ●3 1/3 ○4 0/2 ○5 0/2 …${' '.repeat(6)}6/14 committed`;
  const { ui } = await drawn($, on, { base: '2.1.287', progress: progress() }, AT('2026-10-25T09:12:10Z'), { columns: 65 });
  expect((await lines(ui))[1]).toBe(narrow);
  await ui.unmount();
});

test('the separators go before any windowing', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:12:10Z'), { columns: 70 });
  expect((await lines(ui))[1]).toBe(`  waves  ✓1 3/3 ✓2 2/2 ●3 1/3 ○4 0/2 ○5 0/2 ○6 0/1${' '.repeat(6)}6/14 committed`);
  await ui.unmount();
});

const ABSENT: [string, string | undefined][] = [['no progress file', undefined], ['an unparseable one', '{"v":1,'], ['another schema version', progress({ v: 2 })]];
for (const [name, progressText] of ABSENT) {
  test(`absent with ${name}: the engine's drawing stands`, async ($, on) => {
    const { ui } = await drawn($, on, { progress: progressText }, AT('2026-10-25T09:12:10Z'));
    expect(await engineDrew(ui)).toBe(true);
    await ui.unmount();
  });
}

test('a survey holds the band: the module yields to it', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:12:10Z'), { hasSurvey: true });
  expect(await engineDrew(ui)).toBe(true);
  await ui.unmount();
});

const INERT: [string, World][] = [['a session with no surface (claude -p)', { surfaces: [] }], ["devcycle's own nested children", { nested: '1' }]];
for (const [name, world] of INERT) {
  test(`no band in ${name}`, async ($, on) => {
    const { ui } = await drawn($, on, { progress: progress(), ...world }, AT('2026-10-25T09:12:10Z'));
    expect(await engineDrew(ui)).toBe(true);
    await ui.unmount();
  });
}

const health = (state: string, elapsedMs: number, toolUses: number, sinceActivityMs: number) => ({ state, elapsedMs, toolUses, sinceActivityMs });
const HEALTH_WAVE = { wave: 3, committed: 0, tasks: [
  { ...task('7', 'implementing'), health: health('running', 7 * 60_000 + 5_000, 23, 10_000) },
  { ...task('8', 'reviewing', 2, 1), health: health('running', 30_000, 1, 0) },
  { ...task('9', 'implementing'), health: health('quiet', 20 * 60_000, 4, 14 * 60_000 + 30_000) },
  { ...task('10', 'implementing'), health: health('ended-without-output', 9 * 60_000, 12, 60_000) },
  { ...task('11', 'reviewing', 1), health: health('ended-without-output', 2 * 60_000, 3, 0) },
] };
const HEALTH_ROWS = [
  '  wave 3  ⠙ task 7  implementing · 7m · 23 tool calls',
  '          ⠙ task 8  reviewing · round 2 (1 rejection) · <1m · 1 tool call',
  '          ? task 9  implementing · silent 14m',
  '          ↻ task 10  implementing · ended before reporting — redispatching',
  '          ↻ task 11  reviewing · round 1 · ended before reporting — redispatching',
];
const withHealth = () => progress({ waves: RUNNING.waves.map((w) => (w.wave === 3 ? HEALTH_WAVE : w)) });

test('a dispatch\'s health: elapsed time and tool calls while it runs, silent and ended before reporting in warning', async ($, on) => {
  const { ui } = await drawn($, on, { progress: withHealth() }, AT('2026-10-25T09:12:10Z'));
  expect((await lines(ui)).slice(2)).toEqual(HEALTH_ROWS);
  expect(await colorOf(ui, 'implementing · silent 14m')).toBe('warning');
  expect(await colorOf(ui, 'implementing · ended before reporting — redispatching')).toBe('warning');
  expect(await colorOf(ui, ' (1 rejection)')).toBe('warning');
  await ui.unmount();
});

test('on 2.1.287 the health rows draw the same, one line each', async ($, on) => {
  const { ui } = await drawn($, on, { base: '2.1.287', progress: withHealth() }, AT('2026-10-25T09:12:10Z'), { columns: 90 });
  expect((await lines(ui)).slice(2)).toEqual(HEALTH_ROWS);
  await ui.unmount();
});

// The renderer truncates a row from its tail (wrap: 'truncate'); `lines` reads the row whole, so the
// order of the parts is what decides which one a narrow terminal drops first.
test('a row puts its rejection warning ahead of its tool calls, so truncation takes the tool calls first', async ($, on) => {
  const { ui } = await drawn($, on, { progress: withHealth() }, AT('2026-10-25T09:12:10Z'), { columns: 60 });
  const row = (await lines(ui)).find((l: string) => l.includes('task 8')) as string;
  expect(row.indexOf('(1 rejection)')).toBeGreaterThan(-1);
  expect(row.indexOf('1 tool call')).toBeGreaterThan(row.indexOf('(1 rejection)'));
  await ui.unmount();
});
