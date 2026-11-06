// The fake mesh of the row sync tests (sync-rows*.test.ts): in-memory PCs (the chat harness each) whose calls pass
// JSON like the real channel; `up` takes every link down at once.

import { harness } from '../chat/harness.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { DevicesRepo, type DeviceRecord } from '../../../src/runtime/devices/repo.ts';
import { RowSync } from '../../../src/runtime/devices/sync/rows.ts';
import { Stamps } from '../../../src/runtime/devices/sync/stamps.ts';
import type { DeviceService } from '../../../src/runtime/contracts.ts';

export const record = (id: string, extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  id, name: id, kind: 'pc', role: 'home', fingerprint: `fp_${id}`, addresses: [], caps: {}, status: 'online', self: false, ...extra,
});

export class Net {
  readonly pcs = new Map<string, Pc>();
  up = true;
  readonly calls: Array<{ from: string; to: string; method: string; params: unknown }> = [];
}

export type Pc = ReturnType<typeof makePc>;

/** One PC on `net`; `flushMs`: how long its changes gather (0: at once, like before the gathering). */
export function makePc(net: Net, id: string, flushMs = 0) {
  const h = harness();
  const repo = new DevicesRepo(h.db);
  repo.upsert(record(id, { self: true }));
  const handlers = new Map<string, (params: unknown, from: string) => Promise<unknown>>();
  h.services.devices = {
    self: () => repo.self()!,
    list: () => repo.list(),
    online: (peer: string) => net.up && net.pcs.has(peer),
    call: async (peer: string, method: string, params: unknown) => {
      const target = net.pcs.get(peer);
      if (!net.up || !target) throw new WorkforceError('unavailable', 'offline');
      const copy = JSON.parse(JSON.stringify(params)) as unknown;
      net.calls.push({ from: id, to: peer, method, params: copy });
      return target.handlers.get(method)!(copy, id);
    },
  } as unknown as DeviceService;
  const sync = new RowSync(h.services, new Stamps(h.db, h.clock), flushMs);
  handlers.set('sync.rows', (params, from) => sync.receive(params, from));
  sync.attach();
  h.scheduler.start();
  const pc = { id, h, repo, sync, handlers };
  net.pcs.set(id, pc);
  return pc;
}

/** `b` joins `a` (as an employee of `person` when given). */
export function link(a: Pc, b: Pc, person?: string): void {
  a.repo.upsert(record(b.id, person ? { personId: person } : {}));
  b.repo.upsert(record(a.id, { joinedAs: person ? 'employee' : 'ceo', pairedAt: b.h.clock.now() }));
}

export const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
