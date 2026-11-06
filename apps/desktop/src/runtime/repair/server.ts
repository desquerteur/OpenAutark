// The repair runtime (23.10.2026): what the runtime utility process runs instead of the full runtime
// when the start guard (repair/journal.ts) holds a problem for this version – no database, no
// agents, engines or HTTP server. It serves owner connections (the app window,
// main) with a handler table of only session.info and the repair.* methods, so the UI sees a
// session that can do nothing else and shows the repair screen.
// Owns: that small composition. Never: opens the database, starts any agent work, or listens on
// the network (phones and linked PCs reach this PC again after the repair).

import type { StartProblem } from '../../shared/model/repair.ts';
import type { Logger, RuntimeServices } from '../contracts.ts';
import type { Host } from '../host.ts';
import { Bus } from '../bus.ts';
import { systemClock } from '../system/clock.ts';
import type { RpcConnection } from '../rpc/connection.ts';
import type { RpcExtras } from '../rpc/extras.ts';
import { RpcServer } from '../rpc/server.ts';
import { HandlerTable } from '../rpc/table.ts';
import { register as registerRepair } from '../rpc/handlers/repair.ts';
import { register as registerSession } from '../rpc/handlers/session.ts';
import type { BootJournal } from './journal.ts';
import { RepairService } from './service.ts';

export interface RepairRuntimeOptions {
  dataDir: string;
  version: string;
  host: Host;
  journal: BootJournal;
  problem: StartProblem;
  log?: Logger;
}

export interface RepairRuntime {
  service: RepairService;
  /** Serves one owner connection (a MessagePort of the app window or main). */
  attach(connection: RpcConnection): () => void;
  close(): void;
}

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** The methods the repair runtime serves. */
export function repairTable(): HandlerTable {
  const table = new HandlerTable();
  registerRepair(table);
  registerSession(table);
  return table;
}

export function startRepairRuntime(options: RepairRuntimeOptions): RepairRuntime {
  const log = options.log ?? quiet;
  const service = new RepairService({ dataDir: options.dataDir, version: options.version, host: options.host, journal: options.journal, problem: options.problem, log });
  const bus = new Bus((error, event) => log.warn('bus listener failed', { event, error: String(error) }));
  // Only what the RPC server and the repair handlers read; every other service is missing on purpose.
  const services = { clock: systemClock, log, host: options.host, bus, paths: { data: options.dataDir }, repair: service } as unknown as RuntimeServices;
  const server = new RpcServer({ services: () => services, extras: () => ({}) as RpcExtras, table: repairTable(), log });
  log.info('repair mode', { code: options.problem.code, version: options.version });
  return {
    service,
    attach: (connection) => server.attach(connection, { kind: 'owner' }),
    close: () => server.close(),
  };
}
