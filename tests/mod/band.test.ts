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
const BAND = (bodyColumns: number, hasSurvey = false, maxRows = 10) => ({
  plugin: 'devcycle', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey, isWorking: false, maxRows, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
}) as const;

// Mounts the band after the session starts and the timer ticks once (frame 1). `lines` reads each
// drawn row whole; the engine's own drawing, beneath the module, is a Text reading `engine`.
async function drawn($: any, on: any, world: World, now: number, opts: { columns?: number; hasSurvey?: boolean; maxRows?: number } = {}) {
  const clock = mock.clock(on, { now });
  world.surfaces ??= ['terminal'];
  session(on, world);
  engine(on);
  on('ui.render', ($$: any, e: any) => { const { Text } = $$.ui.resolve(e); return h(Text, null, 'engine'); });
  await $.session.start({ cwd: '/repo/src', surface: 'terminal', isInteractive: true });
  await clock.advance(300);
  const ui = await $.ui.mount(BAND(opts.columns ?? 115, opts.hasSurvey, opts.maxRows));
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

const ABSENT: [string, string | undefined][] = [['no progress file', undefined], ['an unparseable one', '{"v":1,'], ['another schema version', progress({ v: 3 })]];
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

// Schema v 2: the driver session, the driven session and each running dispatch are their own tiers.
const dispatch = (role: string, model: string, effort: string | null, tokens: number, routing?: string) =>
  ({ role, model, ...(effort ? { effort } : {}), tokens, window: 1_000_000, ...(routing ? { routing } : {}) });
const D4 = { ...task('4', 'implementing'), health: health('running', 3 * 60_000, 9, 4000), dispatch: dispatch('implementer', 'claude-sonnet-5-5', 'high', 36_000, 'fast') };
const D5 = { ...task('5', 'reviewing', 1, 1), health: health('running', 30_000, 2, 0), dispatch: dispatch('reviewer', 'claude-sonnet-5-5', 'high', 18_100, 'fast') };
const RUNNING_V2 = {
  v: 2, state: 'running', startedAt: '2026-10-25T08:10:00Z', updatedAt: '2026-10-25T09:12:00Z', waitUntil: null, waitWhat: null,
  stopDetail: null, outcome: null,
  driver: { model: 'claude-opus-5-5', effort: 'high', tokens: 230_100, window: 1_000_000, watcher: true },
  session: { n: 3, startedAt: '2026-10-25T09:00:00Z', model: 'claude-sonnet-5-5', effort: 'high', tokens: 182_400, window: 1_000_000 },
  currentWave: 2, committed: 4, total: 9,
  waves: [
    { wave: 1, committed: 3, tasks: [task('1', 'committed'), task('2', 'committed'), task('3', 'committed')] },
    { wave: 2, committed: 1, tasks: [D4, D5, task('6', 'committed'), task('7', 'pending')] },
    { wave: 3, committed: 0, tasks: [task('8', 'pending'), task('9', 'pending')] },
  ],
};
const progressV2 = (over: Record<string, unknown> = {}) => JSON.stringify({ ...RUNNING_V2, ...over });
const wave2 = (tasks: unknown[]) => RUNNING_V2.waves.map((w) => (w.wave === 2 ? { ...w, tasks } : w));
const STRIP_V2 = (columns: number, mark = '●2 1/4') => `  waves  ✓1 3/3 · ${mark} · ○3 0/2${' '.repeat(columns - 46)}4/9 committed`;

test('v2: the driver row, the live session row and each running dispatch with its model, effort, ctx, routing and tokens', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progressV2() }, AT('2026-10-25T09:12:10Z'), { columns: 140 });
  expect(await lines(ui)).toEqual([
    '⠙ devcycle drive · driver Opus-5.5 (high) · ctx 23% · 1h02m · 230.1k tok',
    '  session 3  Sonnet-5.5 (high) · ctx 18% · 12m · 182.4k tok',
    STRIP_V2(140),
    '  wave 2  ⠙ task 4  Sonnet-5.5 (high) · ctx 3% · implementing · fast · 3m · 9 tool calls · 36.0k tok',
    '          ⠙ task 5  Sonnet-5.5 (high) · ctx 1% · reviewing · round 1 (1 rejection) · fast · <1m · 2 tool calls · 18.1k tok',
    '          ✓ task 6  committed',
    '          ○ task 7  pending',
  ]);
  expect(await colorOf(ui, 'Opus-5.5 (high)')).toBe('#5fafaf');
  expect(await colorOf(ui, 'Sonnet-5.5 (high)')).toBe('#5fafaf');
  expect(await colorOf(ui, 'ctx 18%')).toBe('rgb(0,215,0)');
  expect(await colorOf(ui, '230.1k tok')).toBe('#d0d0d0');
  expect(await colorOf(ui, ' (1 rejection)')).toBe('warning');
  await ui.unmount();
});

test('v2: ctx runs green to amber to red across its two halves and clamps past the red end', async ($, on) => {
  const hot = progressV2({
    driver: { model: 'claude-opus-5-5', effort: 'high', tokens: 800_000, window: 1_000_000, watcher: true },
    session: { n: 3, startedAt: '2026-10-25T09:00:00Z', model: 'claude-sonnet-5-5', effort: 'high', tokens: 520_000, window: 1_000_000 },
  });
  const { ui } = await drawn($, on, { progress: hot }, AT('2026-10-25T09:12:10Z'), { columns: 140 });
  expect(await colorOf(ui, 'ctx 80%')).toBe('rgb(255,0,0)');
  expect(await colorOf(ui, 'ctx 52%')).toBe('rgb(244,139,0)');
  await ui.unmount();
});

test('v2: a missing value drops its segment, and only a running or quiet dispatch draws dispatch fields', async ($, on) => {
  const tasks = [
    { ...D4, dispatch: { role: 'implementer', model: 'gpt-x', tokens: 5000, window: 1_000_000, windowAssumed: true } },
    { ...D5, dispatch: dispatch('reviewer', 'claude-sonnet-5-5', 'high', 18_100) },
    { ...task('6', 'implementing'), health: health('ended-with-output', 60_000, 3, 0), dispatch: D4.dispatch },
    { ...task('7', 'implementing'), health: health('quiet', 20 * 60_000, 4, 14 * 60_000 + 30_000), dispatch: D4.dispatch },
    { ...task('10', 'implementing'), health: health('ended-without-output', 9 * 60_000, 12, 60_000), dispatch: D4.dispatch },
  ];
  const { ui } = await drawn($, on, { progress: progressV2({ waves: wave2(tasks) }) }, AT('2026-10-25T09:12:10Z'), { columns: 140 });
  expect((await lines(ui)).slice(3)).toEqual([
    '  wave 2  ⠙ task 4  gpt-x · implementing · 3m · 9 tool calls · 5.0k tok',
    '          ⠙ task 5  Sonnet-5.5 (high) · ctx 1% · reviewing · round 1 (1 rejection) · <1m · 2 tool calls · 18.1k tok',
    '          ⠙ task 6  implementing · 1m · 3 tool calls',
    '          ? task 7  Sonnet-5.5 (high) · ctx 3% · implementing · fast · silent 14m · 36.0k tok',
    '          ↻ task 10  implementing · ended before reporting — redispatching',
  ]);
  expect(await colorOf(ui, ' · silent 14m')).toBe('warning');
  await ui.unmount();
});

test('v2: a fix pass draws its implementer dispatch\'s model segment like an implementing task', async ($, on) => {
  const fixing = { ...task('4', 'fixing', 2, 1), health: D4.health, dispatch: D4.dispatch };
  const { ui } = await drawn($, on, { progress: progressV2({ waves: wave2([fixing]) }) }, AT('2026-10-25T09:12:10Z'), { columns: 140 });
  expect((await lines(ui)).slice(3)).toEqual([
    '  wave 2  ⠙ task 4  Sonnet-5.5 (high) · ctx 3% · fixing · round 2 (1 rejection) · fast · 3m · 9 tool calls · 36.0k tok',
  ]);
  await ui.unmount();
});

test('v2: a dispatch that outlived its step draws as a plain row, never with the dispatch\'s model, effort or ctx', async ($, on) => {
  const stale = health('running', 3 * 60_000, 9, 4000);
  const tasks = [
    { ...task('4', 'committed'), health: stale, dispatch: D4.dispatch },
    { ...task('5', 'committing'), health: stale, dispatch: D4.dispatch },
    { ...task('6', 'reviewing', 1), health: stale, dispatch: D4.dispatch },
    { ...task('7', 'needs-user'), health: stale, dispatch: D5.dispatch },
    { ...task('8', 'implementing'), health: stale, dispatch: D4.dispatch },
  ];
  const { ui } = await drawn($, on, { progress: progressV2({ waves: wave2(tasks) }) }, AT('2026-10-25T09:12:10Z'), { columns: 140 });
  expect((await lines(ui)).slice(3)).toEqual([
    '  wave 2  ✓ task 4  committed',
    '          ⠙ task 5  committing · 3m · 9 tool calls',
    '          ⠙ task 6  reviewing · round 1 · 3m · 9 tool calls',
    '          ⠙ task 7  needs-user · 3m · 9 tool calls',
    '          ⠙ task 8  Sonnet-5.5 (high) · ctx 3% · implementing · fast · 3m · 9 tool calls · 36.0k tok',
  ]);
  await ui.unmount();
});

test('v2 with no live watcher: the driver row is the drive row\'s model and effort, marked no watcher, and no session row', async ($, on) => {
  const none = progressV2({ driver: { model: 'claude-opus-5-5', effort: 'high', watcher: false }, session: null });
  const { ui } = await drawn($, on, { progress: none }, AT('2026-10-25T09:12:10Z'), { columns: 140 });
  const shown = await lines(ui);
  expect(shown.slice(0, 2)).toEqual(['⠙ devcycle drive · driver Opus-5.5 (high) · no watcher · 1h02m', STRIP_V2(140)]);
  expect(await colorOf(ui, 'no watcher')).toBe('subtle');
  await ui.unmount();
});

test('v2 silent past 120 s: the header says the drive went silent, in warning, naming the driver session\'s model', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progressV2() }, AT('2026-10-25T09:14:01Z'), { columns: 140 });
  const header = `? drive silent since ${hhmm('2026-10-25T09:12:00Z')} · devcycle drive · driver Opus-5.5 (high)`;
  expect((await lines(ui))[0]).toBe(header);
  expect(await colorOf(ui, header)).toBe('warning');
  await ui.unmount();
});

test('v2 silent past 120 s on a narrow terminal: the sliced header keeps its warning color', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progressV2() }, AT('2026-10-25T09:14:01Z'), { columns: 30 });
  const header = (await lines(ui))[0];
  expect(header.length).toBeLessThanOrEqual(30);
  expect(header.startsWith('? drive silent since')).toBe(true);
  expect(await colorOf(ui, header)).toBe('warning');
  await ui.unmount();
});

test('v2 ended: elapsed frozen at the last write, no session row, and the v1 end line', async ($, on) => {
  const ended = progressV2({ state: 'ended', outcome: 'complete', session: null, currentWave: null });
  const { ui } = await drawn($, on, { progress: ended }, AT('2026-10-25T11:00:00Z'), { columns: 140 });
  expect(await lines(ui)).toEqual([
    'devcycle drive · driver Opus-5.5 (high) · ctx 23% · 1h02m · 230.1k tok',
    STRIP_V2(140, '○2 1/4'),
    '  ✓ run complete — run /devcycle:continue',
  ]);
  await ui.unmount();
});

test('v2 at 80 columns: every row fits, a task row keeps its step, round and rejection and cuts its end with …', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progressV2() }, AT('2026-10-25T09:12:10Z'), { columns: 80 });
  const shown = await lines(ui);
  expect(shown).toEqual([
    '⠙ devcycle drive · driver Opus-5.5 (high) · ctx 23% · 1h02m · 230.1k tok',
    '  session 3  Sonnet-5.5 (high) · ctx 18% · 12m · 182.4k tok',
    STRIP_V2(80),
    '  wave 2  ⠙ task 4  Sonnet-5.5 (high) · ctx 3% · implementing · fas… · 36.0k tok',
    '          ⠙ task 5  Sonnet-5.5 (high) · reviewing · round 1 (1 rejection) · fas…',
    '          ✓ task 6  committed',
    '          ○ task 7  pending',
  ]);
  for (const line of shown) expect([...line].length <= 80).toBe(true);
  await ui.unmount();
});

// Six tasks in the running wave: two dispatches, two committed, one pending and one waiting on the user.
const SIX = progressV2({ waves: RUNNING_V2.waves.map((w) => (w.wave === 2
  ? { wave: 2, committed: 2, tasks: [D4, D5, task('6', 'committed'), task('7', 'pending'), task('8', 'committed'), task('9', 'needs-user')] }
  : w)) });
const SIX_HEAD = [
  '⠙ devcycle drive · driver Opus-5.5 (high) · ctx 23% · 1h02m · 230.1k tok',
  '  session 3  Sonnet-5.5 (high) · ctx 18% · 12m · 182.4k tok',
  `  waves  ✓1 3/3 · ●2 2/6 · ○3 0/2${' '.repeat(34)}4/9 committed`,
];
const SIX_DISPATCHES = [
  '  wave 2  ⠙ task 4  Sonnet-5.5 (high) · ctx 3% · implementing · fas… · 36.0k tok',
  '          ⠙ task 5  Sonnet-5.5 (high) · reviewing · round 1 (1 rejection) · fas…',
];
const FOLDS: [number, string[]][] = [
  [10, [...SIX_HEAD, ...SIX_DISPATCHES, '          ✓ task 6  committed', '          ○ task 7  pending', '          ✓ task 8  committed', '          ⠙ task 9  needs-user']],
  [7, [...SIX_HEAD, ...SIX_DISPATCHES, '          ⠙ task 9  needs-user', '          ✓ 2 committed · ○ 1 pending']],
  [6, [SIX_HEAD[0], SIX_HEAD[2], ...SIX_DISPATCHES, '          ⠙ task 9  needs-user', '          ✓ 2 committed · ○ 1 pending']],
  [4, [SIX_HEAD[0], '  wave 2  ⠙ task 5  Sonnet-5.5 (high) · reviewing · round 1 (1 rejection) · fas…', '          ⠙ task 9  needs-user', '          +4 more']],
];
for (const [maxRows, expected] of FOLDS)
  test(`v2 at 80 columns with six tasks and maxRows ${maxRows}: every line fits, folded in order, the warnings kept to the last`, async ($, on) => {
    const { ui } = await drawn($, on, { progress: SIX }, AT('2026-10-25T09:12:10Z'), { columns: 80, maxRows });
    const shown = await lines(ui);
    expect(shown).toEqual(expected);
    for (const line of shown) expect([...line].length <= 80).toBe(true);
    await ui.unmount();
  });

test('the fold is v2\'s alone: a v1 file over maxRows draws every row as today', async ($, on) => {
  const { ui } = await drawn($, on, { progress: progress() }, AT('2026-10-25T09:12:10Z'), { maxRows: 3 });
  expect((await lines(ui)).slice(2)).toEqual(RUNNING_ROWS);
  await ui.unmount();
});
