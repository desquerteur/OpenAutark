// B-078 read anywhere, closed everywhere (pwa/read-clear.ts, devices/sync/held-push.ts): a chat whose notice this PC
// pushed gets one silent push {clear: 'chat:<id>'} once the owner's cursor reaches its end – to this PC's own owner
// subscriptions under its own VAPID key and to the held ones of my other PCs under theirs; nothing for a to-do's
// notice, a chat this PC never pushed, a chat still unread, or a person's device. Real encryption, a fake push service.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { agent, harness } from '../chat/harness.ts';
import type { NotificationChannel } from '../../../src/runtime/contracts.ts';
import { keepKeys, keepSubs, type HeldSub } from '../../../src/runtime/devices/sync/held-push.ts';
import { isApplePush, startReadClear } from '../../../src/runtime/pwa/read-clear.ts';
import { decryptPayload } from '../../../src/runtime/pwa/webpush-crypto.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';

const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64url');
const host = { encrypt: async (plain: string) => new TextEncoder().encode(plain), decrypt: async (cipher: Uint8Array) => new TextDecoder().decode(cipher) };

function vapid() { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); return { pub: b64(ecdh.getPublicKey()), priv: b64(ecdh.getPrivateKey()) }; }
function browser(n: number, endpoint = `https://fcm.googleapis.com/fcm/send/${n}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { endpoint, data: { endpoint, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } }, priv: ecdh.getPrivateKey(), auth };
}

function rig() {
  const h = harness();
  (h.services as unknown as { host: object }).host = { ...(h.services.host as object), ...host };
  h.org.add(agent('ag_mara', 'Mara'));
  const own = vapid();
  new KvRepo(h.db).set('pwa', 'vapid', { publicKey: own.pub, privateCipher: Buffer.from(own.priv).toString('base64') }, 1);
  const phone = browser(1);
  h.db.run('INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES (?, NULL, ?, ?, 1)', ['ps_1', phone.endpoint, JSON.stringify(phone.data)]);
  const channels: NotificationChannel[] = [];
  const pushes: Array<{ endpoint: string; key: string; payload: unknown }> = [];
  const phones = new Map([[phone.endpoint, phone]]);
  const fetch = async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
    const target = phones.get(url)!;
    pushes.push({ endpoint: url, key: /k=(\S+)$/.exec(init.headers.Authorization)![1], payload: JSON.parse(decryptPayload(init.body, target.priv, target.auth).toString()) });
    return { ok: true, status: 201 };
  };
  const notifications = { notify: () => undefined, addChannel: (channel: NotificationChannel) => { channels.push(channel); return () => undefined; } };
  const off = startReadClear({ ...h.services, notifications } as never, { fetch });
  const chat = h.chats.create({ agentIds: ['ag_mara'], createdBy: 'human' });
  const pushed = (extra: { taskId?: string } = {}) => { for (const channel of channels) void channel({ id: 'n1', kind: 'reply', title: 'Mara', body: 'Hi', conversationId: chat.id, silent: false, ...extra }); };
  return { h, own, phones, pushes, chat, pushed, off };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a notice this PC pushed closes on every phone once the owner read the chat to its end – here or on another of my PCs', async () => {
  const { h, own, phones, pushes, chat, pushed } = rig();
  const other = vapid();
  const held = browser(2);
  phones.set(held.endpoint, held);
  await keepKeys({ ...h.services, host } as never, [other], own.pub);
  keepSubs(h.db, [{ endpoint: held.endpoint, data: held.data, key: other.pub } satisfies HeldSub, { endpoint: 'https://fcm.googleapis.com/fcm/send/9', data: held.data, key: other.pub, person: 'per_lena000001' }], 1);

  const one = h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'One' });
  pushed();
  const two = h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Two' });
  h.chats.markRead(chat.id, 'human', one.seq);
  await flush();
  assert.equal(pushes.length, 0, 'still unread: the notice stays');

  h.chats.markRead(chat.id, 'human', two.seq);
  await flush();
  // A 0.3.x service worker shows every push: the clear carries the pushed notice itself (same tag and id: it shows nothing).
  const older = { clear: `chat:${chat.id}`, tag: `chat:${chat.id}`, url: `/#/chat/${encodeURIComponent(chat.id)}`, title: 'Mara', body: 'Hi', silent: true, id: 'n1' };
  assert.deepEqual(pushes.map((push) => [push.endpoint.slice(-1), push.key === (push.endpoint.endsWith('1') ? own.pub : other.pub), push.payload]).sort(), [
    ['1', true, older], ['2', true, older],
  ], 'my own phone under my key, the other PC\'s under its key; never a person\'s');

  h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Three' });
  h.chats.markRead(chat.id, 'human', h.chats.messages(chat.id).at(-1)!.seq);
  await flush();
  assert.equal(pushes.length, 2, 'once per pushed notice');
});

test('a to-do\'s notice, or a chat this PC never pushed, clears nothing', async () => {
  const { h, pushes, chat, pushed, off } = rig();
  const line = h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Todo' });
  pushed({ taskId: 'task_1' });
  h.chats.markRead(chat.id, 'human', line.seq);
  await flush();
  assert.equal(pushes.length, 0);
  off();
});

test('an iPhone web app (Apple\'s push service) gets no clear: iOS revokes a subscription that receives pushes without a notice', async () => {
  const { h, phones, pushes, chat, pushed, off } = rig();
  const iphone = browser(3, 'https://web.push.apple.com/QGk3Zx');
  phones.set(iphone.endpoint, iphone);
  h.db.run('INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES (?, NULL, ?, ?, 1)', ['ps_3', iphone.endpoint, JSON.stringify(iphone.data)]);
  const line = h.chats.send({ conversationId: chat.id, authorId: 'ag_mara', authorKind: 'agent', body: 'Hi' });
  pushed();
  h.chats.markRead(chat.id, 'human', line.seq);
  await flush();
  assert.deepEqual(pushes.map((push) => push.endpoint), ['https://fcm.googleapis.com/fcm/send/1'], 'only the Android/Chrome phone gets the clear');
  assert.equal(isApplePush('https://web.push.apple.com/x'), true);
  assert.equal(isApplePush('https://api.push.apple.com/x'), true);
  assert.equal(isApplePush('https://push.apple.com.evil.example/x'), false);
  assert.equal(isApplePush('not a url'), false);
  off();
});
