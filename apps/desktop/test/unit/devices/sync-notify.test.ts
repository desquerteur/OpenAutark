// A notification between the CEO's PCs (devices/sync/notify.ts, notify/service.ts relayed): one that pushes on PC A goes
// to the online CEO PC B, never to an employee's PC or an offline one; B gives it only to its channels (its phones) – no
// desktop notification, no relay again – and takes none from a PC that is no CEO link; B-078: a PC that sent a roster
// gets no hand-over (its phones are pushed from here); a PC without the method (an
// older version) is passed over quietly; the id is the same on both PCs.
// Owns: these assertions only. Never: a real mesh, push service or OS notification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { RELAY_METHOD, ROSTER_PEERS, phonesHere, receiveNotification, relayNotification } from '../../../src/runtime/devices/sync/notify.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { Notifications, type Pushed } from '../../../src/runtime/notify/service.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

type Pc = ReturnType<typeof makePc>;

class Net { readonly pcs = new Map<string, Pc>(); }

/** One PC: its Notifications with a recording channel and desktop, on a fake mesh that passes JSON. */
function makePc(net: Net, id: string, options: { offline?: boolean; old?: boolean } = {}) {
  const db = memoryDb();
  const time = clock();
  const { bus } = recordingBus();
  const settings = new SettingsStore({ db, bus, clock: time, env: { locale: 'en-US', timezone: 'Europe/Berlin' } });
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const desktop: string[] = [];
  const phones: Pushed[] = [];
  const debug: unknown[] = [];
  const log = { debug: (...args: unknown[]) => debug.push(args), info() {}, warn() {}, error() {} };
  const calls: Array<{ to: string; method: string }> = [];
  const s = {
    db, log, clock: time,
    devices: {
      online: (peer: string) => net.pcs.has(peer) && !net.pcs.get(peer)!.offline,
      call: async (peer: string, method: string, params: unknown) => {
        calls.push({ to: peer, method });
        const target = net.pcs.get(peer)!;
        if (target.old) throw new WorkforceError('not_found', `Unknown method ${method}.`);
        return receiveNotification(target.s, target.notifications, JSON.parse(JSON.stringify(params)), id);
      },
    },
  } as unknown as RuntimeServices;
  const notifications = new Notifications({
    bus, settings, clock: time, log,
    host: { notify: async (input) => { desktop.push(input.title); return false; } },
    relay: (pushed) => relayNotification(s, pushed),
  });
  notifications.addChannel((input) => { phones.push(input); });
  const pc = { id, s, repo, notifications, desktop, phones, debug, calls, offline: options.offline, old: options.old };
  net.pcs.set(id, pc);
  return pc;
}

function link(a: Pc, b: Pc, person?: string): void {
  a.repo.upsert(record(b.id, person ? { personId: person } : {}));
  b.repo.upsert(record(a.id, { joinedAs: person ? 'employee' : 'ceo' }));
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('a notification that pushes on A reaches the phones of the CEO PC B once – not an employee\'s PC, not B\'s desktop, never back', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const e = makePc(net, 'dev_e');
  link(a, b);
  link(a, e, 'per_lena000001');

  a.notifications.notify({ kind: 'todo', title: 'Approve the invoice', body: '€120', conversationId: 'ch_1', taskId: 'task_9' });
  a.notifications.notify({ kind: 'done', title: 'only on the bus', body: '' }); // does not push: not relayed either
  await settle();

  assert.deepEqual(a.desktop, ['Approve the invoice']);
  assert.equal(a.phones.length, 1);
  assert.deepEqual(a.calls, [{ to: 'dev_b', method: RELAY_METHOD }], 'one call, to the CEO PC only');
  assert.deepEqual(b.desktop, [], 'no second desktop notification or sound');
  assert.equal(b.phones.length, 1);
  const [mine, theirs] = [a.phones[0], b.phones[0]];
  assert.equal(theirs.id, mine.id, 'the same id on both PCs: a phone shows it once');
  assert.deepEqual({ ...theirs }, { ...mine });
  assert.deepEqual(b.calls, [], 'B does not relay it again');
  assert.deepEqual(e.phones, []);
});

test('B-078: a PC that sent a roster gets no hand-over – its phones are held here and pushed from here (held-push.ts)', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  link(a, b);
  new KvRepo(a.s.db).set(ROSTER_PEERS, 'dev_b', true, 1);
  relayNotification(a.s, { id: 'n2', kind: 'todo', title: 'T', body: '', silent: false });
  await settle();
  assert.deepEqual(a.calls, [], 'B is on the roster: no relay');
  new KvRepo(a.s.db).delete(ROSTER_PEERS, 'dev_b');
  relayNotification(a.s, { id: 'n3', kind: 'todo', title: 'T', body: '', silent: false });
  await settle();
  assert.equal(b.phones.length, 1, 'a PC on 0.3.x (no roster) still gets the hand-over');
  a.s.db.run(`INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES ('ps_own', NULL, 'https://fcm.googleapis.com/fcm/send/1', '{}', 1)`);
  relayNotification(a.s, { id: 'n4', kind: 'todo', title: 'T', body: '', silent: false });
  await settle();
  assert.equal(b.phones.length, 1, 'my own phone hears it from here: no hand-over, so a phone paired with both does not ring twice');
  assert.equal(phonesHere({ db: memoryDb(), clock: clock() } as unknown as Parameters<typeof phonesHere>[0]), 0, 'no phone of another PC held here');
});

test('an offline CEO PC is skipped and one without the method is passed over quietly', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const off = makePc(net, 'dev_off', { offline: true });
  const old = makePc(net, 'dev_old', { old: true });
  link(a, off);
  link(a, old);

  a.notifications.notify({ kind: 'blocker', title: 'Stuck', body: 'needs a key' });
  await settle();

  assert.deepEqual(a.calls, [{ to: 'dev_old', method: RELAY_METHOD }], 'the offline PC gets no call (late is noise)');
  assert.equal(a.phones.length, 1, 'this PC\'s own phones still get it');
  assert.equal(a.debug.length, 1, 'the failed call is noted at debug only');
  assert.deepEqual(off.phones, []);
  assert.deepEqual(old.phones, []);
});

test('the receiver takes a notification only from a CEO link, and skips it without channels or with a wrong shape', async () => {
  const net = new Net();
  const b = makePc(net, 'dev_b');
  b.repo.upsert(record('dev_boss', { joinedAs: 'employee' })); // this PC joined dev_boss as an employee
  b.repo.upsert(record('dev_emp', { personId: 'per_lena000001' }));
  b.repo.upsert(record('dev_ceo'));
  const pushed = { id: 'n1', kind: 'important', title: 'Hello', body: 'x', silent: true, tag: 'ch_1', conversationId: 'ch_1' };

  for (const from of ['dev_boss', 'dev_emp', 'dev_unknown']) {
    await assert.rejects(receiveNotification(b.s, b.notifications, pushed, from), (error: WorkforceError) => error.code === 'forbidden');
  }
  assert.equal(b.phones.length, 0);

  await receiveNotification(b.s, b.notifications, { ...pushed, kind: 'info' }, 'dev_ceo');
  await receiveNotification(b.s, b.notifications, { ...pushed, id: 7 }, 'dev_ceo');
  assert.equal(b.phones.length, 0, 'info never pushes; an id is needed');

  assert.deepEqual(await receiveNotification(b.s, b.notifications, pushed, 'dev_ceo'), { ok: true });
  assert.deepEqual(b.phones.map((input) => [input.id, input.title, input.silent, input.tag, input.conversationId]), [['n1', 'Hello', true, 'ch_1', 'ch_1']]);
  assert.deepEqual(b.desktop, []);

  const bare = new Notifications({ bus: recordingBus().bus, settings: { get: () => { throw new Error('not read'); } }, clock: clock(), log: b.s.log, host: { notify: async () => { throw new Error('no desktop'); } } });
  bare.relayed(pushed); // no channels: nothing to do
});
