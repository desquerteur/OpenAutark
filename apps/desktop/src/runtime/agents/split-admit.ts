// B-057 S12 – the heavy supervisor slot of one turn attempt (turn-attempt.ts). A CLI engine runs processes and takes a
// slot; an HTTP turn is light and takes none. The agent's own turn holds its slot for the whole attempt, as before. A
// split's turn asks as background work (dispatch-runs.ts: the agents' own turns first, system/supervisor.ts), and on an
// engine with one persistent server per account (engine.warm/prewarm – the Codex app-server, shared by every turn of the
// account):
//   warm → no slot at all (split-turn.ts warmSplit: the process runs already);
//   cold → the slot only to start that server: admit → warm again (another part started it meanwhile: freed at once)
//          → engine.prewarm(account) → freed → the turn runs without a slot. So the parts of a group overlap after a
//          restart or on a cold account instead of queueing behind one slot for their whole turns (live L7: 87/177/262 s
//          instead of about 75 s each); concurrent starts of one account share one process (codex/engine.ts).
//   A start that fails ends the attempt as the engine's own failed start does ('unavailable', "… could not start." –
//   accounts/failure.ts: a short cooling, turn.ts may fail over); an abort while it starts interrupts the attempt at once
//   and the slot frees when the start settles (the process is still coming up meanwhile).
// Any other split (Claude Code: one process per turn) holds its slot for the whole attempt, as before.
// Owns: that admission rule. Never: counts slots (the supervisor does), runs the turn or decides failover.

import type { RuntimeServices } from '../contracts.ts';
import type { Engine } from '../engines/types.ts';
import type { Account } from '../../shared/model/providers.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { warmSplit } from './split-turn.ts';
import type { RoutedTurn, TurnPlan, TurnRequest } from './turn-types.ts';

export const WAITING_NOTE = 'waiting for capacity';
export const STARTING_NOTE = 'Starting the engine';

/** The account's persistent engine server, when the engine has one (warm/prewarm). */
interface SharedServer { warm(): boolean; prewarm(): Promise<void> }

function sharedServer(engine: Engine, account: Account): SharedServer | undefined {
  const warm = engine.warm?.bind(engine);
  const prewarm = engine.prewarm?.bind(engine);
  if (!warm || !prewarm) return undefined;
  return {
    warm: () => { try { return warm(account) === true; } catch { return false; } },
    prewarm: async () => prewarm(account), // a synchronous throw becomes a failed start
  };
}

/**
 * Waits for the attempt's heavy slot by the rule above; returns its release (undefined = no slot held now). Throws the
 * abort reason when the turn is stopped meanwhile, and WorkforceError 'unavailable' when a split's server did not start.
 */
export async function admitAttempt(
  services: Pick<RuntimeServices, 'log'>, plan: Pick<TurnPlan, 'split'>, turn: Pick<RoutedTurn, 'engine' | 'account'>,
  request: Pick<TurnRequest, 'admit' | 'signal' | 'runId'>, status: (note: string) => void,
): Promise<(() => void) | undefined> {
  const admit = request.admit;
  if (!turn.engine.caps.ownTools || !admit || warmSplit(plan, turn)) return undefined;
  const server = plan.split ? sharedServer(turn.engine, turn.account) : undefined;
  const release = await admitShowingWait(admit, request.signal, status);
  if (!server) return release; // the agent's own turn, or one process per turn: the slot for the whole attempt
  if (server.warm()) { release(); return undefined; } // another part started it while this one waited
  status(STARTING_NOTE);
  const start = server.prewarm();
  try {
    await untilAborted(start, request.signal);
  } catch (error) {
    if (request.signal.aborted) {
      void start.catch(() => undefined).finally(release);
      throw error;
    }
    release();
    services.log.warn('the engine did not start for a split', { runId: request.runId, engine: turn.engine.id, error: String(error) });
    throw new WorkforceError('unavailable', `${engineName(turn.engine)} is not installed or could not start.`);
  }
  release();
  return undefined;
}

/**
 * B-078 T10: the slot, with WAITING_NOTE only while the turn really waits – a free slot settles within the same
 * microtask turn (supervisor.admit returns at once), so no "waiting for capacity" flashes before "Working".
 */
async function admitShowingWait(
  admit: NonNullable<TurnRequest['admit']>, signal: AbortSignal, status: (note: string) => void,
): Promise<() => void> {
  let settled = false;
  const pending = admit(signal);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  if (!settled) status(WAITING_NOTE);
  return pending;
}

/** `work`, or the abort reason as soon as `signal` aborts (the work itself goes on). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** "Codex" – the words of the engine's own failed start (codex/engine.ts run). */
function engineName(engine: Engine): string {
  return engine.id.charAt(0).toUpperCase() + engine.id.slice(1);
}
