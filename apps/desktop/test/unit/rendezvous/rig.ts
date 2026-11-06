// Test rig for the meeting server: two (or more) PCs with real device identities, meshes and Meeting
// services against the real self-hostable server (services/remote-relay) on loopback. Direct dials fail
// unless a test opens them (`reachable`); the connect flow is a small fake that records what arrives.
// No Electron, no runtime process.

import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh, type Timers } from '../../../src/runtime/devices/mesh.ts';
import { socketPair, type SocketLike } from '../../../src/runtime/devices/channel.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { b64url } from '../../../src/runtime/devices/keys.ts';
import { Meeting } from '../../../src/runtime/devices/rendezvous/service.ts';
import { systemClock } from '../../../src/runtime/system/clock.ts';
import { fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

export interface RelayHandle { port: number; url: string; stats(): { connections: number; devices: number; tunnels: number; pairs: number }; close(): Promise<void> }

/** The real server (TypeScript under services/, loaded by URL so the desktop typecheck stays apart; this package's `ws`). */
export async function startRelay(port = 0): Promise<RelayHandle> {
  const file = path.resolve(import.meta.dirname, '../../../../../services/remote-relay/src/relay.ts');
  const relay = await (await import(pathToFileURL(file).href)).createRelay({ port, host: '127.0.0.1', WebSocketServer });
  return { ...relay, port: relay.port, url: `ws://127.0.0.1:${relay.port}`, stats: () => relay.stats(), close: () => relay.close() };
}

export interface Pc {
  name: string;
  address: string;
  identity: DeviceIdentity;
  mesh: DeviceMesh;
  meeting: Meeting;
  db: ReturnType<typeof memoryDb>;
  relayUrl?: string;
  /** Direct dials to this PC work (else they fail like a blocked network). */
  reachable: boolean;
  /** Its peer listener port as told to the server. */
  port?: number;
  /** Addresses this PC dialed directly. */
  dialed: string[];
  handled: Array<{ body: unknown; address?: string }>;
  findable: boolean;
}

const noTimers: Timers = { set: () => 0, clear: () => {} }; // the mesh never retries on a timer here
const pcs = new Map<string, Pc>();

export async function makePc(name: string, relayUrl?: string): Promise<Pc> {
  const db = memoryDb();
  const { bus } = recordingBus();
  const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock: systemClock, name });
  const pc = { name, address: `http://${name.toLowerCase()}.test:47812`, identity, db, relayUrl, reachable: false, dialed: [], handled: [], findable: true } as unknown as Pc;
  const dial = async (address: string): Promise<SocketLike> => {
    pc.dialed.push(address);
    // The meeting server sees every PC on 127.0.0.1 here: its address names the port the PC told it.
    const target = pcs.get(address) ?? [...pcs.values()].find((other) => other.port && address === `http://127.0.0.1:${other.port}`);
    if (!target || !target.reachable) throw new Error('unreachable');
    const [mine, theirs] = socketPair();
    void target.mesh.accept(theirs).catch(() => undefined);
    return mine;
  };
  pc.mesh = new DeviceMesh({ db, identity, clock: systemClock, log: silentLog, bus, timers: noTimers, dial });
  pc.meeting = new Meeting({
    db, bus, log: silentLog, clock: systemClock, identity, mesh: pc.mesh,
    remote: {
      wellKnown: () => ({ deviceId: identity.deviceId, name, fingerprint: identity.fingerprint }),
      handle: async (body, from) => { pc.handled.push({ body, address: from.address }); return { ok: true, echo: body }; },
      kinds: new Set(['remote1', 'remote2', 'remote3', 'remoteCancel']),
    },
    relayUrl: () => pc.relayUrl,
    findable: () => pc.findable,
    port: () => pc.port,
  });
  pcs.set(pc.address, pc);
  return pc;
}

export function reset(): void { pcs.clear(); }

function record(of: Pc): DeviceRecord {
  return {
    id: of.identity.deviceId, name: of.name, kind: 'pc', role: 'home', fingerprint: of.identity.fingerprint, publicKey: b64url(of.identity.publicKey),
    addresses: [of.address], caps: {}, status: 'offline', self: false, pairedAt: 1,
  };
}

/** Pins both PCs on each other (what an accepted connect request stores). */
export function link(a: Pc, b: Pc): void {
  new DevicesRepo(a.db).upsert(record(b));
  new DevicesRepo(b.db).upsert(record(a));
}

export async function until<T>(read: () => T, ok: (value: T) => boolean, what: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function stopAll(list: Pc[]): void {
  for (const pc of list) { pc.meeting.stop(); pc.mesh.close(); }
}
