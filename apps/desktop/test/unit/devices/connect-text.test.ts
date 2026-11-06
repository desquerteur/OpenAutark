// The texts of Settings › Devices (ui/settings/connect-text.ts): grouped Remote IDs, the line under
// "Connect" for each state of this PC's request (with the code while it waits), the Remote ID hint
// with the meeting server or "only this network", a device row's hint (an employee's PC names its
// person), and when the first run's Connect card ends the first run (ui/onboarding/first-run-model.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectLine, deviceHint, groupDigits, remoteIdHint, typedTarget, CONNECT_HINT } from '../../../src/ui/settings/connect-text.ts';
import { linkedAsCeo } from '../../../src/ui/onboarding/first-run-model.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import type { RemoteOutgoing } from '../../../src/shared/model/remote.ts';

const out = (status: RemoteOutgoing['status'], role: RemoteOutgoing['role'] = 'ceo'): RemoteOutgoing => ({ id: 'ro_1', role, deviceId: 'dev_x', name: 'Tower', remoteId: '123456782', fingerprint: 'f'.repeat(64), code: '4821', status, expiresAt: 1 });

test('Remote IDs in groups of three; a typed address stays as typed', () => {
  assert.equal(groupDigits('482913071'), '482 913 071');
  assert.equal(typedTarget('4829130'), '482 913 0');
  assert.equal(typedTarget('203.0.113.5'), '203.0.113.5');
});

test('the line under Connect: help, waiting with the code, outcomes, errors', () => {
  assert.deepEqual(connectLine(undefined, null), { text: CONNECT_HINT });
  assert.deepEqual(connectLine(out('waiting', 'employee'), null), { text: 'Waiting for Tower to accept as an employee – it shows the same code', code: '4821', action: 'cancel' });
  assert.equal(connectLine(out('accepted'), null).tone, 'ok');
  assert.equal(connectLine(out('declined'), null).action, 'close');
  assert.deepEqual(connectLine(out('waiting'), 'No Autark PC answered at that address.'), { text: 'No Autark PC answered at that address.', tone: 'error' });
});

test('the Remote ID hint: through the meeting server, or only this network', () => {
  const relay = (status: 'off' | 'connecting' | 'connected' | 'error') => ({ status, peersOnline: 0, relayed: [] });
  assert.equal(remoteIdHint(undefined, true), 'Type it on another PC to connect', 'not read yet: nothing claimed');
  assert.equal(remoteIdHint(relay('connected'), true), 'Type it on another PC to connect · meeting server connected');
  assert.equal(remoteIdHint(relay('off'), true), 'Type it on another PC to connect · only this network (meeting server off)');
  assert.match(remoteIdHint(relay('connecting'), true), /only this network for now \(meeting server connecting…\)$/);
  assert.match(remoteIdHint({ ...relay('error'), error: 'The meeting server is not reachable (ECONNREFUSED)' }, true), /only this network for now \(the meeting server is not reachable \(ECONNREFUSED\)\)$/);
  assert.match(remoteIdHint({ ...relay('error'), error: 'The meeting server refused this PC' }, true), /only this network for now \(the meeting server refused this PC\)$/, 'its own reason, not "not reachable"');
  assert.match(remoteIdHint(relay('error'), true), /only this network for now \(meeting server not reachable\)$/);
  assert.match(remoteIdHint(undefined, false), /devices\.findable/);
});

test('the first run ends after a link as the CEO only', () => {
  assert.equal(linkedAsCeo(out('accepted')), true);
  assert.equal(linkedAsCeo(out('accepted', 'employee')), false, 'an employee\'s PC goes on with its own setup');
  assert.equal(linkedAsCeo(out('waiting')), false);
  assert.equal(linkedAsCeo(undefined), false);
});

test('device hints: this PC, a phone, the CEO\'s PC and an employee\'s PC', () => {
  const base: Device = { id: 'dev_a', name: 'Tower', kind: 'pc', role: 'home', fingerprint: 'f', addresses: [], caps: {}, status: 'online', self: false };
  const time = () => '14:02';
  assert.equal(deviceHint({ ...base, self: true }, () => undefined, time), 'This PC');
  assert.equal(deviceHint({ ...base, kind: 'phone', lastSeenAt: 1 }, () => undefined, time), 'Phone · Last used 14:02');
  assert.equal(deviceHint(base, () => undefined, time), 'PC · Online');
  assert.equal(deviceHint({ ...base, personId: 'per_anna', status: 'offline', lastSeenAt: 1 }, (id) => (id === 'per_anna' ? 'Anna' : undefined), time), 'PC · Employee · Anna · Not reachable · Last seen 14:02');
});
