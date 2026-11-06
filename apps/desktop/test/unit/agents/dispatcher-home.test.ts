// The dispatcher's home gate (devices/sync/home.ts): an agent whose home is another of the CEO's PCs starts no turn
// here – its wakes stay queued for the hand-over; one homed here, on an employee's PC or on a removed PC runs here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { flush, setup } from '../dispatcher/fakes.ts';

function pc(id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return { id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra };
}

test('only agents whose home is this PC (or no CEO PC) start turns here', async () => {
  const h = setup({ maxConcurrent: 6 });
  const repo = new DevicesRepo(h.db);
  repo.upsert(pc('dev_here', { self: true }));
  repo.upsert(pc('dev_tower'));
  repo.upsert(pc('dev_lena', { personId: 'per_lena000001' }));
  repo.upsert(pc('dev_old', { status: 'revoked', revokedAt: 1 }));
  const agents = {
    away: h.org.add(agent('ag_away', 'Away', { deviceId: 'dev_tower' })),
    unknown: h.org.add(agent('ag_unknown', 'Unknown', { deviceId: 'dev_far' })), // a PC only another CEO PC knows
    staff: h.org.add(agent('ag_staff', 'Staff', { deviceId: 'dev_lena' })),
    old: h.org.add(agent('ag_old', 'Old', { deviceId: 'dev_old' })),
    here: h.org.add(agent('ag_here', 'Here', { deviceId: 'dev_here' })),
    none: h.org.add(agent('ag_none', 'None')),
  };
  h.dispatcher.start();
  for (const item of Object.values(agents)) h.wakes.wake({ agentId: item.id, reason: 'manual' });
  await flush();
  const started = h.executor.calls.map((call) => call.request.agentId).sort();
  assert.deepEqual(started, ['ag_here', 'ag_none', 'ag_old', 'ag_staff']);
  assert.equal(h.wakes.pending('ag_away'), 1, 'its wake waits, unclaimed, for the hand-over to its home');
  assert.equal(h.wakes.pending('ag_unknown'), 1);

  // Without any CEO link left, a home this PC does not know is no reason to stand still.
  repo.patch('dev_tower', { status: 'revoked', revokedAt: 2 });
  for (const call of h.executor.calls) call.finish();
  await flush();
  h.wakes.wake({ agentId: 'ag_unknown', reason: 'manual', note: 'again' });
  h.wakes.wake({ agentId: 'ag_away', reason: 'manual', note: 'again' });
  await flush();
  assert.ok(h.executor.calls.some((call) => call.request.agentId === 'ag_unknown'));
  assert.ok(h.executor.calls.some((call) => call.request.agentId === 'ag_away'), 'a removed home PC: it works here again');
});
