// Start and stop steps of the runtime composition root (main.ts), kept apart so tests can run
// them without a whole runtime: the staged restore before the database opens – with the
// workspace, so a backup's skills come back too (MM8) – and the stop order at shutdown, where
// each step runs on its own (a failing step is logged and the rest still runs). The stop closes
// the open sign-in processes and windows (AccountServiceImpl.dispose, PR4) before the database. The subconscious's
// waiting runs run right after the dispatcher (no new turns), capped, so nothing a chat just said is lost.
// Owns: the restore call at start and the stop order. Never: business logic, timers, polling or
// starting anything.

import type { Logger, Paths } from '../contracts.ts';
import type { Host } from '../host.ts';
import { applyPendingRestore, restorePending } from '../portability/restore.ts';
import type { Network } from './network.ts';
import { stopCalls } from '../calls/wiring.ts';
import { stopCalendar } from './calendar.ts';
import { stopChatMirror } from './chat-files.ts';
import type { Core } from './services.ts';

/**
 * Applies a restore staged by system.restore (before createCore opens the database); true when
 * applied (applyPendingRestore logs the outcome with its details). Never throws.
 */
export async function restoreAtStart(paths: Pick<Paths, 'data' | 'workspace'>, log: Logger, host: Pick<Host, 'extendBoot'>): Promise<boolean> {
  // MM7: copying a large backup in may take longer than the host's normal wait for 'ready'.
  if (restorePending(paths.data)) await host.extendBoot?.('restore').catch(() => undefined);
  let applied = false;
  try {
    applied = applyPendingRestore(paths.data, log, { workspace: paths.workspace });
  } catch (error) {
    log.error('staged restore failed', { error: String(error) });
  }
  return applied;
}

/** How long the stop waits for the subconscious's waiting runs (the host kills the runtime after 8 s). */
export const SUBCONSCIOUS_STOP_MS = 4000;

/** Runs the subconscious's runs still waiting for a quiet chat now; a slow helper call is not waited for beyond the cap. */
async function settleSubconscious(services: Core['services']): Promise<void> {
  const settle = (services.subconscious as { settle?: () => Promise<void> } | undefined)?.settle;
  if (!settle) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([settle.call(services.subconscious), new Promise<void>((resolve) => { timer = setTimeout(resolve, SUBCONSCIOUS_STOP_MS); })]).finally(() => clearTimeout(timer));
}

export interface StopStep {
  name: string;
  run(): unknown;
}

/**
 * Stop order: the dispatcher first (no new turns), the subconscious's waiting runs, then realtime calls and My day, sign-ins, timers,
 * watchers and bridges, the client-facing servers with the device connections (meeting server, LAN
 * answers) before the peer listener, the mesh, engines and child processes, the file owners of the data
 * folder before its watcher, and the database last.
 */
export function stopSteps(core: Core, network: Network): StopStep[] {
  const s = core.services;
  return [
    { name: 'dispatcher', run: () => core.dispatcher.stop() },
    { name: 'subconscious', run: () => settleSubconscious(s) }, // 01.11.2026: the chats' waiting runs run now instead of being lost
    { name: 'calls', run: () => stopCalls(s) }, // realtime sessions close
    { name: 'my day', run: () => stopCalendar(s) }, // B-041: morning timer, keep-awake hold and calendar sync stop before the engines
    { name: 'account monitor', run: () => core.accountMonitor.stop() },
    { name: 'sign-ins', run: () => s.accounts.dispose?.() },
    { name: 'apps', run: () => s.apps?.stop() }, // connector sign-ins and the connectors watcher end, connections and servers close
    { name: 'mcp', run: () => core.mcp.close() },
    { name: 'scheduler', run: () => core.scheduler.stop() }, // B-044: awaits the last next-due.json write (no temp file left)
    { name: 'catalog', run: () => core.catalog.stop() },
    { name: 'bridges', run: () => network.bridges.stop() },
    { name: 'browser', run: () => network.browser.close?.() },
    { name: 'computer', run: () => network.computer.dispose?.() },
    { name: 'rpc', run: () => network.rpc.close() },
    { name: 'devices', run: () => network.devices?.stop() }, // the meeting server connection, connect requests and LAN answers
    { name: 'peer', run: () => network.peer.close() },
    { name: 'http', run: () => network.http.close() },
    { name: 'mesh', run: () => core.mesh.close() },
    { name: 'engines', run: () => core.engines.dispose() },
    { name: 'processes', run: () => core.supervisor.killAll() },
    { name: 'data lifecycle', run: () => s.dataLifecycle?.stop() }, // no retention pass after this
    { name: 'data folder maps', run: () => s.rootMaps?.stop() }, // B-044: README.md / agents/README.md follow the team no longer
    { name: 'chat mirror', run: () => stopChatMirror(s) }, // B-050 K8: pending chat folder writes finish; the backfill resumes at the next start
    { name: 'memory', run: () => core.knowledge?.stopMemory?.() }, // <data>/memory leaves the data folder watcher
    { name: 'vectors', run: () => s.vectors?.stop?.() }, // no more background embedding; the local model's worker ends
    { name: 'secret files', run: () => s.secretFiles?.stop() }, // B-044: <data>/secrets leaves the data folder watcher
    { name: 'settings file', run: () => s.settings?.close?.() }, // B-044: settings.json leaves the data folder watcher
    { name: 'agent core', run: () => s.agentCore?.stop() }, // wave 3: the agent folders (SYSTEM.md, Main Skills) leave the data folder watcher
    { name: 'data folder', run: () => s.rootWatcher?.stop() }, // B-044: the one watcher on <data> (theme.css, connectors …), after its owners
    { name: 'database', run: () => s.db.close() },
  ];
}

/** Runs the steps one after another, each awaited; a failure is logged and the next step runs. */
export async function runStopSteps(steps: readonly StopStep[], log: Logger): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      log.warn('shutdown step failed', { step: step.name, error: String(error) });
    }
  }
}
