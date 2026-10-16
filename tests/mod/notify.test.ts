import { test, expect } from 'claude-code/testing';
import { bash, engine, session, startNotifying } from './harness.ts';

const MARK = 'node "/plugin/scripts/handoff-mark.mjs" --state .devcycle/state.md --ready --action clear --completed planning';
const DONE = 'devcycle: planning done — safe to /clear + /devcycle:continue';
const PRINTED = `handoff: ready 2026-10-16T10:00:00Z\nnotify: terminal ${DONE}\nnotify: push ${DONE}\n`;
const stdoutOf = (command: string) => (command.includes('handoff-mark.mjs') ? PRINTED : 'notify: terminal not from the mark\n');

// Each test runs only where the Claude Code knows the `ui.notify` event; elsewhere startNotifying logs it skipped.
const RAISED = "a handoff-mark call's notify: terminal line is raised once through the notification channel, titled devcycle";
test(RAISED, async ($, on) => {
  const seen = session(on, { notifies: true });
  engine(on, { bashStdout: stdoutOf });
  if (!(await startNotifying($, seen, RAISED))) return;
  const ran = await bash($, MARK);
  expect(seen.notified).toEqual([{ text: DONE, title: 'devcycle' }]);
  expect(ran.result.stdout).toBe(PRINTED);
});

const NOT_RAISED = 'no notification from another command, or from a mark that printed no notify: terminal line';
test(NOT_RAISED, async ($, on) => {
  const seen = session(on, { notifies: true });
  engine(on, { bashStdout: (command) => (command.includes('handoff-mark.mjs') ? 'handoff: pending 2026-10-16T10:00:00Z\n' : stdoutOf(command)) });
  if (!(await startNotifying($, seen, NOT_RAISED))) return;
  await bash($, "echo 'notify: terminal not from the mark'");
  await bash($, MARK.replace('--ready --action clear --completed planning', '--pending'));
  expect(seen.notified).toEqual([]);
});

const NO_RUN = 'the relay needs no joined run';
test(NO_RUN, async ($, on) => {
  const seen = session(on, { joined: false, state: null, notifies: true });
  engine(on, { bashStdout: stdoutOf });
  if (!(await startNotifying($, seen, NO_RUN))) return;
  await bash($, MARK);
  expect(seen.notified).toEqual([{ text: DONE, title: 'devcycle' }]);
});

const REFUSED = 'a refused notification never fails or changes the Bash call';
test(REFUSED, async ($, on) => {
  const seen = session(on, { notifies: true, notifyDenies: true });
  engine(on, { bashStdout: stdoutOf });
  if (!(await startNotifying($, seen, REFUSED))) return;
  const ran = await bash($, MARK);
  expect(ran.result.stdout).toBe(PRINTED);
});
