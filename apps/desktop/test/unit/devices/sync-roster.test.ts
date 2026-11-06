// B-078 roster between my own devices (devices/sync/roster.ts): my other PC learns every device this PC knows with the
// same relation – a PC through the mesh (my employer's PC as an employer, my employee's PC with its person), a phone as
// a client row with its token hash –; a removal wins over an older pairing and a newer pairing over a removal; the
// roster comes only from my own PCs; held push subscriptions follow the sender's own list; device.sibling stores a
// person's other PC with the same person (one notice) or another PC of my employer, and each of my PCs is introduced
// once over every employer/employee link. Removals follow introductions, an introduction never relabels a linked PC, a
// sibling goes with the PCs that introduced it, and a removed person's or an expired phone is nobody's push target.
// Owns: these assertions only. Never: a real mesh or keychain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fingerprintOf } from '../../../src/runtime/devices/keys.ts';
import type { PeerInfo } from '../../../src/runtime/devices/pair-proof.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { heldSubs, localSubs, ownerHeld } from '../../../src/runtime/devices/sync/held-push.ts';
import { RosterSync, ROSTER_METHOD, SIBLING_METHOD, type Roster } from '../../../src/runtime/devices/sync/roster.ts';
import { makePc, Net, settle, type Pc } from './sync-net.ts';
import { relayPhone } from '../../../src/runtime/devices/rendezvous/phone.ts';

const LENA = 'per_lena000001';
const key = () => { const raw = randomBytes(32); return { pub: raw.toString('base64url'), fp: fingerprintOf(raw) }; };
const id = (name: string) => `dev_${name.padEnd(12, '0')}`;

function pc(net: Net, name: string) {
  const p = makePc(net, id(name));
  const own = key();
  p.repo.patch(p.id, { publicKey: own.pub, fingerprint: own.fp, name });
  (p.h.services as unknown as { host: object }).host = {
    ...(p.h.services.host as object),
    encrypt: async (plain: string) => new TextEncoder().encode(plain), decrypt: async (cipher: Uint8Array) => new TextDecoder().decode(cipher),
  };
  const added: Array<{ info: PeerInfo; options: Record<string, unknown> }> = [];
  const revoked: string[] = [];
  const mesh = {
    register: (method: string, handler: (params: unknown, from: string) => Promise<unknown>) => { p.handlers.set(method, handler); },
    add: (info: PeerInfo, options: { side: string; personId?: string; joinedAs?: 'ceo' | 'employee' }) => {
      added.push({ info, options });
      p.repo.upsert(device(info.id, { name: info.name, publicKey: info.pub, addresses: info.addresses, ...(options.personId ? { personId: options.personId } : {}), ...(options.joinedAs ? { joinedAs: options.joinedAs } : {}) }));
      return p.repo.get(info.id)!;
    },
    revoke: (deviceId: string) => { revoked.push(deviceId); p.repo.patch(deviceId, { status: 'revoked', revokedAt: 1 }); },
    selfInfo: (): PeerInfo => { const self = p.repo.get(p.id)!; return { id: p.id, name: self.name, role: 'home', pub: self.publicKey!, addresses: [] }; },
  };
  const roster = new RosterSync(p.h.services, mesh as never, 0);
  return { ...p, roster, added, revoked };
}

function device(deviceId: string, extra: Partial<DeviceRecord> = {}): DeviceRecord {
  const k = key();
  return { id: deviceId, name: deviceId.slice(4, 9), kind: 'pc', role: 'home', fingerprint: k.fp, publicKey: k.pub, addresses: [], caps: {}, status: 'online', self: false, pairedAt: 100, ...extra };
}

/** `b` is my other PC of `a` (both ways 'ceo'). */
function mine(a: Pc, b: Pc): void {
  a.repo.upsert(device(b.id, { publicKey: b.repo.get(b.id)!.publicKey, fingerprint: b.repo.get(b.id)!.fingerprint }));
  b.repo.upsert(device(a.id, { publicKey: a.repo.get(a.id)!.publicKey, fingerprint: a.repo.get(a.id)!.fingerprint, joinedAs: 'ceo' }));
}

test('my other PC learns every device with the same relation: my employer, my employee, a phone and its token', async () => {
  const net = new Net();
  const a = pc(net, 'alpha');
  const b = pc(net, 'beta');
  mine(a, b);
  a.repo.upsert(device(id('boss'), { joinedAs: 'employee' })); // A joined that company as an employee
  a.repo.upsert(device(id('lena'), { personId: LENA })); // Lena's PC joined A's company
  a.repo.upsert(device(id('phone'), { kind: 'phone', role: 'client', publicKey: undefined }));
  a.h.db.run("INSERT INTO tokens (id, device_id, kind, hash, scope, created_at) VALUES ('tok_1', ?, 'device', ?, '[]', 5)", [id('phone'), 'a'.repeat(64)]);
  await a.roster.linkUp(b.id);
  await settle();

  const by = (deviceId: string) => b.added.find((entry) => entry.info.id === deviceId)?.options;
  assert.deepEqual(by(id('boss')), { side: 'joiner', joinedAs: 'employee' }, 'B dials my employer as the same employee');
  assert.deepEqual(by(id('lena')), { side: 'joiner', personId: LENA }, 'and my employee\'s PC with her person');
  assert.equal(by(a.id), undefined, 'the sender itself is known already');
  assert.equal(b.repo.get(id('phone'))?.kind, 'phone', 'the phone belongs to the company: B knows it');
  assert.equal(b.h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE hash = ? AND device_id = ?", ['a'.repeat(64), id('phone')])?.n, 1, 'and its token opens B too');

  const calls = net.calls.filter((call) => call.method === ROSTER_METHOD).length;
  await a.roster.flush();
  assert.equal(net.calls.filter((call) => call.method === ROSTER_METHOD).length, calls, 'an unchanged roster is not sent again');
});

test('a removal wins over an older pairing, a pairing after the removal wins over it; only my own PCs send a roster', async () => {
  const net = new Net();
  const a = pc(net, 'alpha');
  const b = pc(net, 'beta');
  mine(a, b);
  const old = device(id('old'), { kind: 'phone', role: 'client', pairedAt: 100 });
  b.repo.upsert(old);
  const gone = device(id('gone'), { status: 'revoked', revokedAt: 300, pairedAt: 50 });
  b.repo.upsert(gone);
  const roster = await a.roster.build();
  roster.devices.push({ id: old.id, name: 'old', kind: 'phone', fingerprint: old.fingerprint, addresses: [], pairedAt: 100, revokedAt: 200 });
  roster.devices.push({ id: gone.id, name: 'gone', kind: 'pc', fingerprint: gone.fingerprint, pub: gone.publicKey, addresses: [], pairedAt: 250 });
  await b.roster.receive(roster, a.id);
  assert.equal(b.repo.get(old.id)?.revokedAt, 200, 'removed on my other PC: removed here');
  assert.deepEqual(b.added.map((entry) => entry.info.id), [], 'a pairing older than the removal stays removed');

  roster.devices[roster.devices.length - 1] = { ...roster.devices[roster.devices.length - 1], pairedAt: 400 };
  await b.roster.receive(roster, a.id);
  assert.deepEqual(b.added.map((entry) => entry.info.id), [gone.id], 'paired again after the removal: linked again');

  b.repo.upsert(device(id('emp'), { personId: LENA }));
  await assert.rejects(b.roster.receive(roster, id('emp')), (error: WorkforceError) => error.code === 'forbidden');
});

test('a removal from before this PC kept a roster stays its own: it never cuts a link my other PC kept', async () => {
  const net = new Net();
  const a = pc(net, 'alpha');
  const b = pc(net, 'beta');
  mine(a, b);
  const now = a.h.clock.now();
  a.repo.upsert(device(id('laptop'), { status: 'revoked', revokedAt: now - 1000, pairedAt: 50 }));
  a.repo.upsert(device(id('fresh'), { status: 'revoked', revokedAt: now + 1, pairedAt: 50 }));
  const sent = (await a.roster.build()).devices.map((d) => d.id);
  assert.equal(sent.includes(id('laptop')), false, 'removed in 0.3.x days: not in the roster');
  assert.equal(sent.includes(id('fresh')), true, 'removed since: it travels');
});

test('held push subscriptions: another PC\'s are kept under its key and follow its own list; mine never', async () => {
  const net = new Net();
  const a = pc(net, 'alpha');
  const b = pc(net, 'beta');
  mine(a, b);
  const sub = (n: number, k: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, data: { endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'p', auth: 'a' } }, key: k });
  const base: Roster = { v: 1, devices: [], tokens: [], subs: [sub(1, 'KA'), sub(2, 'KA'), sub(3, 'KC')], keys: [{ pub: 'KA', priv: 'secret' }], vapid: 'KA' };
  await b.roster.receive(base, a.id);
  assert.deepEqual(heldSubs(b.h.db).map((s) => s.endpoint.slice(-1)).sort(), ['1', '2', '3']);
  await b.roster.receive({ ...base, subs: [sub(1, 'KA')] }, a.id);
  assert.deepEqual(heldSubs(b.h.db).map((s) => s.endpoint.slice(-1)).sort(), ['1', '3'], 'A dropped its 2: gone here; C\'s stays');
});

test('device.sibling: the company stores her other PC with her person and says so once; an employee\'s PC stores my company\'s other PC', async () => {
  const net = new Net();
  const company = pc(net, 'company');
  const lena = pc(net, 'lena');
  company.repo.upsert(device(lena.id, { personId: LENA, publicKey: lena.repo.get(lena.id)!.publicKey, fingerprint: lena.repo.get(lena.id)!.fingerprint }));
  lena.repo.upsert(device(company.id, { joinedAs: 'employee' }));
  company.h.db.run(`INSERT INTO people (id, name, status, created_at, updated_at) VALUES (?, 'Lena', 'active', 0, 0)`, [LENA]);
  (company.h.services as unknown as { people: unknown }).people = { get: (personId: string) => (personId === LENA ? { id: LENA, name: 'Lena' } : undefined) };
  const laptop = key();
  const info: PeerInfo = { id: id('laptop'), name: 'Laptop', role: 'home', pub: laptop.pub, addresses: ['http://10.0.0.9:47812'] };

  await company.roster.sibling({ info }, lena.id);
  await company.roster.sibling({ info }, lena.id);
  assert.deepEqual(company.added.map((entry) => entry.options), [{ side: 'joiner', personId: LENA }], 'stored once, with her person');
  assert.deepEqual(company.h.notified.filter((note) => note.title === 'Lena added a device').length, 1, 'the owner hears it once');

  const other = { ...info, id: id('tower'), pub: key().pub };
  await lena.roster.sibling({ info: other }, company.id);
  assert.deepEqual(lena.added.map((entry) => entry.options), [{ side: 'joiner', joinedAs: 'employee' }], 'another PC of her company');
  await company.roster.sibling({ info: { ...info, id: id('mine') } }, id('nobody'));
  assert.equal(company.added.length, 1, 'from no link: nothing');
});

test('each of my PCs is introduced once over every employer link', async () => {
  const net = new Net();
  const e1 = pc(net, 'eone');
  const e2 = pc(net, 'etwo');
  const boss = pc(net, 'boss');
  mine(e1, e2);
  e1.repo.upsert(device(boss.id, { joinedAs: 'employee' }));
  boss.repo.upsert(device(e1.id, { personId: LENA, publicKey: e1.repo.get(e1.id)!.publicKey }));
  await e1.roster.introduce();
  await e1.roster.introduce();
  const intros = net.calls.filter((call) => call.method === SIBLING_METHOD);
  assert.equal(intros.length, 1);
  assert.equal((intros[0].params as { info: PeerInfo }).info.id, e2.id);
  assert.equal(boss.repo.get(e2.id)?.personId, LENA, 'the company now knows her second PC as hers');
});

test('removals follow introductions: my removed PC leaves the company it was introduced to, an unrelated link drops nothing', async () => {
  const net = new Net();
  const e1 = pc(net, 'eone');
  const e2 = pc(net, 'etwo');
  const boss = pc(net, 'boss');
  mine(e1, e2);
  e1.repo.upsert(device(boss.id, { joinedAs: 'employee' }));
  boss.repo.upsert(device(e1.id, { personId: LENA, publicKey: e1.repo.get(e1.id)!.publicKey }));
  await e1.roster.introduce();
  assert.equal(boss.repo.get(e2.id)?.personId, LENA);

  const intro = net.calls.find((call) => call.method === SIBLING_METHOD)!.params as { info: PeerInfo };
  boss.repo.upsert(device(id('other'), { personId: 'per_other00001' }));
  await boss.roster.sibling({ info: intro.info, revokedAt: 500 }, id('other'));
  assert.deepEqual(boss.revoked, [], 'another person\'s PC cannot remove Lena\'s');

  e1.repo.patch(e2.id, { status: 'revoked', revokedAt: 500 }); // I remove my second PC (stolen)
  await e1.roster.introduce();
  await e1.roster.introduce();
  assert.deepEqual(boss.revoked, [e2.id], 'the company drops it too, once');
});

test('an introduction never relabels a PC linked already: the company\'s own other PC stays its own', async () => {
  const net = new Net();
  const company = pc(net, 'company');
  const tower = pc(net, 'tower');
  const lena = pc(net, 'lena');
  mine(company, tower);
  company.repo.upsert(device(lena.id, { personId: LENA, publicKey: lena.repo.get(lena.id)!.publicKey }));
  const own = company.repo.get(tower.id)!;
  await company.roster.sibling({ info: { id: tower.id, name: 'Tower', role: 'home', pub: own.publicKey!, addresses: [] } }, lena.id);
  assert.deepEqual(company.added, [], 'nothing re-added');
  assert.equal(company.repo.get(tower.id)?.personId, undefined, 'still my own PC, not Lena\'s');
  assert.equal(company.h.notified.length, 0, 'and no false notice');
});

test('a sibling goes when every PC that introduced it is gone here', async () => {
  const net = new Net();
  const lena = pc(net, 'lena');
  const boss = pc(net, 'boss');
  lena.repo.upsert(device(boss.id, { joinedAs: 'employee' }));
  const second = { id: id('boss2'), name: 'Boss two', role: 'home' as const, pub: key().pub, addresses: [] };
  await lena.roster.sibling({ info: second }, boss.id);
  assert.equal(lena.repo.get(second.id)?.joinedAs, 'employee');
  const off = lena.roster.attach();
  lena.repo.patch(boss.id, { status: 'revoked', revokedAt: 600 }); // I leave that company
  lena.h.bus.emit('device.upserted', { ...lena.repo.get(boss.id)!, status: 'revoked' } as never);
  off();
  assert.deepEqual(lena.revoked, [second.id], 'the PC it introduced goes with it');
});

test('my phones as the roster carries them: a removed person\'s or an expired phone is nobody\'s; held ones need a live token here', () => {
  const net = new Net();
  const a = pc(net, 'alpha');
  const db = a.h.db;
  const now = a.h.clock.now();
  const sub = (n: number, device: string | null) => db.run('INSERT INTO push_subscriptions (id, device_id, endpoint, data, created_at) VALUES (?, ?, ?, ?, 1)',
    [`ps_${n}`, device, `https://push.example/${n}`, JSON.stringify({ endpoint: `https://push.example/${n}`, keys: { p256dh: 'p', auth: 'a' } })]);
  const token = (n: number, device: string, kind: string, extra: { expires?: number; revoked?: number; person?: string } = {}) => db.run(
    'INSERT INTO tokens (id, device_id, kind, hash, scope, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    [`tok_${n}`, device, kind, String(n).repeat(64).slice(0, 64), JSON.stringify(extra.person ? { personId: extra.person } : []), extra.expires ?? null, extra.revoked ?? null]);
  sub(1, null); // the owner's own browser
  sub(2, 'dev_phone00001'); token(2, 'dev_phone00001', 'device');
  sub(3, 'dev_phone00002'); token(3, 'dev_phone00002', 'person', { person: 'per_gone000001', revoked: 5 }); // an ex-employee's phone
  sub(4, 'dev_phone00003'); token(4, 'dev_phone00003', 'device', { expires: now - 1 }); // expired
  sub(5, 'dev_phone00004'); token(5, 'dev_phone00004', 'person', { person: LENA });
  sub(6, 'dev_phone00005'); token(6, 'dev_phone00005', 'device', { revoked: 5 }); // removed
  const local = localSubs(db, 'K', now);
  assert.deepEqual(local.map((s) => s.endpoint.slice(-1)), ['1', '2', '5']);
  assert.equal(local.find((s) => s.endpoint.endsWith('5'))?.person, LENA);

  const held = (n: number, deviceId?: string, person?: string) => ({ endpoint: `https://push.example/h${n}`, data: { endpoint: '', keys: { p256dh: 'p', auth: 'a' } }, key: 'KB', ...(deviceId ? { deviceId } : {}), ...(person ? { person } : {}) });
  const targets = ownerHeld(db, [held(1), held(2, 'dev_phone00001'), held(3, 'dev_phone00002'), held(4, 'dev_phone00003'), held(5, 'dev_unknown001'), held(6, undefined, LENA)], now);
  assert.deepEqual(targets.map((s) => s.endpoint.slice(-2)), ['h1', 'h2'], 'only the owner\'s own and live phones');
});

test('B-078 (T6b.12): a paired app phone reaches my other PC with the same device id and key, so it pins it as a relay phone', async () => {
  const net = new Net();
  const a = pc(net, 'alpha');
  const b = pc(net, 'beta');
  mine(a, b);
  const phone = device(id('pixel'), { kind: 'phone', role: 'client', name: 'Pixel 8' });
  a.repo.upsert(phone);
  a.h.db.run("INSERT INTO tokens (id, device_id, kind, hash, scope, created_at) VALUES ('tok_p', ?, 'device', ?, '[]', 5)", [phone.id, 'b'.repeat(64)]);
  await a.roster.linkUp(b.id);
  await settle();
  const there = b.repo.get(phone.id);
  assert.equal(there?.kind, 'phone');
  assert.equal(there?.publicKey, phone.publicKey, 'the key the meeting server pins');
  assert.equal(there?.fingerprint, phone.fingerprint);
  assert.equal(relayPhone(there), true, 'B takes its tunnel (rendezvous/phone.ts relayPhone)');
  assert.equal(b.h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE hash = ? AND device_id = ?", ['b'.repeat(64), phone.id])?.n, 1, 'its token hash authenticates on B');
});
