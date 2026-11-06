// RPC handlers: repair.state / repair.retry / repair.restore / repair.diagnostics (23.10.2026),
// owner only. The repair runtime (repair/server.ts) serves them with its RepairService
// (services.repair: the start problem it shows); on a normal runtime the same methods report
// "not in repair mode" with the copies from before updates and still write diagnostics, while
// retry and restore are refused there.
// Owns: the registration and which service answers. Never: the actions themselves.

import type { RuntimeServices } from '../../contracts.ts';
import { BootJournal } from '../../repair/journal.ts';
import { RepairService } from '../../repair/service.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const normal = new WeakMap<RuntimeServices, RepairService>();

/** The repair runtime's service, or one for a normal runtime (no problem: retry/restore refuse). */
export function repairOf(ctx: Pick<HandlerContext, 'services'>): RepairService {
  const s = ctx.services;
  if (s.repair) return s.repair;
  let service = normal.get(s);
  if (!service) {
    service = new RepairService({ dataDir: s.paths.data, version: s.host.app.version, host: s.host, journal: new BootJournal({ dataDir: s.paths.data }), now: () => s.clock.now(), log: s.log });
    normal.set(s, service);
  }
  return service;
}

export function register(table: HandlerTable): void {
  table.add('repair.state', (_params, ctx) => repairOf(ctx).state());
  table.add('repair.retry', (_params, ctx) => repairOf(ctx).retry());
  table.add('repair.restore', (params, ctx) => repairOf(ctx).restore(params?.id));
  table.add('repair.diagnostics', (_params, ctx) => repairOf(ctx).diagnostics());
}
