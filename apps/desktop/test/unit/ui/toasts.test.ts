// The in-window toasts (src/ui/lib/toasts.ts): a toast expires after its time (6 s by default), one pushed with 0
// stays until it is dismissed, at most three at once (the oldest goes first); a runtime notification for a to-do, a
// blocker or an important message stays until Open or Dismiss (or until store-events drops it: its chat or My day
// open, its to-do finished), a reply or a result expires.
// Owns: these assertions only. Never: the status line's markup (shell/StatusLine.tsx) or a real window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissToast, dismissToastsWhere, pushToast, toastNotification, toasts } from '../../../src/ui/lib/toasts.ts';

const titles = () => toasts.value.map((toast) => toast.title);

test('a toast expires after its time; one pushed with 0 stays until dismissed; at most three at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  pushToast({ title: 'Copied', tone: 'info' }, 1500);
  pushToast({ title: 'Kept' }, 0);
  pushToast({ title: 'Default' });
  t.mock.timers.tick(1500);
  assert.deepEqual(titles(), ['Kept', 'Default']);
  t.mock.timers.tick(4500);
  assert.deepEqual(titles(), ['Kept'], 'the default time is 6 s');
  t.mock.timers.tick(30 * 24 * 60 * 60_000);
  assert.deepEqual(titles(), ['Kept'], 'no timer for 0');
  for (const title of ['a', 'b', 'c']) pushToast({ title }, 0);
  assert.deepEqual(titles(), ['a', 'b', 'c'], 'the oldest goes first');
  dismissToast(toasts.value[0].id);
  assert.deepEqual(titles(), ['b', 'c']);
});

test('a notification for a to-do, a blocker or an important message stays until Open or Dismiss; a reply or a result expires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  toasts.value = [];
  toastNotification({ kind: 'important', title: 'Max posted on X', body: 'The launch post is live', conversationId: 'ch_1' });
  toastNotification({ kind: 'reply', title: 'Max', body: 'Done.', conversationId: 'ch_1' });
  assert.deepEqual(titles(), ['Max posted on X', 'Max']);
  t.mock.timers.tick(6000);
  assert.deepEqual(toasts.value.map(({ title, body, conversationId }) => ({ title, body, conversationId })), [{ title: 'Max posted on X', body: 'The launch post is live', conversationId: 'ch_1' }], 'the reply expired');
  toasts.value = [];
  for (const kind of ['todo', 'blocker', 'done'] as const) toastNotification({ kind, title: kind, body: '', taskId: 'task_1' });
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(titles(), ['todo', 'blocker'], 'the result expired');
  assert.equal(toasts.value[0].taskId, 'task_1', 'Open goes to the to-do');
});

test('dismissToastsWhere drops only the toasts it picks (a chat opened, a to-do finished elsewhere)', () => {
  toasts.value = [];
  toastNotification({ kind: 'important', title: 'In chat 1', body: '', conversationId: 'ch_1' });
  toastNotification({ kind: 'todo', title: 'To-do 1', body: '', taskId: 'task_1' });
  toastNotification({ kind: 'blocker', title: 'Blocker in chat 2', body: '', conversationId: 'ch_2', taskId: 'task_2' });
  const before = toasts.value;
  dismissToastsWhere((toast) => toast.conversationId === 'ch_3');
  assert.equal(toasts.value, before, 'none picked: the list is left as it is (no redraw)');
  dismissToastsWhere((toast) => toast.conversationId === 'ch_1');
  assert.deepEqual(titles(), ['To-do 1', 'Blocker in chat 2'], 'chat 1 opened');
  dismissToastsWhere((toast) => toast.taskId === 'task_1');
  assert.deepEqual(titles(), ['Blocker in chat 2'], 'to-do 1 answered on the phone');
  dismissToastsWhere((toast) => toast.taskId === 'task_2');
  assert.deepEqual(titles(), []);
});
