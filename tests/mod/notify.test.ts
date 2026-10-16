import { test, expect } from 'claude-code/testing';
import { bash, engine, session } from './harness.ts';

const MARK = 'node "/plugin/scripts/handoff-mark.mjs" --state .devcycle/state.md --ready --action clear --completed planning';
const DONE = 'devcycle: planning done — safe to /clear + /devcycle:continue';
const PRINTED = `handoff: ready 2026-10-16T10:00:00Z\nnotify: terminal ${DONE}\nnotify: push ${DONE}\n`;
const stdoutOf = (command: string) => (command.includes('handoff-mark.mjs') ? PRINTED : 'notify: terminal not from the mark\n');

test("a handoff-mark call's notify: terminal line is raised once through the notification channel, titled devcycle", async ($, on) => {
  const seen = session(on);
  engine(on, { bashStdout: stdoutOf });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  const ran = await bash($, MARK);
  expect(seen.notified).toEqual([{ text: DONE, title: 'devcycle' }]);
  expect(ran.result.stdout).toBe(PRINTED);
});

test('no notification from another command, or from a mark that printed no notify: terminal line', async ($, on) => {
  const seen = session(on);
  engine(on, { bashStdout: (command) => (command.includes('handoff-mark.mjs') ? 'handoff: pending 2026-10-16T10:00:00Z\n' : stdoutOf(command)) });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await bash($, "echo 'notify: terminal not from the mark'");
  await bash($, MARK.replace('--ready --action clear --completed planning', '--pending'));
  expect(seen.notified).toEqual([]);
});

test('the relay needs no joined run', async ($, on) => {
  const seen = session(on, { joined: false, state: null });
  engine(on, { bashStdout: stdoutOf });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  await bash($, MARK);
  expect(seen.notified).toEqual([{ text: DONE, title: 'devcycle' }]);
});

test('a refused notification never fails or changes the Bash call', async ($, on) => {
  session(on, { notifyDenies: true });
  engine(on, { bashStdout: stdoutOf });
  await $.turn.start({ text: 'go', turnId: 'm1' });
  const ran = await bash($, MARK);
  expect(ran.result.stdout).toBe(PRINTED);
});
