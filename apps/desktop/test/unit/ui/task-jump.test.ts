// Which chats a task surface may open and how Work's detail opens and closes
// (src/ui/tasks/jump.ts): ordinary chats in the store open; the app-owned anchor chats – the task
// center's Inbox and the To-do chat – never do, also once a conversation.upserted event or a lookup
// has put them into the store, so their tasks open the task detail in Work instead. B-041: the
// selection is the route's ?task= – opened from the list it is a history entry Back closes, a switch
// to another task replaces it, Close returns to the list, a sidebar click (a Work route without a
// task) clears it; and the Work clock moves at the one moment it was armed for.
// Owns: these assertions only.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSummary, SystemChat } from '../../../src/shared/model/chat.ts';
import { navigate, parseRoute } from '../../../src/ui/lib/router.ts';
import { conversations, route } from '../../../src/ui/lib/store.ts';
import { armWorkClock, canOpenChat, closeTask, openTask, openTaskDetail, selectTask, selectedTaskId, workClock } from '../../../src/ui/tasks/jump.ts';
import { workRoute } from '../../../src/ui/tasks/work-model.ts';

function chat(id: string, system?: SystemChat): ConversationSummary {
  return {
    id, title: id, members: [], settings: system ? { hiddenFromList: true, system } : {}, createdAt: 0, unread: 0, working: [],
  } as unknown as ConversationSummary;
}

// The router writes the hash in a window: a small history stand-in (entries, push, replace, back with its popstate).
const entries: string[] = ['#/home'];
let at = 0;
Object.assign(globalThis, {
  location: { get hash() { return entries[at]; } },
  history: {
    get length() { return entries.length; },
    pushState: (_state: unknown, _title: string, hash: string) => { entries.splice(at + 1); entries.push(hash); at++; },
    replaceState: (_state: unknown, _title: string, hash: string) => { entries[at] = hash; },
    back: () => { if (at > 0) at--; route.value = parseRoute(entries[at]); },
  },
});

/** Starts from `hash` as the only history entry. */
function startAt(hash: string): void {
  entries.splice(0, entries.length, hash);
  at = 0;
  route.value = parseRoute(hash);
}

test('ordinary chats open; the Inbox and the To-do chat never do, even when they are in the store', () => {
  conversations.value = [chat('ch_lea'), chat('ch_inbox', 'inbox'), chat('ch_todo', 'todo'), chat('ch_customize', 'customize')];
  assert.equal(canOpenChat('ch_lea'), true);
  assert.equal(canOpenChat('ch_customize'), true, 'the Customize chat is a chat the person works in');
  assert.equal(canOpenChat('ch_inbox'), false, 'the Inbox only holds intake records');
  assert.equal(canOpenChat('ch_todo'), false, 'the To-do chat only anchors the person\'s to-dos');
  assert.equal(canOpenChat('ch_unknown'), false, 'not in the store: not openable from here');
});

test('openTask: a task in the Inbox opens its detail in Work, not the hidden chat', () => {
  conversations.value = [chat('ch_lea'), chat('ch_inbox', 'inbox')];
  startAt('#/home');
  openTask({ id: 'task_1', conversationId: 'ch_inbox', messageId: 'msg_1' });
  assert.equal(selectedTaskId.value, 'task_1');
  assert.equal(location.hash, '#/tasks?task=task_1', 'Work shows the detail, the selection in the route');
  assert.ok(!entries.some((hash) => hash.includes('ch_inbox')), 'never navigates to the Inbox');
  closeTask();
  assert.deepEqual([...entries], ['#/home', '#/tasks'], 'Close shows the Work list (not back to Home)');
  assert.equal(selectedTaskId.value, null);
});

test('Work list: a row opens ?task= as a new entry, another row replaces it, Close and Back both close it', () => {
  startAt('#/tasks/stuck?owner=ag_mara');
  selectTask('task_a');
  assert.deepEqual([...entries], ['#/tasks/stuck?owner=ag_mara', '#/tasks/stuck?owner=ag_mara&task=task_a'], 'view and owner kept');
  assert.equal(selectedTaskId.value, 'task_a');
  selectTask('task_b');
  assert.deepEqual([...entries], ['#/tasks/stuck?owner=ag_mara', '#/tasks/stuck?owner=ag_mara&task=task_b'], 'a switch replaces the entry');
  closeTask();
  assert.equal(at, 0, 'Close went back to the list it was opened from');
  assert.equal(selectedTaskId.value, null);
  // Back (the phone's, the browser's) closes it the same way.
  selectTask('task_c');
  (globalThis as unknown as { history: History }).history.back();
  assert.equal(selectedTaskId.value, null);
  assert.equal(location.hash, '#/tasks/stuck?owner=ag_mara');
});

test('a link straight to a task: Close stays in Work and drops ?task= in place', () => {
  startAt('#/tasks?task=task_x');
  assert.equal(selectedTaskId.value, 'task_x');
  closeTask();
  assert.deepEqual([...entries], ['#/tasks']);
  closeTask(); // nothing open: nothing happens
  assert.deepEqual([...entries], ['#/tasks']);
});

test('a sidebar click is a Work route without a task: the detail closes, the owner stays', () => {
  startAt('#/tasks?owner=per_anna&task=task_y');
  navigate(workRoute('per_anna'));
  assert.equal(location.hash, '#/tasks?owner=per_anna');
  assert.equal(selectedTaskId.value, null);
  // From elsewhere (a chat's "Open in Work") Work opens with the task; Close shows the list.
  startAt('#/chat/ch_lea');
  openTaskDetail('task_z');
  assert.equal(location.hash, '#/tasks?task=task_z');
  closeTask();
  assert.deepEqual([...entries], ['#/chat/ch_lea', '#/tasks']);
});

test('the Work clock moves once, at the moment it was armed for', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const before = workClock.value;
    armWorkClock(1_000_000 + 60_000);
    mock.timers.tick(59_999);
    assert.equal(workClock.value, before, 'not yet');
    mock.timers.tick(1);
    assert.equal(workClock.value, 1_060_000);
    armWorkClock(1_200_000);
    armWorkClock(undefined); // nothing ahead: the timeout is gone
    mock.timers.tick(500_000);
    assert.equal(workClock.value, 1_060_000);
  } finally {
    mock.timers.reset();
  }
});
