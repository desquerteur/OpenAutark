// Who made the RPC call that is running right now (DEV5B). The RPC server sets it around every
// handler (rpc/server.ts: socket calls, in-process calls and the tokenless `POST /rpc` route);
// code further down the same call reads it, e.g. a phone accepting another phone may grant at
// most its own tier (pwa/requests.ts), and the access request limit counts per address.
// The context also flows into async work a call starts (a wake, a turn), so it is only ever used
// to NARROW what an answer may do – never to widen it or to tell the person from an agent
// (agents cannot answer as the person at all: TaskService records them as 'claimed_by_agent').
// Owns: the AsyncLocalStorage and its accessors. Never: authentication (transports decide the
// scope) or a default caller – outside an RPC call there is none.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ClientScope } from '../../shared/api/protocol.ts';

export interface Caller {
  scope: ClientScope;
  /** Remote address of a tokenless `POST /rpc` call (normalized, '' when unknown). */
  remote?: string;
}

const storage = new AsyncLocalStorage<Caller>();

/** Runs `fn` (and everything it awaits) as a call made by `caller`. */
export function withCaller<T>(caller: Caller, fn: () => T): T {
  return storage.run(caller, fn);
}

/** The caller of the RPC call this code runs in; undefined outside one. */
export function currentCaller(): Caller | undefined {
  return storage.getStore();
}
