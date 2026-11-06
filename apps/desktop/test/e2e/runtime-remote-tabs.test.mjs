// End-to-end (B-076, the side pane on the other PC): two headless runtimes on this machine, B linked to A as one of the
// CEO's PCs (Remote ID over loopback discovery, A accepts). A website tab written into A's <data>/side-tabs.json – as
// A's main writes it – shows in B's file as a 'remote' panel of A within seconds, with A's file tab naming A; the phone
// of B reads it the same way (tabs.get). B closes that panel (its file without it, as B's main writes it) and A's
// website tab leaves A's file. No Electron here: main's part (following the file) is unit-tested in
// test/unit/main/workspace-tabs.test.ts. The link travels over the peer listeners' LAN/tailnet addresses (skipped
// without any).
// Run: npm run build && node --test test/e2e/runtime-remote-tabs.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startRuntime } from './lib/runtime-client.mjs';

const A_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.2,127.0.0.3' };
const B_ENV = { WORKFORCE_DISCOVERY_TARGETS: '127.0.0.3,127.0.0.2' };

async function until(read, ok, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const fileOf = (runtime) => path.join(runtime.dataDir, 'side-tabs.json');
const spacesOf = (runtime) => { try { return JSON.parse(readFileSync(fileOf(runtime), 'utf8')).spaces ?? {}; } catch { return {}; } };
const write = (runtime, spaces) => writeFileSync(fileOf(runtime), `${JSON.stringify({ version: 2, spaces }, null, 1)}\n`);

test('a tab opened on A shows on B as A\'s remote tab; closing it on B closes it on A', { timeout: 300_000 }, async (t) => {
  const a = await startRuntime({ env: A_ENV });
  t.after(() => a.stop());
  const b = await startRuntime({ env: B_ENV });
  t.after(() => b.stop());
  const peer = await until(() => a.client.call('system.info').then((info) => info.peer), (state) => state?.status === 'open', 'A to accept requests');
  if (!peer.addresses.length) { t.skip('this machine has no LAN or tailnet address for the peer listener'); return; }

  const aId = (await a.client.call('remote.state')).self.deviceId;
  const bId = (await b.client.call('remote.state')).self.deviceId;
  await b.client.call('remote.connect', { target: (await a.client.call('remote.state')).self.remoteId });
  const incoming = await until(() => a.client.call('remote.state').then((state) => state.incoming), (list) => list.length === 1, 'the request on A');
  await a.client.call('remote.decide', { id: incoming[0].id, accept: true });
  await until(() => a.client.call('devices.list').then((list) => list.find((device) => device.id === bId)?.status), (status) => status === 'online', 'A to list B online');
  await until(() => b.client.call('devices.list').then((list) => list.find((device) => device.id === aId)?.status), (status) => status === 'online', 'B to list A online');

  const started = Date.now();
  const notes = path.join(a.dataDir, 'notes-on-a.md');
  write(a, { global: { shown: 'web-e2etab1', tabs: [
    { id: 'web-e2etab1', url: 'https://example.com/' },
    { id: `file:${notes}`, panel: 'file', path: notes },
  ] } });
  const remoteId = `remote:${aId}:web-e2etab1`;
  const onB = await until(() => spacesOf(b).global, (space) => space?.tabs?.some((tab) => tab.id === remoteId), 'A\'s tab on B');
  t.diagnostic(`A's tab on B: ${Date.now() - started} ms`);
  assert.deepEqual(onB.tabs.find((tab) => tab.id === remoteId), { id: remoteId, panel: 'remote', device: aId, tab: 'web-e2etab1', url: 'https://example.com/' });
  assert.deepEqual(onB.tabs.find((tab) => tab.panel === 'file'), { id: `file@${aId}:${notes}`, panel: 'file', path: notes, device: aId }, 'A\'s file names A');
  assert.equal(onB.shown, remoteId, 'the same tab is shown');
  const phone = await b.client.call('tabs.get');
  assert.ok(phone.spaces.global.tabs.some((tab) => tab.id === remoteId), 'B\'s phone sees it too');

  const closing = Date.now();
  write(b, { ...spacesOf(b), global: { tabs: onB.tabs.filter((tab) => tab.id !== remoteId) } });
  await until(() => spacesOf(a).global, (space) => !space?.tabs?.some((tab) => tab.id === 'web-e2etab1'), 'A\'s tab closed on A');
  t.diagnostic(`closed on B → gone on A: ${Date.now() - closing} ms`);
  assert.deepEqual(spacesOf(a).global.tabs.map((tab) => tab.id), [`file:${notes}`], 'A keeps its file tab in its own form');
});
