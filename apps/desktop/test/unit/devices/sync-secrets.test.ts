// Secrets between the CEO's PCs (devices/sync/secrets.ts): two vaults with the fake keychain on a fake mesh that
// passes JSON. A value arrives under the same id and works there; it is never in a log, in the kv store or in a
// call's answer; an employee's PC gets none and may send none; at the first link the PC that joined takes the other's
// entry for a shared id and keeps its own, when it differs, under a new id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { SecretSync } from '../../../src/runtime/devices/sync/secrets.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { fakeHost, ManualClock, memoryDb } from './fakes.ts';

const KEY = 'sk-live-9f8e7d6c5b4a';
const PASSWORD = 'Tr0ub4dor&3-horse';

const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

class Net {
  readonly pcs = new Map<string, Pc>();
  readonly calls: Array<{ from: string; to: string; answer: string }> = [];
}

type Pc = ReturnType<typeof makePc>;

function makePc(net: Net, id: string) {
  const db = memoryDb();
  const clock = new ManualClock();
  const logs: unknown[] = [];
  const log = { debug: (...args: unknown[]) => logs.push(args), info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) };
  const host = fakeHost();
  const vault = new SecretVault({ db, host, clock, log });
  const repo = new DevicesRepo(db);
  repo.upsert(record(id, { self: true }));
  const handlers = new Map<string, (params: unknown, from: string) => Promise<unknown>>();
  const s = {
    db, clock, host, log, secrets: vault,
    devices: {
      online: (peer: string) => net.pcs.has(peer),
      call: async (peer: string, method: string, params: unknown) => {
        const target = net.pcs.get(peer);
        if (!target) throw new WorkforceError('unavailable', 'offline');
        const answer = await target.handlers.get(method)!(JSON.parse(JSON.stringify(params)), id);
        net.calls.push({ from: id, to: peer, answer: JSON.stringify(answer) });
        return answer;
      },
    },
  } as unknown as RuntimeServices;
  const sync = new SecretSync(s, new Stamps(db, clock));
  handlers.set('sync.secret', (params, from) => sync.receive(params, from));
  const pc = { id, db, vault, logs, repo, sync, handlers };
  net.pcs.set(id, pc);
  return pc;
}

function link(a: Pc, b: Pc, person?: string): void {
  a.repo.upsert(record(b.id, person ? { personId: person } : {}));
  b.repo.upsert(record(a.id, { joinedAs: person ? 'employee' : 'ceo' }));
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 2)); };

test('a secret reaches the CEO\'s other PC under the same id and works there – its value is never logged or stored in the clear', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  const e = makePc(net, 'dev_e');
  link(a, b);
  link(a, e, 'per_lena000001');
  for (const pc of [a, b, e]) pc.sync.attach();

  const key = await a.vault.save({ label: 'OpenAI key', kind: 'api_key', value: KEY });
  const login = await a.vault.saveGroup({ label: 'Shop', kind: 'login', fields: [{ field: 'username', kind: 'text', value: 'lena@example.com' }, { field: 'password', kind: 'password', value: PASSWORD }] });
  await settle();
  assert.equal(await b.vault.use(key.id, 'ag_test'), KEY);
  const password = login.fields.find((field) => field.field === 'password')!;
  assert.equal(await b.vault.use(password.id, 'ag_test'), PASSWORD);
  assert.deepEqual(b.vault.groups().map((group) => group.id), [login.group.id]);
  assert.equal(b.vault.redact(`token ${KEY}`), `token secret://${key.id}`, 'its redactor learned the value');
  assert.equal(net.calls.filter((call) => call.to === 'dev_e').length, 0, 'an employee\'s PC gets no secret');
  await assert.rejects(a.handlers.get('sync.secret')!({ items: [] }, 'dev_e'), /CEO/);

  a.vault.remove(key.id);
  await settle();
  assert.equal(b.vault.list().some((info) => info.id === key.id), false, 'a removal travels');
  for (const pc of [a, b]) {
    const text = JSON.stringify(pc.logs) + JSON.stringify(pc.db.all('SELECT * FROM kv')) + JSON.stringify(net.calls);
    assert.ok(!text.includes(KEY) && !text.includes(PASSWORD), `${pc.id}: no value in logs, kv or answers`);
    const stored = JSON.stringify(pc.db.all('SELECT id, label, hint, description, tags FROM secrets'));
    assert.ok(!stored.includes(PASSWORD), `${pc.id}: only the cipher holds it`);
  }
});

test('at the first link the PC that joined takes the other PC\'s value for an id both have and keeps its own beside it', async () => {
  const net = new Net();
  const a = makePc(net, 'dev_a');
  const b = makePc(net, 'dev_b');
  await a.vault.save({ id: 'sec_shared', label: 'Shared key', kind: 'api_key', value: 'value-of-a' });
  await b.vault.save({ id: 'sec_shared', label: 'Shared key', kind: 'api_key', value: 'value-of-b' });
  for (const pc of [a, b]) await pc.vault.save({ id: 'sec_same', label: 'Same key', kind: 'api_key', value: 'one value' });
  link(a, b); // B joined A
  for (const pc of [a, b]) pc.sync.attach();
  assert.ok(await a.sync.catchUp('dev_b', undefined));
  assert.ok(await b.sync.catchUp('dev_a', undefined));
  await settle();
  assert.equal(await a.vault.use('sec_shared', 'ag_test'), 'value-of-a');
  assert.equal(await b.vault.use('sec_shared', 'ag_test'), 'value-of-a');
  for (const pc of [a, b]) {
    assert.deepEqual(pc.vault.list().map((info) => info.id).sort(), ['sec_same', 'sec_shared', 'sec_shared-key'], `${pc.id}: one copy, none for the same value`);
    assert.equal(await pc.vault.use('sec_shared-key', 'ag_test'), 'value-of-b', `${pc.id}: B's own value stays and travels`);
  }
  for (const pc of [a, b]) assert.ok(!JSON.stringify(pc.logs).includes('value-of-b'), `${pc.id}: no value in the logs`);
});
