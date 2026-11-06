// B-054 wake origin (src/runtime/wakes/queue.ts): stored and read back, the older origin wins on a merge (like the
// chat and the task), it survives claim/release and reconcile, and chat-free, task-free wakes of two sources stay
// apart. Owns: these assertions only. Never: real timers (ManualClock).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { WakeQueueImpl } from '../../../src/runtime/wakes/queue.ts';

const T0 = Date.UTC(2026, 9, 29, 9, 0, 0);
const MAIL = { source: 'app:ap_mail', label: 'New mail in office@example.com' };
const NEWS = { source: 'news', label: 'Task news' };

function setup() {
  const db = new Db(':memory:');
  migrate(db);
  const clock = new ManualClock(T0);
  return { db, clock, wakes: new WakeQueueImpl({ db, clock }) };
}

test('a wake keeps its origin; a wake without one has none', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'event', note: 'Mail', origin: MAIL });
  wakes.wake({ agentId: 'ag_a', reason: 'message', conversationId: 'cv_1' });
  const [mail, chat] = [wakes.list('ag_a').find((w) => w.reason === 'event')!, wakes.list('ag_a').find((w) => w.reason === 'message')!];
  assert.deepEqual(mail.origin, MAIL);
  assert.equal('origin' in chat, false);
});

test('on a merge the older origin wins, like the chat; a later origin fills an empty one', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'event', coalesceKey: 'k', note: 'one', origin: MAIL });
  wakes.wake({ agentId: 'ag_a', reason: 'event', coalesceKey: 'k', note: 'two', origin: NEWS });
  assert.equal(wakes.pending('ag_a'), 1);
  assert.deepEqual(wakes.list('ag_a')[0].origin, MAIL);
  assert.equal(wakes.list('ag_a')[0].note, 'one\n\ntwo');
  wakes.wake({ agentId: 'ag_b', reason: 'task', taskId: 'tk_1', coalesceKey: 'k' });
  wakes.wake({ agentId: 'ag_b', reason: 'task', taskId: 'tk_1', coalesceKey: 'k', origin: NEWS });
  assert.deepEqual(wakes.list('ag_b')[0].origin, NEWS);
});

test('the origin survives claim, release (merged with a newer wake) and reconcile', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'event', note: 'first', origin: MAIL });
  const [claimed] = wakes.claim('ag_a');
  assert.deepEqual(claimed.origin, MAIL);
  wakes.wake({ agentId: 'ag_a', reason: 'event', note: 'second', origin: MAIL });
  wakes.release([claimed.id]);
  const [back] = wakes.list('ag_a');
  assert.equal(wakes.pending('ag_a'), 1);
  assert.deepEqual(back.origin, MAIL);
  assert.equal(back.note, 'first\n\nsecond');
  wakes.claim('ag_a');
  assert.equal(wakes.reconcile(), 1);
  assert.deepEqual(wakes.list('ag_a')[0].origin, MAIL);
});

test('chat-free, task-free wakes of two sources stay apart; chat and task wakes key as before', () => {
  const { wakes } = setup();
  wakes.wake({ agentId: 'ag_a', reason: 'task', note: 'news', origin: NEWS });
  wakes.wake({ agentId: 'ag_a', reason: 'task', note: 'mail', origin: { source: 'app:ap_other', label: 'Other' } });
  assert.equal(wakes.pending('ag_a'), 2);
  wakes.wake({ agentId: 'ag_b', reason: 'task', taskId: 'tk_1', origin: NEWS });
  wakes.wake({ agentId: 'ag_b', reason: 'task', taskId: 'tk_1', origin: MAIL });
  assert.equal(wakes.pending('ag_b'), 1, 'a task wake keys by its task only');
  assert.deepEqual(wakes.list('ag_b')[0].origin, NEWS);
});
