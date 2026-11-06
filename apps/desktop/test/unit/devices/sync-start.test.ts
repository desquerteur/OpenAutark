// The runtime's start (runtime/main.ts): the sync's listeners come before the reconciliation, so what it changes – an
// answer a crash cut, stopped; a background run's silent live row, removed – gets its stamp and reaches a linked PC
// with the next link-up, which follows the mesh. The order is checked in main.ts's source (building the runtime
// needs every service); what that order gives runs on the fake mesh (sync-net.ts).
// Owns: these assertions only. Never: network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agent } from '../chat/harness.ts';
import type { Message } from '../../../src/shared/model/chat.ts';
import { ConversationRepo } from '../../../src/runtime/chat/conversation-repo.ts';
import { MessageRepo } from '../../../src/runtime/chat/message-repo.ts';
import { link, makePc, Net, settle, type Pc } from './sync-net.ts';

const MAIN = readFileSync(new URL('../../../src/runtime/main.ts', import.meta.url), 'utf8');

/** A run's row in state 'streaming', written as the chat service writes it (its run is this PC's: no run id). */
function streaming(pc: Pc, conversationId: string, id: string, silent: boolean): Message {
  const message: Message = {
    id, conversationId, seq: 0, authorId: 'ag_mara', authorKind: 'agent', kind: 'text', body: '', attachments: [], mentions: [],
    priority: 'normal', state: 'streaming', silent, meta: {}, createdAt: pc.h.clock.now(),
  };
  pc.h.db.tx(() => {
    message.seq = new ConversationRepo(pc.h.db).nextSeq(conversationId, message.createdAt);
    new MessageRepo(pc.h.db).insert(message);
  });
  pc.h.bus.emit('message.created', message);
  return message;
}

test('main.ts starts the sync before the reconciliation, the link-ups after it', () => {
  const sync = MAIN.indexOf('startSync({');
  const reconcile = MAIN.indexOf('s.chats.reconcileStreaming()');
  const mesh = MAIN.indexOf('core.mesh.start()');
  assert.ok(sync > 0 && reconcile > sync, 'the sync listens first');
  assert.ok(mesh > reconcile, 'the link-ups follow');
});

test('what the start\'s reconciliation stops or removes reaches a linked PC with the next link-up', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  for (const pc of [a, b]) pc.h.org.add(agent('ag_mara', 'Mara', { deviceId: 'dev_a' }));
  const chat = a.h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  streaming(a, chat.id, 'msg_cut', false);
  streaming(a, chat.id, 'msg_quiet', true);
  await settle();
  assert.deepEqual([b.h.chats.message('msg_cut')?.state, b.h.chats.message('msg_quiet')?.state], ['streaming', 'streaming'], 'both travelled while they ran');

  net.up = false; // the app on A ended mid-run and starts again: no link is up yet
  const cursor = a.h.clock.now();
  a.h.clock.advance(1000);
  assert.equal(a.h.chats.reconcileStreaming(), 2);
  net.up = true;
  assert.equal(await a.sync.catchUp('dev_b', cursor), true);
  assert.equal(b.h.chats.message('msg_cut')?.state, 'stopped', 'the cut answer is stopped there too');
  assert.equal(b.h.chats.message('msg_quiet'), undefined, 'the silent live row is gone there too');
});
