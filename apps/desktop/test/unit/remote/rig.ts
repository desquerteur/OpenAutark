// Test rig for connect requests: PCs in one process, each with its identity, DeviceMesh (dials go
// nowhere – only what the connect flow stores matters) and RemoteService; POSTs go straight to the
// other PC's handler (JSON round trip), LAN hello probes to a shared fake LAN, timers are fired by hand.
// Owns: the rig only.

import { DeviceIdentity } from '../../../src/runtime/devices/identity.ts';
import { DeviceMesh } from '../../../src/runtime/devices/mesh.ts';
import { DevicesRepo } from '../../../src/runtime/devices/repo.ts';
import type { Candidate, HelloAnswer } from '../../../src/runtime/devices/discovery.ts';
import { RemoteService } from '../../../src/runtime/remote/service.ts';
import type { Timers } from '../../../src/runtime/remote/requests.ts';
import type { RemoteIncoming, RemoteState } from '../../../src/shared/model/remote.ts';
import { ManualClock, fakeHost, memoryDb, recordingBus, silentLog } from '../devices/fakes.ts';

/** One-shot timers fired by hand. */
export class HandTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): unknown { const id = this.next++; this.pending.set(id, { fn, ms }); return id; }
  clear(handle: unknown): void { this.pending.delete(handle as number); }
  /** Runs the timers set for at most `ms`. */
  fire(ms: number): void { for (const [id, timer] of [...this.pending]) if (timer.ms <= ms) { this.pending.delete(id); timer.fn(); } }
}

export interface Pc {
  name: string;
  address: string;
  identity: DeviceIdentity;
  mesh: DeviceMesh;
  remote: RemoteService;
  repo: DevicesRepo;
  clock: ManualClock;
  timers: HandTimers;
  paired: Array<{ id: string; side: 'joiner' | 'inviter'; personId?: string }>;
  states: RemoteState[];
  shown: RemoteIncoming[];
  /** The notices once a PC is linked here (RemoteDeps.linked). */
  notes: Array<{ title: string; body: string }>;
  /** The people whose employee PC was accepted here (RemoteDeps.admitted). */
  admitted: string[];
  findable: boolean;
  hello?: HelloAnswer;
  /** Who POSTs arrive from (the target's per-address limit). */
  from: string;
  /** POSTs from this PC that get lost on the way (a network failure). */
  drop?: (body: Record<string, unknown>) => boolean;
  /** Every POST this PC sent (kinds). */
  sent: string[];
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

export class Lan {
  readonly pcs = new Map<string, Pc>();

  /** `linked: false`: no linked notice wired (a composition without it still links). */
  async add(name: string, address: string, options: { findable?: boolean; linked?: false } = {}): Promise<Pc> {
    const db = memoryDb();
    const bus = recordingBus().bus;
    const clock = new ManualClock();
    const identity = await DeviceIdentity.load({ db, host: fakeHost(), clock, name });
    const timers = new HandTimers();
    const mesh = new DeviceMesh({ db, identity, clock, log: silentLog, bus, timers, dial: async () => { throw new Error('no network in this rig'); } });
    mesh.updateSelf({ addresses: [address] });
    const pc = { name, address, identity, mesh, repo: new DevicesRepo(db), clock, timers, paired: [], states: [], shown: [], notes: [], admitted: [], sent: [], findable: options.findable ?? true, from: address.replace(/^http:\/\/|:\d+$/g, '') } as unknown as Pc;
    const add = mesh.add.bind(mesh);
    mesh.add = (info, opts) => { pc.paired.push({ id: info.id, side: opts.side, ...(opts.personId ? { personId: opts.personId } : {}) }); return add(info, opts); };
    bus.on('remote.updated', (state) => pc.states.push(state));
    pc.remote = new RemoteService({
      identity, clock, bus, log: silentLog, mesh, timers,
      findable: () => pc.findable,
      responder: { answer: (hello) => { pc.hello = hello; } },
      lan: async () => [...this.pcs.values()].filter((other) => other !== pc && other.hello).map((other) => other.hello!()).filter((found): found is Candidate => Boolean(found)),
      notify: (view) => pc.shown.push(view),
      admitted: (personId) => { pc.admitted.push(personId); },
      ...(options.linked === false ? {} : { linked: (note: { title: string; body: string }) => { pc.notes.push(note); } }),
      post: async (target, body) => {
        const other = [...this.pcs.values()].find((entry) => entry.address === target);
        pc.sent.push(String((body as { kind?: unknown }).kind));
        if (!other || pc.drop?.(body as Record<string, unknown>)) throw new Error('unreachable');
        return JSON.parse(JSON.stringify(await other.remote.handle(JSON.parse(JSON.stringify(body)), { address: pc.from })));
      },
      wellKnownAt: async (target) => {
        const other = [...this.pcs.values()].find((entry) => entry.address === target);
        return other ? other.remote.wellKnown() : undefined;
      },
    });
    pc.remote.refresh();
    this.pcs.set(address, pc);
    return pc;
  }
}

export const linkedIds = (pc: Pc) => pc.repo.list({ kinds: ['pc'] }).filter((device) => !device.self && device.status !== 'revoked').map((device) => device.id);
