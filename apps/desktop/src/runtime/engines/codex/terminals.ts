// A Codex thread nobody resumes leaves the app-server with its background commands (live tests L3 and C4).
// Codex keeps a command the model sent to the background (exec_command with a yield) running past its turn, an
// interrupt and an unsubscribe – until the app-server ends. A thread nobody continues (a released split, a thread renewed
// for B-047 D1, a helper thread) therefore cleans its background terminals first (`thread/backgroundTerminals/clean`,
// Codex app-server v2, experimental API), then leaves (`thread/unsubscribe`); refusals are ignored.
// Everything else stays the agents' own: the emergency stop ends all of them (engine.ts stopBackground).
// Owns: dropping a thread with its background commands. Never: ends a command of a thread that is still in use.

import type { RpcClient } from './rpc.ts';

const RPC_MS = 5_000;

/** A thread nobody resumes leaves the server: its background commands end first, then `thread/unsubscribe`. */
export async function dropThread(rpc: RpcClient, threadId: string): Promise<void> {
  await rpc.request('thread/backgroundTerminals/clean', { threadId }, RPC_MS).catch(() => undefined);
  await rpc.request('thread/unsubscribe', { threadId }).catch(() => undefined);
}
