// The employees' push rule (pwa/person-push.ts): a new final message in a chat a person is a member of reaches that
// person's devices once – not the author's own line, not a quiet one, not a person outside the chat (no phone switch
// since B-078); a person's device subscribes under its own device id (pwa/service.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../../../src/runtime/bus.ts';
import { pushPeopleMessages } from '../../../src/runtime/pwa/person-push.ts';
import { PwaService } from '../../../src/runtime/pwa/service.ts';
import type { ClientScope } from '../../../src/shared/api/protocol.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

const ADA = 'per_ada0000001';
const BEN = 'per_ben0000001';

function rig(enabled = true) {
  const bus = new Bus();
  const sent: Array<{ personId: string; kind: string; title: string; body: string }> = [];
  const members = [
    { conversationId: 'ch_1', memberId: 'human', kind: 'human', role: 'owner', readSeq: 0, joinedAt: 0 },
    { conversationId: 'ch_1', memberId: ADA, kind: 'human', role: 'member', readSeq: 0, joinedAt: 0 },
    { conversationId: 'ch_1', memberId: BEN, kind: 'human', role: 'member', readSeq: 0, joinedAt: 0, leftAt: 5 },
    { conversationId: 'ch_1', memberId: 'ag_x', kind: 'agent', role: 'lead', readSeq: 0, joinedAt: 0 },
  ];
  const s = {
    bus,
    chats: { members: () => members, get: () => ({ title: 'Launch' }) },
    settings: { get: () => ({ pwa: { enabled } }) },
    log: { warn: () => undefined },
  };
  const stop = pushPeopleMessages(s as never, { sendToPerson: async (personId, message) => { sent.push({ personId, kind: message.kind, title: message.title, body: message.body }); return 1; } });
  const message = (patch: Partial<Message>): Message => ({
    id: 'msg_1', conversationId: 'ch_1', seq: 1, authorId: 'ag_x', authorKind: 'agent', kind: 'text', body: 'Draft is ready',
    attachments: [], mentions: [], priority: 'normal', silent: false, state: 'final', createdAt: 0, ...patch,
  } as Message);
  return { bus, sent, stop, message };
}

test('a final message reaches the people of the chat once; streaming, quiet and own lines do not', () => {
  const r = rig();
  r.bus.emit('message.created', r.message({ state: 'streaming' }));
  assert.equal(r.sent.length, 0, 'an answer that still streams');
  r.bus.emit('message.updated', r.message({}));
  r.bus.emit('message.updated', r.message({ body: 'Draft is ready (edited)' }));
  assert.deepEqual(r.sent, [{ personId: ADA, kind: 'reply', title: 'Launch', body: 'Draft is ready' }], 'Ada once; Ben left the chat');
  r.bus.emit('message.created', r.message({ id: 'msg_2', silent: true }));
  r.bus.emit('message.created', r.message({ id: 'msg_3', kind: 'status' }));
  r.bus.emit('message.created', r.message({ id: 'msg_4', authorId: ADA, authorKind: 'human' }));
  assert.equal(r.sent.length, 1, 'quiet lines and the person\'s own line are not pushed');
  r.bus.emit('message.created', r.message({ id: 'msg_5', priority: 'important' }));
  assert.equal(r.sent[1].kind, 'important');
  r.stop();
  r.bus.emit('message.created', r.message({ id: 'msg_6' }));
  assert.equal(r.sent.length, 2, 'stopped');
});

test('a person\'s device subscribes under its own device id, only at a browser push service, a few per device', () => {
  const calls: Array<{ how: string; deviceId?: string; keep?: number }> = [];
  const service = Object.create(PwaService.prototype) as PwaService;
  Object.assign(service, {
    deps: {
      push: {
        subscribe: (_sub: unknown, deviceId?: string) => { calls.push({ how: 'plain', deviceId }); },
        subscribeKeeping: (_sub: unknown, deviceId: string, keep: number) => { calls.push({ how: 'keeping', deviceId, keep }); },
      },
    },
    emit: async () => undefined,
  });
  const keys = { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 5).toString('base64url') };
  const person: ClientScope = { kind: 'person', personId: ADA, deviceId: 'dev_ada', tokenId: 'tok', secure: true };
  service.pushSubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, person);
  assert.throws(() => service.pushSubscribe({ endpoint: 'https://192.168.1.5/push', keys }, person), /push service/);
  service.pushSubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/def', keys }, { kind: 'owner' });
  assert.deepEqual(calls, [{ how: 'keeping', deviceId: 'dev_ada', keep: 3 }, { how: 'plain', deviceId: undefined }], 'never stored as the owner\'s');
});

test('B-078 (D5): an old pwa.enabled false in settings no longer holds a push back', () => {
  const r = rig(false);
  r.bus.emit('message.created', r.message({}));
  assert.equal(r.sent.length, 1);
});
