// MM7: the runtime asks main to restart it (system.restartRuntime → host op runtime.restart):
// RuntimeHost answers first, drains the old process and starts a new one at once ('restarting'
// with inMs 0, no backoff); a quit meanwhile wins. A start that applies a staged restore asks
// for a longer wait for 'ready' (runtime.booting). The Electron host forwards both ops.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeStatus } from '../../../src/shared/api/desktop.ts';
import type { AppInfo, HostRequest } from '../../../src/shared/api/host-bridge.ts';
import { HOST_BRIDGE_PROTOCOL } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { RESTORE_BOOT_MS, RuntimeHost } from '../../../src/main/runtime-host.ts';
import type { RuntimeChild } from '../../../src/main/runtime-host.ts';
import { HostServices, type HostServicesDeps } from '../../../src/main/host-services.ts';
import { HostBridgeClient, createElectronHost } from '../../../src/runtime/host-electron.ts';

const TOKEN = 'c'.repeat(64);
const APP: AppInfo = { version: '0.2.0', packaged: false, resourcesDir: '/app', dataDir: '/data', executable: '/electron' };

class FakeChild implements RuntimeChild {
  readonly stdout = null;
  readonly stderr = null;
  readonly posted: unknown[] = [];
  killed = false;
  private onMessage: ((message: unknown) => void) | null = null;
  private onExit: ((code: number) => void) | null = null;
  postMessage(message: unknown) { this.posted.push(message); }
  on(event: 'message' | 'exit', listener: ((message: unknown) => void) | ((code: number) => void)) {
    if (event === 'message') this.onMessage = listener as (message: unknown) => void;
    else this.onExit = listener as (code: number) => void;
    return this;
  }
  kill() { this.killed = true; return true; }
  receive(message: unknown) { this.onMessage?.(message); }
  exit(code = 0) { this.onExit?.(code); }
  types() { return this.posted.map(message => (message as { type: string }).type); }
}

function harness() {
  const children: FakeChild[] = [];
  const statuses: RuntimeStatus[] = [];
  const handled: HostRequest[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const host = new RuntimeHost<string>({
    fork: () => { const child = new FakeChild(); children.push(child); return child; },
    createChannel: () => ({ port1: 'a', port2: 'b' }),
    modulePath: '/app/app/runtime.mjs',
    env: {},
    token: TOKEN,
    app: APP,
    handle: async request => { handled.push(request); return { ok: true }; },
    onStatus: status => statuses.push(status),
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => { timers.delete(id as number); },
  });
  const ready = (child: FakeChild) => child.receive({ type: 'ready', token: TOKEN, protocol: HOST_BRIDGE_PROTOCOL });
  const ask = (child: FakeChild, id: number, op: string, args: unknown = {}) => child.receive({ id, type: 'host', op, args });
  return { host, children, statuses, handled, timers, ready, ask };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('runtime.restart: answered before the shutdown, then a new runtime at once (no backoff)', async () => {
  const h = harness();
  h.host.start();
  const first = h.children[0];
  h.ready(first);
  h.ask(first, 7, 'runtime.restart');
  assert.deepEqual(first.posted.at(-2), { id: 7, type: 'host-result', ok: true, result: { ok: true } }, 'the reply goes out first');
  assert.deepEqual(first.posted.at(-1), { type: 'shutdown', reason: 'quit' });
  assert.equal(h.handled.length, 0, 'host services never see the op');
  assert.equal(h.host.connect('desktop'), null, 'no ports while the old runtime drains');

  first.exit(0);
  await tick();
  assert.deepEqual(h.statuses.map(status => status.state), ['starting', 'up', 'restarting', 'starting']);
  assert.deepEqual(h.statuses[2], { state: 'restarting', inMs: 0 });
  assert.equal(h.children.length, 2, 'started again without waiting for a backoff timer');
  h.ready(h.children[1]);
  assert.equal(h.host.isUp, true);
  assert.equal(h.statuses.at(-1)!.state, 'up');

  // A second request while one restart runs is the same restart.
  h.ask(h.children[1], 8, 'runtime.restart');
  const again = h.host.restart();
  h.children[1].exit(0);
  await again;
  assert.equal(h.children.length, 3);
});

test('runtime.restart: a quit during the restart wins – nothing is started again', async () => {
  const h = harness();
  h.host.start();
  h.ready(h.children[0]);
  const restarting = h.host.restart();
  const quitting = h.host.stop('quit');
  h.children[0].exit(0);
  await Promise.all([restarting, quitting]);
  assert.equal(h.children.length, 1);
  assert.equal(h.statuses.at(-1)!.state, 'stopped');

  // After a crash with a pending backoff, a restart starts at once and drops the timer.
  const c = harness();
  c.host.start();
  c.ready(c.children[0]);
  c.children[0].exit(1);
  assert.equal(c.statuses.at(-1)!.state, 'restarting');
  await c.host.restart();
  assert.equal(c.children.length, 2);
  for (const { fn } of [...c.timers.values()]) fn(); // a leftover timer would fork a third process
  assert.equal(c.children.length, 2);
});

test('runtime.booting: a start that applies a restore gets the longer wait for ready, once', () => {
  const h = harness();
  h.host.start();
  const child = h.children[0];
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [30_000]);
  h.ask(child, 3, 'runtime.booting', { reason: 'restore' });
  assert.deepEqual(child.posted.at(-1), { id: 3, type: 'host-result', ok: true, result: { ok: true } });
  assert.deepEqual([...h.timers.values()].map(timer => timer.ms), [RESTORE_BOOT_MS], 'the boot timer was re-armed');
  h.ready(child);
  assert.equal(h.timers.size, 0);
  h.ask(child, 4, 'runtime.booting', { reason: 'restore' }); // after ready: answered, nothing armed
  assert.equal(h.timers.size, 0);

  // The longer wait still ends: a runtime that never gets ready is restarted.
  const slow = harness();
  slow.host.start();
  slow.ask(slow.children[0], 1, 'runtime.booting', { reason: 'restore' });
  for (const { fn } of [...slow.timers.values()]) fn();
  assert.equal(slow.children[0].killed, true);
});

test('host services refuse the runtime.* ops (RuntimeHost answers them)', async () => {
  const services = new HostServices({} as HostServicesDeps);
  for (const op of ['runtime.restart', 'runtime.booting'] as const) {
    await assert.rejects(services.handle({ id: 1, type: 'host', op, args: {} } as HostRequest), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
  }
});

test('electron host: restart and extendBoot are host-bridge calls; a failing extendBoot is ignored', async () => {
  const posted: Array<{ id: number; op: string; args: unknown }> = [];
  const bridge = new HostBridgeClient({ postMessage: message => posted.push(message as { id: number; op: string; args: unknown }) });
  const host = createElectronHost(bridge, APP);
  const restarted = host.restart!();
  assert.deepEqual({ op: posted[0].op, args: posted[0].args }, { op: 'runtime.restart', args: {} });
  bridge.resolve({ id: posted[0].id, type: 'host-result', ok: true, result: { ok: true } });
  await restarted;

  const extended = host.extendBoot!('restore');
  assert.deepEqual({ op: posted[1].op, args: posted[1].args }, { op: 'runtime.booting', args: { reason: 'restore' } });
  bridge.resolve({ id: posted[1].id, type: 'host-result', ok: false, error: { code: 'bad_request', message: 'Unknown host operation.' } });
  await extended; // an older main without the op: the start goes on with the normal wait
  bridge.close();
});
