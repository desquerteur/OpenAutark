// The device mesh that keeps linked PCs connected (devices/mesh.ts): a PC the connect flow proved is
// stored with `add` and dialed; every PC is home of its own data, linked PCs are peers; an employee's
// PC reaches only the open methods; current addresses travel over the link. In-process socket pairs
// and manual backoff timers – no network, no real timers (nothing is left scheduled that a test
// does not fire itself).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh, EVERY_LINK, type Timers } from '../../../src/runtime/devices/mesh.ts';
import { socketPair, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { Device } from '../../../src/shared/model/devices.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from './fakes.ts';

type ManualTimers = Timers & { fire(): void; count(): number; delays: number[] };

interface Node {
  name: string;
  address: string;
  identity: DeviceIdentity;
  mesh: DeviceMesh;
  db: ReturnType<typeof memoryDb>;
  events: Array<{ event: string; data: unknown }>;
  timers: ManualTimers;
  /** Simulates a PC that is switched off: dials to it fail. */
  down: boolean;
  /** Holds this PC's dials until it resolves (a slow network). */
  hold?: Promise<void>;
  /** Drops this PC's last dialed link the way sleep does: the other end closes, this end never hears. */
  cut?: () => void;
}

const nodes = new Map<string, Node>();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function manualTimers(): ManualTimers {
  const queue = new Map<number, () => void>();
  let next = 0;
  const delays: number[] = [];
  return {
    delays,
    set: (fn, ms) => { delays.push(ms); queue.set(++next, fn); return next; },
    clear: (handle) => { queue.delete(handle as number); },
    fire: () => { const fns = [...queue.values()]; queue.clear(); fns.forEach((fn) => fn()); },
    count: () => queue.size,
  };
}

async function makeNode(name: string, address: string): Promise<Node> {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const { bus, events } = recordingBus();
  const timers = manualTimers();
  const identity = await DeviceIdentity.load({ db, host, clock, name });
  const mesh = new DeviceMesh({
    db, identity, clock, log: silentLog, bus, timers,
    dial: async (target) => {
      const self = nodes.get(address)!;
      await self.hold;
      const remote = nodes.get(target);
      if (!remote || remote.down) throw new Error('unreachable');
      const [raw, theirs] = socketPair();
      let cut = false;
      self.cut = () => { cut = true; theirs.close(); };
      const mine: SocketLike = { ...raw, onClose: (listener) => raw.onClose((code) => { if (!cut) listener(code); }) };
      void remote.mesh.accept(theirs).catch(() => {});
      return mine;
    },
  });
  mesh.updateSelf({ addresses: [address] });
  const node: Node = { name, address, identity, mesh, db, events, timers, down: false };
  nodes.set(address, node);
  return node;
}

/** Laptop accepted Tower's connect request (remote/*): both store each other, Tower dials (`connectOnPair: false`: stored only); `low`/`high` order them by device id. */
async function linkedPair(options: { personOfTower?: string; connectOnPair?: boolean } = {}) {
  nodes.clear();
  const a = await makeNode('Laptop', 'http://10.0.0.1:47811');
  const b = await makeNode('Tower', 'http://10.0.0.2:47811');
  if (options.connectOnPair === false) {
    // Stored, never dialed (as after a restart before start()).
    const store = (node: Node, other: Node) => new DevicesRepo(node.db).upsert({
      id: idOf(other), name: other.name, kind: 'pc', role: 'home', fingerprint: other.identity.fingerprint, publicKey: other.mesh.selfInfo().pub,
      addresses: [other.address], caps: {}, status: 'offline', self: false, pairedAt: 0, lastSeenAt: 0,
    });
    store(a, b);
    store(b, a);
  } else {
    a.mesh.add(b.mesh.selfInfo(), { side: 'inviter', ...(options.personOfTower ? { personId: options.personOfTower } : {}) });
    b.mesh.add(a.mesh.selfInfo(), { side: 'joiner' });
  }
  await settle();
  const [low, high] = a.identity.deviceId < b.identity.deviceId ? [a, b] : [b, a];
  return { a, b, low, high };
}

const idOf = (node: Node) => node.identity.deviceId;
const statusOf = (node: Node, other: Node) => node.mesh.list().find((device) => device.id === idOf(other))?.status;
const linkedBoth = (x: Node, y: Node) => x.mesh.online(idOf(y)) && y.mesh.online(idOf(x));

test('identity: private key is stored encrypted, reloads to the same device, and every PC is home', async () => {
  const db = memoryDb();
  const host = fakeHost();
  const clock = new ManualClock();
  const first = await DeviceIdentity.load({ db, host, clock, name: 'Desk' });
  const stored = new KvRepo(db).get<{ privateCipher: string }>('device', 'identity')!;
  assert.ok(Buffer.from(stored.privateCipher, 'base64').toString().startsWith('enc:'));
  const again = await DeviceIdentity.load({ db, host, clock });
  assert.equal(again.deviceId, first.deviceId);
  assert.equal(again.fingerprint, first.fingerprint);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(new DevicesRepo(db).get(first.deviceId)?.role, 'home');
});

test('mesh: encrypted JSON-RPC call between paired devices, unknown device rejected', async () => {
  const { a, b } = await linkedPair();
  a.mesh.register('echo', async (params, from) => ({ params, from }));
  const result = (await b.mesh.call(a.identity.deviceId, 'echo', { x: 1 })) as { params: unknown; from: string };
  assert.deepEqual(result.params, { x: 1 });
  assert.equal(result.from, b.identity.deviceId);
  await assert.rejects(b.mesh.call(a.identity.deviceId, 'nope', {}), /Unknown peer method/);

  // A stranger with no pairing record cannot connect.
  const c = await makeNode('Stranger', 'http://10.0.0.3:47811');
  const [mine, theirs] = socketPair();
  const accepted = a.mesh.accept(theirs);
  const { connectSecure } = await import('../../../src/runtime/devices/channel.ts');
  const signer = { deviceId: c.identity.deviceId, publicKey: c.identity.publicKey, sign: (d: Uint8Array) => c.identity.sign(d) };
  await assert.rejects(connectSecure(mine, signer, a.identity.fingerprint));
  await assert.rejects(accepted, /Unknown device/);
});

test('after pairing both PCs are online without any call, and nothing stays scheduled', async () => {
  const { a, b } = await linkedPair();
  assert.ok(linkedBoth(a, b));
  assert.equal(statusOf(a, b), 'online');
  assert.equal(statusOf(b, a), 'online');
  assert.equal(a.timers.count() + b.timers.count(), 0, 'the inviter\'s fallback retry ended with the joiner\'s link');
  const seen = b.events.filter((entry) => entry.event === 'device.upserted' && (entry.data as { id: string }).id === idOf(a)).map((entry) => (entry.data as { status: string }).status);
  assert.deepEqual(seen.slice(-2), ['connecting', 'online']);
});

test('a dropped link: only the lower id retries, once, with backoff – then it reconnects', async () => {
  const { low, high } = await linkedPair();
  (await low.mesh.connect(idOf(high))).channel.close();
  await settle();
  assert.equal(linkedBoth(low, high), false);
  assert.equal(statusOf(high, low), 'offline');
  assert.equal(low.timers.count(), 1, 'exactly one retry on the lower id');
  assert.equal(high.timers.count(), 0, 'the higher id waits (no polling)');
  assert.equal(low.timers.delays.at(-1), 1_000);

  high.down = true;
  low.timers.fire();
  await settle();
  assert.equal(statusOf(low, high), 'offline');
  assert.equal(low.timers.count(), 1);
  assert.equal(low.timers.delays.at(-1), 2_000, 'the next step backs off');

  // B-077: the backoff stops growing at 30 s – a PC that is back is linked within about 30 s, never after minutes.
  for (let i = 0; i < 8; i++) { low.timers.fire(); await settle(); }
  assert.equal(low.timers.delays.at(-1), 30_000);
  assert.ok(low.timers.delays.every((ms) => ms <= 30_000), low.timers.delays.join());

  high.down = false;
  low.timers.fire();
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.equal(low.timers.count() + high.timers.count(), 0);
});

test('B-077: network errors and code-less tunnel closes are retryable; only 4003 is refusal', async () => {
  const { openChannel } = await import('../../../src/runtime/devices/reach.ts');
  const signer = (await makeNode('Solo', 'http://10.9.9.9:1')).identity;
  // The other end closes right after our hello, before any answer – with this code.
  const closing = (code?: number) => async (): Promise<SocketLike> => {
    const listeners: Array<(code?: number) => void> = [];
    return {
      send: () => { queueMicrotask(() => listeners.forEach((listener) => listener(code))); },
      close: () => {},
      onMessage: () => {},
      onClose: (listener) => { listeners.push(listener); },
    };
  };
  const sign = { deviceId: signer.deviceId, publicKey: signer.publicKey, sign: (data: Uint8Array) => signer.sign(data) };
  for (const [code, refused] of [[1006, false], [4000, false], [4003, true], [undefined, false]] as const) {
    const result = await openChannel([closing(code)], sign, 'fp');
    assert.ok(!('channel' in result));
    assert.equal(result.refused, refused, `close code ${code}`);
  }
});

test('revoke stops: the revoking PC never retries, the revoked one is refused', async () => {
  const { low, high } = await linkedPair();
  low.mesh.revoke(idOf(high));
  await settle();
  assert.equal(low.timers.count() + high.timers.count(), 0);
  assert.ok(low.mesh.list().every((item) => item.id !== idOf(high))); // revoked devices are hidden
  low.mesh.reconnect(); // a resume on the revoking PC does not dial it again
  await assert.rejects(high.mesh.call(idOf(low), 'ping', {}), /Laptop is not reachable|Tower is not reachable/);
  await settle();
  assert.equal(linkedBoth(low, high), false);

  const other = await linkedPair();
  other.high.mesh.revoke(idOf(other.low));
  await settle();
  assert.equal(other.high.timers.count(), 0);
  assert.equal(other.low.timers.count(), 1, 'the lower id cannot know yet: one retry after the close');
  other.low.timers.fire(); // the handshake is refused
  await settle();
  assert.equal(linkedBoth(other.low, other.high), false);
  assert.equal(statusOf(other.low, other.high), 'offline');
  assert.equal(other.low.timers.count(), 0, 'a refusal ends the backoff: no polling of a PC that unlinked this one');
  other.low.mesh.reconnect(); // a trigger still dials once
  await settle();
  assert.equal(other.low.timers.count(), 0);
});

test('start and resume dial at once: no waiting for the other side\'s backoff', async () => {
  const { low, high } = await linkedPair({ connectOnPair: false });
  assert.equal(statusOf(high, low), 'connecting', 'paired but never dialed is not offline');
  high.mesh.start(); // the higher id dials at start too
  await settle();
  assert.ok(linkedBoth(low, high));

  (await high.mesh.connect(idOf(low))).channel.close();
  await settle();
  assert.equal(low.timers.count(), 1);
  high.mesh.reconnect(); // host power 'resume' / 'unlock' (main.ts)
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.equal(low.timers.count(), 0, 'the pending retry ended with the new link');
});

test('resume pings live links: a link that died while this PC slept is closed and dialed again', async () => {
  const { low, high } = await linkedPair({ connectOnPair: false });
  low.mesh.start(); // the lower id holds the dialing end (B-077: it pings too now; here no keepalive runs, the trigger's ping does the work)
  await settle();
  const before = await low.mesh.connect(idOf(high));
  low.mesh.reconnect(); // a healthy link answers the ping and stays
  await settle();
  assert.equal(low.timers.count(), 0);
  assert.equal(await low.mesh.connect(idOf(high)), before);

  low.cut!(); // the other PC's keepalive ended it while this one slept
  await settle();
  assert.equal(statusOf(high, low), 'offline');
  assert.equal(statusOf(low, high), 'online', 'the dialing side has not noticed');
  assert.equal(high.timers.count(), 0, 'the higher id does not retry');
  low.mesh.reconnect(); // host resume
  await settle();
  assert.equal(low.timers.count(), 1, 'only the ping timeout is scheduled');
  low.timers.fire(); // no answer
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.notEqual(await low.mesh.connect(idOf(high)), before);
  assert.equal(low.timers.count() + high.timers.count(), 0);
});

test('both sides dialing at once end with one working link', async () => {
  const { low, high } = await linkedPair({ connectOnPair: false });
  await Promise.all([low.mesh.connect(idOf(high)), high.mesh.connect(idOf(low))]);
  await settle();
  assert.ok(linkedBoth(low, high));
  assert.deepEqual(await high.mesh.call(idOf(low), 'ping', {}).then((reply) => (reply as { ok: boolean }).ok), true);
  assert.deepEqual(await low.mesh.call(idOf(high), 'ping', {}).then((reply) => (reply as { ok: boolean }).ok), true);
  assert.equal(low.timers.count() + high.timers.count(), 0);
});

function registryOn(node: Node): Registry {
  const services = {
    devices: node.mesh,
    modes: { get: () => { throw new Error('no modes in this test'); } },
    permissions: { check: async () => ({ effect: 'allow' }) },
    runs: { item: () => ({ id: 'ri_1' }), updateItem: () => undefined },
    db: { get: () => undefined },
    secrets: { redact: (text: string) => text },
    files: { put: async () => ({ id: 'file_1' }) },
    log: silentLog,
  } as unknown as RuntimeServices;
  const registry = new Registry({ services: () => services });
  const peek: ToolDef = {
    name: 'screen.peek', description: 'peek', inputSchema: { type: 'object' }, category: 'read', remote: true,
    describe: () => ({ summary: 'Peek at the screen', reversible: true, external: true }),
    run: async () => { throw new Error('must run on the linked PC'); },
  };
  registry.register(peek);
  return registry;
}

test('registry: a call to a paired PC without a live link dials it; an unreachable PC is a plain failure', async () => {
  const { a, b } = await linkedPair({ connectOnPair: false });
  assert.equal(b.mesh.online(idOf(a)), false);
  a.mesh.register('tools.call', async (params) => ({ content: [{ type: 'text', text: `ran ${(params as { name: string }).name}` }] }));
  const registry = registryOn(b);
  const ctx = { agent: { id: 'ag_1', name: 'Ada' } as Agent, runId: 'run_1', mode: 'computer', deviceId: idOf(a), signal: new AbortController().signal, status: () => undefined };
  const out = await registry.call('screen.peek', {}, ctx, 'call_1');
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.content, [{ type: 'text', text: 'ran screen.peek' }]);
  assert.ok(b.mesh.online(idOf(a)));

  (await b.mesh.connect(idOf(a))).channel.close();
  a.down = true;
  await settle();
  const failed = await registry.call('screen.peek', {}, ctx, 'call_2');
  assert.equal(failed.isError, true);
  assert.match((failed.content[0] as { text: string }).text, /^Laptop is not reachable \(last seen just now\)\.$/);
  assert.equal(failed.effect, undefined, 'nothing was sent: no unknown effect');
});

test('a call stopped while dialing returns at once and never reaches the linked PC', async () => {
  const { a, b } = await linkedPair({ connectOnPair: false });
  let ran = 0;
  a.mesh.register('tools.call', async () => { ran++; return { content: [{ type: 'text', text: 'clicked' }] }; });
  let release!: () => void;
  b.hold = new Promise((resolve) => { release = resolve; });
  const controller = new AbortController();
  const ctx = { agent: { id: 'ag_1', name: 'Ada' } as Agent, runId: 'run_1', mode: 'computer', deviceId: idOf(a), signal: controller.signal, status: () => undefined };
  const pending = registryOn(b).call('screen.peek', {}, ctx, 'call_1');
  await settle();
  assert.equal(statusOf(b, a), 'connecting');
  controller.abort(); // Stop, while the dial still waits
  const out = await Promise.race([pending, settle().then(() => undefined)]);
  assert.ok(out, 'the stopped call returns without waiting for the dial');
  assert.equal(out.isError, true);
  assert.equal((out.content[0] as { text: string }).text, 'Cancelled.');
  assert.equal(out.effect, undefined, 'nothing was sent: no unknown effect');
  await assert.rejects(b.mesh.call(idOf(a), 'tools.call', {}, controller.signal), /Cancelled/);
  release();
  await settle();
  assert.ok(linkedBoth(a, b), 'the dial finished in the background');
  assert.equal(ran, 0, 'the tool never ran on the linked PC');
});

test('an employee\'s PC reaches only the open methods here; the CEO\'s own PC reaches everything', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'per_anna' });
  a.mesh.register('tools.call', async () => ({ ok: true }));
  b.mesh.register('tools.call', async () => ({ ok: true }));
  assert.equal(a.mesh.list().find((device) => device.id === idOf(b))?.personId, 'per_anna');
  await assert.rejects(b.mesh.call(idOf(a), 'tools.call', {}), /employee/);
  assert.deepEqual(await a.mesh.call(idOf(b), 'tools.call', {}), { ok: true }, 'the CEO\'s PC runs tools on the employee\'s PC');
  assert.equal(((await b.mesh.call(idOf(a), 'ping', null)) as { ok: boolean }).ok, true, 'ping stays open');
});

test('B-078 the one registration hook: a module opens its method to the link kinds it names (e.g. calendar.ask); default stays closed to employees', async () => {
  const { a, b } = await linkedPair({ personOfTower: 'per_anna' });
  a.mesh.register('calendar.ask', async (_params, from) => ({ from }), EVERY_LINK);
  a.mesh.register('only.mine', async () => ({ ok: true }), ['ceo']);
  b.mesh.register('only.mine', async () => ({ ok: true }), ['ceo']);
  assert.deepEqual(await b.mesh.call(idOf(a), 'calendar.ask', {}), { from: idOf(b) }, 'the employee\'s PC reaches an open method');
  await assert.rejects(b.mesh.call(idOf(a), 'only.mine', {}), /employee's PC does not run/);
  new DevicesRepo(b.db).patch(idOf(a), { joinedAs: 'employee' }); // the Tower joined the Laptop's company as an employee
  await assert.rejects(a.mesh.call(idOf(b), 'only.mine', {}), /This link does not run that method/, 'a method for my own PCs only: not for an employer either');
});

test('addresses travel over the link: a new own address reaches the online PC', async () => {
  const { a, b } = await linkedPair();
  a.mesh.updateSelf({ addresses: ['http://192.168.7.7:47811'] });
  await settle();
  assert.equal(b.mesh.list().find((device) => device.id === idOf(a))?.addresses[0], 'http://192.168.7.7:47811');
});

test('one key, one device: a new id with the key of a linked PC, or of this PC itself, is refused', async () => {
  const { a, b } = await linkedPair();
  const theirs = { ...b.mesh.selfInfo(), id: 'dev_impostor0001', name: 'Impostor' };
  assert.throws(() => a.mesh.add(theirs, { side: 'joiner', personId: 'per_y' }), /already belongs to another device/);
  const mine = { ...a.mesh.selfInfo(), id: 'dev_impostor0002', name: 'Me again' };
  assert.throws(() => b.mesh.add(mine, { side: 'joiner' }), /already belongs to another device/, 'b knows a by that key');
  assert.equal(new DevicesRepo(a.db).get('dev_impostor0001'), undefined, 'nothing stored');
});
