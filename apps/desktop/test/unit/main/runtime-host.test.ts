import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeStatus } from '../../../src/shared/api/desktop.ts';
import type { AppInfo, HostRequest } from '../../../src/shared/api/host-bridge.ts';
import { HOST_BRIDGE_PROTOCOL } from '../../../src/shared/api/host-bridge.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { RuntimeHost } from '../../../src/main/runtime-host.ts';
import type { RuntimeChild } from '../../../src/main/runtime-host.ts';

const TOKEN = 'a'.repeat(64);
const APP: AppInfo = { version: '0.2.0', packaged: false, resourcesDir: '/app', dataDir: '/data', executable: '/electron' };

class FakeChild implements RuntimeChild {
  readonly stdout = null;
  readonly stderr = null;
  readonly posted: Array<{ message: unknown; transfer?: unknown[] }> = [];
  killed = false;
  private onMessage: ((message: unknown) => void) | null = null;
  private onExit: ((code: number) => void) | null = null;
  postMessage(message: unknown, transfer?: unknown[]) { this.posted.push({ message, transfer }); }
  on(event: 'message' | 'exit', listener: ((message: unknown) => void) | ((code: number) => void)) {
    if (event === 'message') this.onMessage = listener as (message: unknown) => void;
    else this.onExit = listener as (code: number) => void;
    return this;
  }
  kill() { this.killed = true; return true; }
  receive(message: unknown) { this.onMessage?.(message); }
  exit(code = 0) { this.onExit?.(code); }
  types() { return this.posted.map(entry => (entry.message as { type: string }).type); }
}

function harness(handle: (request: HostRequest) => Promise<unknown> = async () => ({ ok: true })) {
  const children: FakeChild[] = [];
  const statuses: RuntimeStatus[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let channel = 0;
  const host = new RuntimeHost<string>({
    fork: () => { const child = new FakeChild(); children.push(child); return child; },
    createChannel: () => { channel++; return { port1: `p${channel}a`, port2: `p${channel}b` }; },
    modulePath: '/app/app/runtime.mjs',
    env: {},
    token: TOKEN,
    app: APP,
    handle,
    onStatus: status => statuses.push(status),
    setTimer: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimer: id => { timers.delete(id as number); },
  });
  const ready = (child: FakeChild, token = TOKEN) => child.receive({ type: 'ready', token, protocol: HOST_BRIDGE_PROTOCOL });
  return { host, children, statuses, timers, ready };
}

test('runtime host: token in the init message, a wrong token is refused, ports wait for ready', () => {
  const h = harness();
  h.host.start();
  const child = h.children[0];
  assert.deepEqual(child.posted[0].message, { type: 'init', token: TOKEN, protocol: HOST_BRIDGE_PROTOCOL, app: APP });
  assert.equal(h.host.connect('desktop'), 'p1a', 'the caller gets port1 right away');
  assert.deepEqual(child.types(), ['init'], 'the hand-over waits for ready');
  h.ready(child, 'b'.repeat(64));
  assert.equal(child.killed, true, 'foreign runtime killed');
  assert.equal(h.host.isUp, false);

  const fresh = harness();
  fresh.host.start();
  fresh.host.connect('main');
  fresh.ready(fresh.children[0]);
  assert.equal(fresh.host.isUp, true);
  assert.deepEqual(fresh.children[0].posted[1], { message: { type: 'connect', client: 'main' }, transfer: ['p1b'] });
  assert.deepEqual(fresh.statuses.map(status => status.state), ['starting', 'up']);
});

test('runtime host: host requests are answered, errors keep their code', async () => {
  const h = harness(async request => {
    if (request.op === 'idleSeconds') return { seconds: 5 };
    throw new WorkforceError('forbidden', 'Only web and mail links can be opened.');
  });
  h.host.start();
  const child = h.children[0];
  h.ready(child);
  child.receive({ id: 1, type: 'host', op: 'idleSeconds', args: {} });
  child.receive({ id: 2, type: 'host', op: 'openExternal', args: { url: 'file:///x' } });
  child.receive({ id: 3, type: 'host', op: 'notAnOp', args: {} }); // malformed: ignored
  await new Promise(resolve => setImmediate(resolve));
  const results = child.posted.filter(entry => (entry.message as { type: string }).type === 'host-result').map(entry => entry.message);
  assert.deepEqual(results[0], { id: 1, type: 'host-result', ok: true, result: { seconds: 5 } });
  assert.equal((results[1] as { ok: boolean }).ok, false);
  assert.equal((results[1] as { error: { code: string } }).error.code, 'forbidden');
  assert.equal(results.length, 2);
});

test('runtime host: a crash restarts with backoff; stop drains; start works again after stop', async () => {
  const h = harness();
  h.host.start();
  h.ready(h.children[0]);
  h.children[0].exit(1);
  assert.deepEqual(h.statuses.at(-1), { state: 'restarting', inMs: 1000 });
  for (const [id, fn] of [...h.timers]) { h.timers.delete(id); fn(); } // backoff elapses
  assert.equal(h.children.length, 2, 'restarted');
  h.ready(h.children[1]);

  const stopped = h.host.stop('update');
  assert.equal(h.children[1].types().at(-1), 'shutdown');
  assert.equal(h.host.connect('desktop'), null, 'no ports while draining');
  h.host.start(); // still draining: no second process
  assert.equal(h.children.length, 2);
  h.children[1].exit(0);
  await stopped;
  assert.equal(h.statuses.at(-1)!.state, 'stopped');

  // An update restart was cancelled after the drain: the runtime comes back.
  h.host.start();
  assert.equal(h.children.length, 3);
  h.ready(h.children[2]);
  assert.equal(h.host.isUp, true);
  assert.ok(h.host.connect('desktop'));
});
