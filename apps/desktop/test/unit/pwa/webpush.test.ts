import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { decryptPayload, encryptPayload } from '../../../src/runtime/pwa/webpush-crypto.ts';
import { VapidKeys } from '../../../src/runtime/pwa/vapid.ts';
import { PushService, pushTarget } from '../../../src/runtime/pwa/push.ts';
import type { PushMessage } from '../../../src/runtime/pwa/push.ts';
import { TokenService } from '../../../src/runtime/pwa/tokens.ts';
import type { DeviceCapability } from '../../../src/runtime/pwa/tokens.ts';
import type { Db } from '../../../src/runtime/db/database.ts';
import { ManualClock, fakeHost, memoryDb, silentLog } from '../devices/fakes.ts';

const b = (value: string) => Buffer.from(value, 'base64url');

/** Pairs `deviceId` the way pwa.exchange does: an active device token. */
function pairDevice(db: Db, clock: ManualClock, deviceId: string): TokenService {
  const tokens = new TokenService(db, clock);
  assert.ok(tokens.exchange(tokens.createLink({}).secret, deviceId));
  return tokens;
}

test('RFC 8291 Appendix A test vector', () => {
  const body = encryptPayload(
    Buffer.from('When I grow up, I want to be a watermelon'),
    b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    b('BTBZMqHH6r4Tts7J_aSIgg'),
    { asPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: b('DGv6ra1nlYgDCS1FRnbzlw') },
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
  const plain = decryptPayload(body, b('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), b('BTBZMqHH6r4Tts7J_aSIgg'));
  assert.equal(plain.toString(), 'When I grow up, I want to be a watermelon');
});

test('VAPID JWT is ES256-signed with the stored key; keys persist encrypted', async () => {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const keys = await VapidKeys.load({ db, host, clock });
  const again = await VapidKeys.load({ db, host, clock });
  assert.equal(again.publicKey, keys.publicKey);
  const header = keys.authorization('https://fcm.googleapis.com/fcm/send/abc', clock.now());
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  const claims = JSON.parse(b(match[2]).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(match[4], keys.publicKey);
  const point = b(keys.publicKey);
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(match[3])));
});

test('push service encrypts per subscription and drops gone endpoints', async () => {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const sent: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = [];
  let status = 201;
  const push = new PushService({
    db, clock, log: silentLog, vapid: () => VapidKeys.load({ db, host, clock }),
    fetch: async (url, init) => { sent.push({ url, body: Buffer.from(init!.body as Uint8Array), headers: init!.headers! }); return { ok: status < 300, status, json: async () => ({}), text: async () => '' }; },
  });
  assert.throws(() => push.subscribe({ endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } }));
  pairDevice(db, clock, 'dev_x');
  push.subscribe({ endpoint: 'https://push.example/sub1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, 'dev_x');
  assert.equal(await push.send({ kind: 'todo', title: 'Record intro', body: '2 min' }), 1);
  assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
  const payload = JSON.parse(decryptPayload(sent[0].body, ua.getPrivateKey(), auth).toString());
  assert.equal(payload.title, 'Record intro');
  status = 410;
  await push.send({ kind: 'info', title: 'x', body: 'y' });
  assert.equal(push.count(), 0);
});

test('pushTarget: a tap opens the chat, My day (to-dos, blockers) or Home; the tag replaces an older notice for the same to-do or chat', () => {
  assert.deepEqual(pushTarget({ kind: 'todo', conversationId: 'ch_1', taskId: 'ta_9' }), { url: '/#/chat/ch_1', tag: 'todo:ta_9' });
  assert.deepEqual(pushTarget({ kind: 'reply', conversationId: 'ch_1' }), { url: '/#/chat/ch_1', tag: 'chat:ch_1' });
  assert.deepEqual(pushTarget({ kind: 'todo', taskId: 'ta_9' }), { url: '/#/day', tag: 'todo:ta_9' }); // B-041: My day
  assert.deepEqual(pushTarget({ kind: 'blocker' }), { url: '/#/day', tag: 'workforce:blocker' });
  assert.deepEqual(pushTarget({ kind: 'important' }), { url: '/#/home', tag: 'workforce:important' });
});

test('the encrypted payload carries url and tag; unsubscribe removes only the caller\'s rows', async () => {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const keysOf = () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    return { ua, auth: Buffer.alloc(16, 3) };
  };
  const phone = keysOf();
  const sent: Buffer[] = [];
  const push = new PushService({
    db, clock, log: silentLog, vapid: () => VapidKeys.load({ db, host, clock }),
    fetch: async (_url, init) => { sent.push(Buffer.from(init!.body as Uint8Array)); return { ok: true, status: 201, json: async () => ({}), text: async () => '' }; },
  });
  const sub = (endpoint: string, keys = phone) => ({ endpoint, keys: { p256dh: keys.ua.getPublicKey().toString('base64url'), auth: keys.auth.toString('base64url') } });
  pairDevice(db, clock, 'dev_phone');
  push.subscribe(sub('https://push.example/phone'), 'dev_phone');
  push.subscribe(sub('https://push.example/tablet', keysOf()), 'dev_tablet');
  push.subscribe(sub('https://push.example/owner', keysOf()));
  assert.deepEqual([...push.subscribedDevices()].sort(), ['dev_phone', 'dev_tablet']);
  assert.equal(await push.publicKey(), (await VapidKeys.load({ db, host, clock })).publicKey);

  push.unsubscribe('dev_tablet');
  push.unsubscribe(undefined, 'https://push.example/phone'); // the owner cannot remove a phone's row by its endpoint
  assert.equal(push.unsubscribe(undefined), 0, 'the owner without an endpoint removes nothing');
  assert.equal(push.isSubscribed('dev_phone', 'https://push.example/phone'), true);
  assert.equal(push.isSubscribed('dev_tablet'), false);
  assert.equal(push.isSubscribed('dev_phone', 'https://push.example/owner'), false, 'another caller\'s endpoint');
  assert.equal(push.isSubscribed(undefined, 'https://push.example/owner'), true);
  assert.equal(push.count(), 2);

  await push.send({ kind: 'todo', title: 'Approve the invoice', body: '€120', conversationId: 'ch_7', taskId: 'ta_3' });
  const payloads = sent.map((body) => { try { return JSON.parse(decryptPayload(body, phone.ua.getPrivateKey(), phone.auth).toString()); } catch { return undefined; } }).filter(Boolean);
  assert.equal(payloads.length, 1, 'readable only with the phone\'s keys');
  assert.equal(payloads[0].url, '/#/chat/ch_7');
  assert.equal(payloads[0].tag, 'todo:ta_3');
  assert.equal(push.unsubscribe('dev_phone', 'https://push.example/other'), 0, 'a phone names only its own endpoint');
  assert.equal(push.unsubscribe('dev_phone'), 1);
});

test('pushTarget: a recipient without chat access is led to My day, never into the chat', () => {
  assert.deepEqual(pushTarget({ kind: 'todo', conversationId: 'ch_1', taskId: 'ta_9' }, { chat: false }), { url: '/#/day', tag: 'todo:ta_9' });
  assert.deepEqual(pushTarget({ kind: 'todo', conversationId: 'ch_1', taskId: 'ta_9' }, { chat: true }), { url: '/#/chat/ch_1', tag: 'todo:ta_9' });
});

test('one tier: the owner and every paired phone get every notification; a subscription without an active token gets none', async () => {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const browsers = new Map<string, { ua: ReturnType<typeof createECDH>; auth: Buffer }>();
  const received: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const push = new PushService({
    db, clock, log: silentLog, vapid: () => VapidKeys.load({ db, host, clock }),
    fetch: async (url, init) => {
      const keys = browsers.get(url)!;
      received.push({ endpoint: url, payload: JSON.parse(decryptPayload(Buffer.from(init!.body as Uint8Array), keys.ua.getPrivateKey(), keys.auth).toString()) });
      return { ok: true, status: 201, json: async () => ({}), text: async () => '' };
    },
  });
  const subscribe = (endpoint: string, deviceId?: string) => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, browsers.size + 1);
    browsers.set(endpoint, { ua, auth });
    push.subscribe({ endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }, deviceId);
  };
  pairDevice(db, clock, 'dev_full');
  const tokens = pairDevice(db, clock, 'dev_todo');
  subscribe('https://push.example/owner');
  subscribe('https://push.example/full', 'dev_full');
  subscribe('https://push.example/todo', 'dev_todo');
  subscribe('https://push.example/stale', 'dev_unpaired'); // no active token: never reached

  const deliver = async (message: PushMessage) => {
    received.length = 0;
    const count = await push.send(message);
    assert.equal(count, received.length);
    return new Map(received.map((entry) => [entry.endpoint.replace('https://push.example/', ''), entry.payload]));
  };
  for (const kind of ['important', 'reply', 'todo'] as const) {
    const got = await deliver({ kind, title: 'Manager', body: 'The draft is ready', conversationId: 'ch_7' });
    assert.deepEqual([...got.keys()].sort(), ['full', 'owner', 'todo'], `${kind}: every paired phone`);
    assert.equal(got.get('todo')?.url, '/#/chat/ch_7', 'a tap opens the chat');
  }
  tokens.revokeDevice('dev_todo');
  assert.deepEqual([...(await deliver({ kind: 'info', title: 'x', body: 'y' })).keys()].sort(), ['full', 'owner'], 'a removed phone gets nothing');
});
