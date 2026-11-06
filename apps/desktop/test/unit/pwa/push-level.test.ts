// B-050 K4 – web push levels (pwa/push.ts, pwa/service.ts pushNotify): an important message, a to-do and a
// blocker go with Urgency high, a reply normal; the owner's Sound off (the channel's `silent`) reaches the
// phone as a silent notification – it was dropped before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { decryptPayload } from '../../../src/runtime/pwa/webpush-crypto.ts';
import { VapidKeys } from '../../../src/runtime/pwa/vapid.ts';
import { PushService, type PushMessage } from '../../../src/runtime/pwa/push.ts';
import { PwaService } from '../../../src/runtime/pwa/service.ts';
import { ManualClock, fakeHost, memoryDb, silentLog } from '../devices/fakes.ts';

function rig() {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.alloc(16, 5);
  const sent: Array<{ headers: Record<string, string>; payload: Record<string, unknown> }> = [];
  const push = new PushService({
    db, clock, log: silentLog, vapid: () => VapidKeys.load({ db, host, clock }),
    fetch: async (_url, init) => {
      sent.push({ headers: init!.headers!, payload: JSON.parse(decryptPayload(Buffer.from(init!.body as Uint8Array), ua.getPrivateKey(), auth).toString()) });
      return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
    },
  });
  push.subscribe({ endpoint: 'https://push.example/owner', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }); // the owner's own
  return { push, sent };
}

test('Urgency high for important, to-do and blocker; normal for a reply', async () => {
  const { push, sent } = rig();
  for (const kind of ['important', 'todo', 'blocker', 'reply'] as PushMessage['kind'][]) await push.send({ kind, title: 'T', body: 'B' });
  assert.deepEqual(sent.map((item) => item.headers.Urgency), ['high', 'high', 'high', 'normal']);
});

test('silent reaches the payload; without it the push sounds', async () => {
  const { push, sent } = rig();
  await push.send({ kind: 'important', title: 'T', body: 'B' }, { silent: true });
  await push.send({ kind: 'important', title: 'T', body: 'B' });
  assert.deepEqual(sent.map((item) => item.payload.silent), [true, undefined]);
});

test('pushNotify passes the channel\'s silent through (Sound off); an old pwa.enabled false holds nothing back (B-078)', async () => {
  const calls: Array<{ message: PushMessage; options?: { silent?: boolean } }> = [];
  let enabled = true;
  const service = Object.create(PwaService.prototype) as PwaService;
  Object.assign(service, {
    deps: {
      settings: { get: () => ({ pwa: { enabled } }) },
      push: { send: async (message: PushMessage, options?: { silent?: boolean }) => { calls.push({ message, options }); return 1; } },
    },
  });
  await service.pushNotify({ kind: 'reply', title: 'Tom', body: 'Done', silent: true });
  await service.pushNotify({ kind: 'reply', title: 'Tom', body: 'Done' });
  assert.deepEqual(calls.map((call) => call.options), [{ silent: true }, { silent: false }]);
  enabled = false;
  assert.equal(await service.pushNotify({ kind: 'important', title: 'Tom', body: 'Down', silent: false }), 1);
  assert.equal(calls.length, 3);
});
