// B-057 S13 – work whose chat is gone: deleting the chat a group was split in stops its running and waiting parts (no
// parent wake); a settled group there – its results can reach nobody any more – ends 'stopped' with its fan-in wake
// withdrawn and its split sessions released; so does a settled group of an agent that is archived. Groups of other
// chats go on. Real split service, run journal and wake queue; FakeLanes. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../../src/runtime/agents/sessions.ts';
import { splitThread } from '../../../src/shared/model/splits.ts';
import { CHAT_REMOVED } from '../../../src/runtime/splits/service.ts';
import { CHAT, part, splitAndEnd, world, type World } from './fixture.ts';

const bind = (w: World, splitId: string) => new SessionStore(w.db).save({
  agentId: 'ag_ava', conversationId: splitThread(splitId), engine: 'codex', accountId: 'acc_1', ref: `thr_${splitId}`, generation: 1, cursorSeq: 0, updatedAt: w.clock.now(),
});
const bound = (w: World, splitId: string) => w.db.all('SELECT 1 FROM engine_sessions WHERE conversation_id = ?', [splitThread(splitId)]).length;
const openWakes = (w: World) => w.wakes.list('ag_ava').filter((wake) => wake.reason === 'child');

test('deleting the chat stops the parts split there: running ones aborted, waiting ones stopped, nobody woken', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A'), part('B', { after: [1] })]);
  const [a] = w.lanes.started;
  w.bus.emit('conversation.removed', { id: CHAT });
  assert.deepEqual(w.lanes.stopped, [{ splitId: a, why: 'human' }]);
  const group = w.splits.list({ groupId })[0];
  assert.equal(group.status, 'stopped');
  assert.deepEqual(group.splits.map((split) => [split.status, split.error]), [['stopped', CHAT_REMOVED], ['stopped', CHAT_REMOVED]]);
  w.lanes.end(a, 'stopped');
  assert.equal(openWakes(w).length, 0);
});

test('a settled group of a deleted chat, or of an archived agent, ends: its wake withdrawn, its sessions released', () => {
  const w = world();
  const groupId = splitAndEnd(w, [part('A')]);
  const [a] = w.lanes.started;
  bind(w, a);
  w.lanes.end(a, 'done', { answer: 'A is done' });
  assert.equal(w.splits.list({ groupId })[0].status, 'settled');
  assert.equal(openWakes(w).length, 1, 'the fan-in wake waits');
  w.bus.emit('conversation.removed', { id: 'ch_other' });
  assert.equal(w.splits.list({ groupId })[0].status, 'settled', 'another chat\'s deletion changes nothing');
  w.bus.emit('conversation.removed', { id: CHAT });
  assert.equal(w.splits.list({ groupId })[0].status, 'stopped');
  assert.equal(openWakes(w).length, 0, 'its wake is withdrawn');
  assert.equal(bound(w, a), 0, 'its session is released');

  const v = world();
  const other = splitAndEnd(v, [part('B')]);
  const [b] = v.lanes.started;
  v.lanes.end(b, 'done', { answer: 'B is done' });
  const ava = v.org.require('ag_ava');
  ava.archivedAt = v.clock.now();
  v.bus.emit('agent.upserted', ava);
  assert.equal(v.splits.list({ groupId: other })[0].status, 'stopped', 'an archived agent gathers nothing');
});
