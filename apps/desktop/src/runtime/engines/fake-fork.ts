// The fake engine's native fork (B-057, tests and demos – fake.ts, caps.fork): each fork() is recorded in `fork.calls` and
// answers the ref `fake-fork-<n>` (generation 1). A forked session's turns are ordinary fake turns: the fake keeps no
// history, so a fork carries nothing over – a worker's turn answers "Echo: <its new input>" like every turn (fake.ts rules).
// Owns: that recording and the ref numbering. Never: used for real work (the registry exposes the fake engine only when enabled).

import type { EngineForkInput, EngineForkResult } from './types.ts';

/** Engine.fork of the fake engine, with the inputs it got (oldest first). */
export type FakeFork = ((input: EngineForkInput) => Promise<EngineForkResult>) & { readonly calls: EngineForkInput[] };

export function fakeFork(): FakeFork {
  const calls: EngineForkInput[] = [];
  const fork = async (input: EngineForkInput): Promise<EngineForkResult> => {
    calls.push(input);
    return { ref: `fake-fork-${calls.length}`, generation: 1 };
  };
  return Object.assign(fork, { calls });
}
