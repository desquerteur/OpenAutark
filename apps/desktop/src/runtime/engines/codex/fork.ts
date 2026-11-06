// Codex native fork (B-057 S4a): a split starts as its parent – app-server `thread/fork` copies the parent's thread of the
// same account (its rollout lives in that CODEX_HOME) into a new thread; the parent thread stays as it is.
// Schema (codex-cli 0.165.0-alpha.1.2, `codex app-server generate-json-schema --experimental`, ThreadForkParams /
// ThreadForkResponse): threadId (required) | path; lastTurnId ("fork through, inclusive"; that turn must not be in
// progress) | beforeTurnId; model, cwd, config, sandbox, approvalPolicy, approvalsReviewer, baseInstructions,
// developerInstructions, ephemeral, excludeTurns ("return only thread metadata and live fork state without populating
// thread.turns" – the fork still holds the whole history, only the answer stays small), attachToSource,
// experimentalPredictionMode …; NO dynamicTools and NO experimentalRawEvents: the fork keeps the parent's dynamic tools –
// intended, a split's offer is byte-identical to its parent's (S8). The answer: { thread: { id, forkedFromId … }, cwd, model … }.
// Choices: through the parent's turn that split (lastTurnId, when the executor recorded it – native-turns.ts), so a parent
// turn that runs meanwhile stays out; never ephemeral (a worker may outlive an idle app-server – an ephemeral thread is gone
// with its process); never attachToSource (it would block deleting the parent: session sweep, Forget); no instruction
// overrides (the parent's instructions and prefix stay – the worker's identity travels as its first turn's
// <workforce-context> block, engine.ts); the thread settings a resume gets (lean config with today's fallback,
// helper-thread.ts; read-only and untrusted, isolation.ts); the worker's model when given (another model of the account is
// allowed – the cache may be lost; correctness first).
// Owns: those params and the answer check. Never: starts a turn, touches the parent thread or reads CODEX_HOME files.

import type { EngineForkInput } from '../types.ts';
import { str } from '../shared.ts';

/** thread/fork params: the parent (through `lastTurn`), the thread `settings` (engine.ts settings() – no instructions sent), the small answer. */
export function forkParams(input: Pick<EngineForkInput, 'parentRef' | 'lastTurn'>, settings: Record<string, unknown>): Record<string, unknown> {
  const { baseInstructions: _base, developerInstructions: _developer, dynamicTools: _tools, ephemeral: _ephemeral, ...rest } = settings;
  return { ...rest, threadId: input.parentRef, ...(input.lastTurn ? { lastTurnId: input.lastTurn } : {}), excludeTurns: true };
}

/** Sends `params` through `open` (engine.ts: the lean agent thread with its fallback); the new thread's id – never the parent's. */
export async function forkThread(params: Record<string, unknown>, open: (params: Record<string, unknown>) => Promise<{ thread?: { id?: string } } | undefined>): Promise<string> {
  const forked = await open(params);
  const id = str(forked?.thread?.id);
  if (!id) throw new Error('Codex did not fork the session.');
  if (id === params.threadId) throw new Error('Codex answered with the parent session instead of a fork.');
  return id;
}
