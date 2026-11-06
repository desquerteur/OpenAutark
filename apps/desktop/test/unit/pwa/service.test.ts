// PwaService access rules: a phone/browser device token works exactly while its accepted device row and token
// exist (B-078 D5, no switch), a pairing link is one-time; push config and subscriptions are
// bound to the calling device (DEV5A). The PC is served by `tailscale serve` here (SERVED, a fake status): B-075 refuses a
// link a phone cannot reach (pwa/phone-reach.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SettingsService } from '../../../src/runtime/contracts.ts';
import { createECDH } from 'node:crypto';
import { PushService } from '../../../src/runtime/pwa/push.ts';
import { PwaService } from '../../../src/runtime/pwa/service.ts';
import { closeAccessTurnedOff } from '../../../src/runtime/pwa/access-off.ts';
import { VapidKeys } from '../../../src/runtime/pwa/vapid.ts';
import type { PwaState } from '../../../src/shared/model/devices.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

/** `tailscale serve status --json` of a PC whose https address forwards to the app's port. */
const SERVED = async () => JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { 'pc.tail1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47811' } } } } });

function setup() {
  const settings = { pwa: { enabled: true, bind: 'localhost' as 'localhost' | 'lan' | 'tailscale' } };
  const push = new PushService({ db: memoryDb(), clock: new ManualClock(), log: silentLog, vapid: async () => { throw new Error('not in these tests'); } });
  const { bus } = recordingBus();
  const db = memoryDb();
  const clock = new ManualClock();
  const pwa = new PwaService({
    db, clock, bus, log: silentLog, push, port: () => 47811, qr: async () => 'data:image/png;base64,',
    settings: {
      get: () => settings,
      update: (patch: { pwa?: Partial<typeof settings.pwa> }) => { Object.assign(settings.pwa, patch.pwa ?? {}); return settings; },
    } as unknown as SettingsService,
    interfaces: () => ({}), serveStatus: SERVED,
  });
  return { pwa, settings, db, clock };
}

const secretOf = (url: string) => /#pair=([^&]+)/.exec(url)?.[1] ?? '';

test('B-078: no switch gates a paired device – its token works while its row and token exist, Remove ends it', async () => {
  const { pwa, settings } = setup();
  const { token, deviceId } = pwa.exchange(secretOf((await pwa.link({ name: 'Phone' })).url), { kind: 'phone' });
  assert.deepEqual(pwa.authenticate(token), { kind: 'device', deviceId, capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'] }, 'one tier: a paired phone is the owner (permissions count on a secure transport)');
  settings.pwa.enabled = false;
  assert.equal(pwa.authenticate(token)?.kind, 'device', 'the old switch value changes nothing');
  assert.equal((await pwa.state()).enabled, true, 'and the state never says "off"');
  await pwa.revoke(deviceId);
  assert.equal(pwa.authenticate(token), undefined);
  assert.equal(pwa.revoked(token), true);
});

test('phone access switched off in 0.3.x: its earlier devices and the tokens of colleagues end once; a token from before keeps no permissions', async () => {
  const { pwa, settings, db, clock } = setup();
  const before = pwa.exchange(secretOf((await pwa.link({ name: 'Old browser' })).url), { kind: 'browser' });
  db.run(`UPDATE tokens SET scope = '["todo","chat","tasks","settings","manage"]' WHERE device_id = ?`, [before.deviceId]); // as 0.3.x issued it
  assert.deepEqual(pwa.authenticate(before.token), { kind: 'device', deviceId: before.deviceId, capabilities: ['todo', 'chat', 'tasks', 'settings', 'manage'] }, 'no permissions it never had');
  const fresh = pwa.pairPhone({ id: 'dev_phonepair02', name: 'Pixel', publicKey: Buffer.alloc(32, 7).toString('base64url') });
  db.run(`INSERT INTO tokens (id, device_id, kind, hash, scope, name, created_at) VALUES ('tok_p1', 'pdev_1', 'person', 'h1', '{"personId":"per_x"}', NULL, 0)`);
  settings.pwa = { enabled: false, bind: 'lan' };
  assert.deepEqual(await closeAccessTurnedOff({ db, clock, log: silentLog, settings: { get: () => settings, update: (patch: { pwa?: typeof settings.pwa }) => { Object.assign(settings.pwa, patch.pwa); return settings; } } as never }, pwa), { devices: 1, people: 1 });
  assert.equal(pwa.authenticate(before.token), undefined, 'the switched-off browser stays out');
  assert.equal(pwa.authenticate(fresh.token)?.kind, 'device', 'a phone paired in this build stays');
  assert.ok(db.get(`SELECT 1 AS hit FROM tokens WHERE id = 'tok_p1' AND revoked_at IS NOT NULL`), 'the colleague joins again');
  assert.deepEqual(settings.pwa, { enabled: true, bind: 'localhost' });
  assert.equal(await closeAccessTurnedOff({ db, clock, log: silentLog, settings: { get: () => settings, update: () => settings } as never }, pwa), undefined, 'once');
});

test('a pairing link is one-time, with or without the old switch', async () => {
  const { pwa, settings } = setup();
  settings.pwa.enabled = false;
  const secret = secretOf((await pwa.link()).url);
  assert.ok(pwa.exchange(secret).token);
  assert.throws(() => pwa.exchange(secret), (error: { code?: string }) => error.code === 'forbidden'); // one-time
});

test('pairPhone stores the phone with its key and issues a full-access token; another key cannot take its id', () => {
  const { pwa } = setup();
  const pub = Buffer.alloc(32, 9).toString('base64url');
  const issued = pwa.pairPhone({ id: 'dev_phonepair01', name: 'Pixel 8', publicKey: pub });
  assert.equal(issued.deviceId, 'dev_phonepair01');
  assert.equal(pwa.authenticate(issued.token)?.kind, 'device');
  assert.throws(() => pwa.pairPhone({ id: 'dev_phonepair01', name: 'Other', publicKey: Buffer.alloc(32, 8).toString('base64url') }), (error: { code?: string }) => error.code === 'conflict');
  assert.throws(() => pwa.pairPhone({ id: 'dev_phonepair02', name: 'Bad', publicKey: 'AAAA' }), (error: { code?: string }) => error.code === 'bad_request');
});

test('pushConfig (DEV5A): the VAPID key for any paired device, "subscribed" only for its own stored subscription', async () => {
  const db = memoryDb();
  const clock = new ManualClock();
  const host = fakeHost();
  const settings = { pwa: { enabled: true, bind: 'localhost' as const } };
  const push = new PushService({ db, clock, log: silentLog, vapid: () => VapidKeys.load({ db, host, clock }) });
  const { bus, events } = recordingBus();
  const pwa = new PwaService({
    db, clock, bus, log: silentLog, push, port: () => 47811, qr: async () => 'data:image/png;base64,', interfaces: () => ({}), serveStatus: SERVED,
    settings: { get: () => settings, update: () => settings } as unknown as SettingsService,
  });
  const phone = pwa.exchange(secretOf((await pwa.link({ name: 'Pixel' })).url), { kind: 'phone' });
  const other = pwa.exchange(secretOf((await pwa.link({ name: 'Tablet' })).url), { kind: 'browser' });
  const scope = pwa.authenticate(phone.token);
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const subscription = { endpoint: 'https://push.example/pixel', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };

  const before = await pwa.pushConfig(scope, subscription.endpoint);
  assert.equal(before.pushReady, true);
  assert.equal(before.vapidPublicKey, (await VapidKeys.load({ db, host, clock })).publicKey);
  assert.equal(before.subscribed, false);
  pwa.pushSubscribe(subscription, scope);
  assert.equal((await pwa.pushConfig(scope, subscription.endpoint)).subscribed, true);
  assert.equal((await pwa.pushConfig(scope)).subscribed, true, 'any own subscription without an endpoint');
  assert.equal((await pwa.pushConfig(pwa.authenticate(other.token), subscription.endpoint)).subscribed, false, 'not another device\'s');

  const state = await pwa.state();
  assert.equal(state.vapidPublicKey, before.vapidPublicKey);
  assert.deepEqual(state.devices.map((device) => [device.name, device.notifications]).sort(), [['Pixel', true], ['Tablet', false]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some(({ event, data }) => event === 'pwa.updated' && (data as PwaState).devices.some((device) => device.notifications)), 'the owner sees it live');

  assert.equal(pwa.pushUnsubscribe(pwa.authenticate(other.token)), 0, 'another device removes nothing of this phone');
  assert.equal(pwa.pushUnsubscribe(scope, subscription.endpoint), 1);
  assert.equal((await pwa.pushConfig(scope)).subscribed, false);

  settings.pwa.enabled = false;
  assert.equal((await pwa.pushConfig(undefined)).pushReady, true, 'B-078: the old switch does not stop push');
});
