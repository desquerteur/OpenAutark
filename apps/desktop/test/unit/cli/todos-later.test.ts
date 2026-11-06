// `wf todos` after F04 (INT-1): todos.list also returns what waits under "Later" (snoozed, a
// repeating timer until its next time, a timer more than 12 h ahead). The lines list what is due
// now first, then "Later (n):" with when each one rings – "snoozed until 14:32" from the end the
// snooze recorded, "snoozed" without one, "rings …" for a timer; --json prints the runtime's data,
// and the command's help says which items "Later" holds (a far timer is status 'open' there).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTodos } from '../../../src/runtime/wf-cli/format.ts';
import { AT, task } from './fixtures.ts';
import { fakeRuntime, wf } from './fake-runtime.ts';

const M = 60_000;
const H = 60 * M;

const sign = task({ id: 'task_s', title: 'Sign the form', assigneeKind: 'human', status: 'open', dueAt: AT + H });
const nap = task({ id: 'task_n', title: 'Take the bread out', assigneeKind: 'human', status: 'waiting', widget: { type: 'timer', label: 'Bread', at: new Date(AT - 5 * M).toISOString() }, waitingOn: { kind: 'schedule', reason: 'Snoozed', since: AT, until: AT + 30 * M } });
const older = task({ id: 'task_o', title: 'Stretch', assigneeKind: 'human', status: 'waiting', waitingOn: { kind: 'schedule', reason: 'Snoozed', since: AT } });
const dentist = task({ id: 'task_d', title: 'Dentist', assigneeKind: 'human', status: 'open', widget: { type: 'timer', label: 'Dentist', at: new Date(new Date(2026, 9, 23, 9, 0).getTime()).toISOString() }, dueAt: new Date(2026, 9, 23, 9, 0).getTime() });

test('formatTodos: what is due now, then "Later (n):" with when each rings', () => {
  assert.deepEqual(formatTodos([nap, sign, dentist, older], AT), [
    '• Sign the form · in Launch · due 15:02 · task_s',
    'Later (3):',
    '• Take the bread out · timer · in Launch · snoozed until 14:32 · task_n',
    '• Dentist · timer · in Launch · rings 2026-10-23 09:00 · task_d',
    '• Stretch · in Launch · snoozed · task_o',
  ]);
  assert.deepEqual(formatTodos([nap], AT), ['Nothing needs you right now.', 'Later (1):', '• Take the bread out · timer · in Launch · snoozed until 14:32 · task_n']);
  assert.deepEqual(formatTodos([dentist], new Date(2026, 9, 23, 8, 0).getTime()), ['• Dentist · timer · in Launch · due 09:00 · task_d'], 'within 12 h it is due now');
});

test('wf todos prints the split; --json the runtime\'s list as it is', async (t) => {
  const runtime = await fakeRuntime({ 'todos.list': () => [nap, sign] });
  t.after(() => runtime.stop());
  const out = await wf(['todos'], { runtime });
  assert.equal(out.out, '• Sign the form · in Launch · due 15:02 · task_s\nLater (1):\n• Take the bread out · timer · in Launch · snoozed until 14:32 · task_n\n');
  const json = await wf(['todos', '--json'], { runtime });
  assert.deepEqual(JSON.parse(json.out).map((todo: { id: string }) => todo.id), ['task_n', 'task_s']);
  const help = (await wf(['help', 'todos'])).out;
  assert.ok(help.includes('snoozed, a repeating timer until its next time, or a timer (widget.at) more than 12 h ahead'), 'what "Later" holds');
  assert.match(help, /--json prints the runtime's list unsplit/);
});
