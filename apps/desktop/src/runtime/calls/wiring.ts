// Composition of calls (compose/services.ts calls createCalls once the accounts, catalog and chats exist): the call rows
// (call-log.ts – one value per call in its chat), the realtime sessions over `ws` (realtime/session.ts), the call talker on
// the Decisions use (talker.ts) and the lookups the RPC handlers use (callLogOf, realtimeOf, talkerOf). A call otherwise runs
// on the device (shared/voice/conversation.ts). Shutdown: stopCalls (compose/lifecycle.ts); start-up: endCallsLeftOpen
// (main.ts reconciliation, after the sync listens).
// Owns: that wiring. Never: provider protocol.

import WebSocket from 'ws';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { createEngineRunner } from '../decision/engine-runner.ts';
import type { StructuredRunner } from '../decision/types.ts';
import { CallLog } from './call-log.ts';
import type { EngineSocket, SocketFactory } from './realtime/engine.ts';
import { RealtimeCalls, type CallTimers } from './realtime/session.ts';
import { CallTalker } from './talker.ts';

const timers: CallTimers = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A ws client socket to the provider (no redirects, bounded frames). */
export const wsConnect: SocketFactory = (url, headers) => new WebSocket(url, { headers, followRedirects: false, maxPayload: 4 * 1024 * 1024 }) as unknown as EngineSocket;

const logs = new WeakMap<object, CallLog>();
const realtimes = new WeakMap<object, RealtimeCalls>();
const talkers = new WeakMap<object, CallTalker>();

export function createCalls(services: RuntimeServices, options: { connect?: SocketFactory; timers?: CallTimers; run?: StructuredRunner } = {}): { log: CallLog; realtime: RealtimeCalls; talker: CallTalker } {
  const log = new CallLog(() => services);
  const realtime = new RealtimeCalls({ services: () => services, log, connect: options.connect ?? wsConnect, timers: options.timers ?? timers });
  const talker = new CallTalker({ services: () => services, run: options.run ?? createEngineRunner(services) });
  logs.set(services, log);
  realtimes.set(services, realtime);
  talkers.set(services, talker);
  return { log, realtime, talker };
}

/** The runtime's call rows, or undefined (tests, headless setups). */
export const callLogOf = (services: object): CallLog | undefined => logs.get(services);

/** The runtime's call talker, or undefined (tests, headless setups). */
export const talkerOf = (services: object): CallTalker | undefined => talkers.get(services);

/** Start-up reconciliation: the calls this PC left open end now, so their end travels to the other PCs. Returns how many. */
export function endCallsLeftOpen(services: object): number {
  return logs.get(services)?.endLeftOpen() ?? 0;
}

export function realtimeOf(services: object): RealtimeCalls {
  const realtime = realtimes.get(services);
  if (!realtime) throw new WorkforceError('unavailable', 'Realtime voice is not available in this runtime.');
  return realtime;
}

/** Shutdown: realtime sessions close, the talker's unanswered lines go to the agent, open calls end at the next start. */
export function stopCalls(services: object): void {
  realtimes.get(services)?.stop();
  logs.get(services)?.stop();
  logs.delete(services);
  realtimes.delete(services);
  talkers.get(services)?.stop();
  talkers.delete(services);
}
