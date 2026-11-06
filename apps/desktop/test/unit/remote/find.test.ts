// Finding the PC typed into "Connect" (remote/find.ts): a Remote ID on this network first, then at
// the meeting server; only candidates whose key gives the typed Remote ID; an address is asked directly.
// Nothing found: not_found says what was searched, names a meeting server that is off or not
// reachable, and what to do on the other PC.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEETING_OFF, MEETING_TIMEOUT_MS, MEETING_UNREACHABLE, findTarget, type Found } from '../../../src/runtime/remote/find.ts';
import { remoteIdOf } from '../../../src/runtime/remote/id.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const hex = (digit: string) => digit.repeat(64);
const found = (digit: string, address: string, extra: Partial<Found> = {}): Found & { remoteId: string } => ({
  deviceId: `dev_${digit.repeat(12)}`, name: `PC ${digit}`, fingerprint: hex(digit), addresses: [address], remoteId: remoteIdOf(hex(digit)), ...extra,
});
const notFound = (pattern: RegExp) => (error: unknown) => error instanceof WorkforceError && error.code === 'not_found' && pattern.test(error.message);

test('a Remote ID: the LAN answer wins; the meeting server only when nobody here has it; wrong keys are dropped', async () => {
  const target = { remoteId: remoteIdOf(hex('a')) };
  let asked = 0;
  const meeting = async () => { asked++; return [found('a', 'relay:' + hex('a')), found('b', 'relay:' + hex('b'))]; };
  const here = await findTarget({ self: 'dev_me', lan: async () => [found('a', 'http://10.0.0.1:47812'), found('c', 'http://10.0.0.3:47812')], meeting }, target);
  assert.deepEqual(here.map((entry) => entry.addresses[0]), ['http://10.0.0.1:47812']);
  assert.equal(asked, 0, 'found here: the meeting server is not asked');
  const far = await findTarget({ self: 'dev_me', lan: async () => [], meeting }, target);
  assert.deepEqual(far.map((entry) => entry.addresses[0]), ['relay:' + hex('a')], 'the other key is dropped');
  await assert.rejects(findTarget({ self: 'dev_me', lan: async () => { throw new Error('no network'); } }, target), notFound(/^No PC with this Remote ID is online\./), 'failing sources find nothing');
});

test('nothing found: the text names the meeting server when it is off or not reachable, and what to do', async () => {
  const target = { remoteId: remoteIdOf(hex('a')) };
  const lan = async () => [];
  let signal: AbortSignal | undefined;
  const online = async (_id: string, given: AbortSignal) => { signal = given; return []; };
  await assert.rejects(findTarget({ self: 'dev_me', lan, meeting: online }, target), notFound(/^No PC with this Remote ID is online\. Open Autark on that PC – Settings › Devices shows its Remote ID\.$/));
  assert.ok(signal && !signal.aborted, 'the lookup gets its own deadline');
  assert.equal(MEETING_TIMEOUT_MS, 45_000, 'long enough for a free host to wake');
  const off = async () => { throw new WorkforceError('unavailable', MEETING_OFF); };
  // The cause first: the connect row's one line shows only the start.
  await assert.rejects(findTarget({ self: 'dev_me', lan, meeting: off }, target), notFound(/^Meeting server off \(devices\.relay\) – no PC with this Remote ID on this network\. Open Autark on that PC – Settings › Devices shows its Remote ID\.$/));
  const down = async () => { throw new WorkforceError('timeout', 'The meeting server did not answer in time.'); };
  await assert.rejects(findTarget({ self: 'dev_me', lan, meeting: down }, target), notFound(new RegExp(`^${MEETING_UNREACHABLE} – no PC with this Remote ID on this network\\. Open Autark`)));
  const refused = async () => { throw new WorkforceError('unavailable', 'The meeting server refused this (rate_limited).'); };
  await assert.rejects(findTarget({ self: 'dev_me', lan, meeting: refused }, target), notFound(/^The meeting server refused this \(rate_limited\) – no PC with this Remote ID on this network\./), 'the server\'s own reason');
  assert.ok(MEETING_OFF.length < 40 && MEETING_UNREACHABLE.length < 40, 'short enough to be read in the line');
});

test('an address: its well-known identity, never this PC', async () => {
  const wellKnown = async (address: string) => (address === 'http://203.0.113.5:47812' ? { deviceId: 'dev_aaaaaaaaaaaa', name: 'Office', fingerprint: hex('a') } : undefined);
  assert.deepEqual(await findTarget({ self: 'dev_me', wellKnown }, { address: 'http://203.0.113.5:47812' }), [{ deviceId: 'dev_aaaaaaaaaaaa', name: 'Office', fingerprint: hex('a'), addresses: ['http://203.0.113.5:47812'] }]);
  await assert.rejects(findTarget({ self: 'dev_aaaaaaaaaaaa', wellKnown }, { address: 'http://203.0.113.5:47812' }), notFound(/^No Autark PC answered at that address\.$/));
  await assert.rejects(findTarget({ self: 'dev_me', wellKnown }, { address: 'http://198.51.100.1:47812' }), notFound(/^No Autark PC answered at that address\.$/));
});
