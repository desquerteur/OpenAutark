// Migration 71 (B-044, TeleCoding removed): the producer's kv rows ('telecoding' token, signing key,
// hidden choice; 'telecoding.requests' ledger), the v7 import's copy of its settings and the
// connection's device rows ('telecoding:…', active or revoked) go; every other kv row and device
// stays. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate, SCHEMA_VERSION } from '../../../src/runtime/db/migrate.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';

const device = (id: string, name: string, kind: 'phone' | 'pc', revokedAt?: number) => ({
  id, name, kind, role: 'client' as const, fingerprint: `fp-${id}`, addresses: [], caps: {},
  status: revokedAt ? 'revoked' as const : 'online' as const, self: false, pairedAt: 1, lastSeenAt: 1, revokedAt,
});

test('migration 71: TeleCoding kv rows and connection devices go, everything else stays', () => {
  const db = new Db(':memory:');
  migrate(db, { until: 69 });
  const kv = new KvRepo(db);
  kv.set('telecoding', 'token', 'cipher', 1);
  kv.set('telecoding', 'signing', 'cipher', 1);
  kv.set('telecoding', 'hidden', true, 1);
  kv.set('telecoding.requests', 'req-1', { tool: 'chat.send', result: {} }, 1);
  kv.set('legacy', 'telecoding', { allowControl: true }, 1);
  kv.set('legacy', 'connections', [], 1);
  kv.set('pwa', 'vapid', 'cipher', 1);
  const devices = new DevicesRepo(db);
  devices.upsert(device('telecoding:0123456789abcdef', 'TeleCoding', 'phone'));
  devices.upsert(device('telecoding:fedcba9876543210', 'TeleCoding', 'phone', 5));
  devices.upsert(device('phone-1', 'Pixel', 'phone'));
  devices.upsert(device('pc-1', 'Desk', 'pc'));

  migrate(db);
  assert.equal(new KvRepo(db).get('telecoding', 'token'), undefined);
  assert.equal(new KvRepo(db).get('telecoding', 'signing'), undefined);
  assert.equal(new KvRepo(db).get('telecoding', 'hidden'), undefined);
  assert.equal(new KvRepo(db).get('telecoding.requests', 'req-1'), undefined);
  assert.equal(new KvRepo(db).get('legacy', 'telecoding'), undefined);
  assert.deepEqual(new KvRepo(db).get('legacy', 'connections'), []);
  assert.equal(new KvRepo(db).get('pwa', 'vapid'), 'cipher');
  assert.deepEqual(new DevicesRepo(db).list({ includeRevoked: true }).map((row) => row.id).sort(), ['pc-1', 'phone-1']);
  assert.ok(SCHEMA_VERSION >= 71);
});
