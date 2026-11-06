// Guarded start of the runtime utility process (23.10.2026): asks the start guard first; with a
// problem pinned for this version (or the crash loop earlier starts made) it starts the repair
// runtime instead of the real one. A start that fails with an UpgradeError goes to the repair
// runtime in the same process (the database is closed, nothing else ran); any other failure is
// recorded and rethrown, so the process exits and main starts it again with backoff – the start
// after MAX_ATTEMPTS failures shows the repair screen in a fresh process. A runtime that answered
// ready is marked up, and stable STABLE_MS later (one unref'd timer, no polling).
// Owns: that decision. Never: builds either runtime itself (injected) or swallows a failure.

import type { StartProblem } from '../../shared/model/repair.ts';
import { isUpgradeError } from '../db/upgrade.ts';
import { STABLE_MS, type BootJournal } from './journal.ts';

export interface GuardedBootDeps<R, P> {
  journal: BootJournal;
  version: string;
  /** Builds the full runtime (createRuntime). */
  start(): Promise<R>;
  /** Builds the repair runtime for `problem`. */
  repair(problem: StartProblem): P;
  /** One-shot timer for the stable mark (default: an unref'd setTimeout). */
  later?(fn: () => void, ms: number): void;
}

export type BootOutcome<R, P> = { kind: 'runtime'; runtime: R } | { kind: 'repair'; repair: P; problem: StartProblem };

function defaultLater(fn: () => void, ms: number): void {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
}

export async function guardedBoot<R, P>(deps: GuardedBootDeps<R, P>): Promise<BootOutcome<R, P>> {
  const begun = deps.journal.begin(deps.version);
  if (begun.problem) return { kind: 'repair', repair: deps.repair(begun.problem), problem: begun.problem };
  let runtime: R;
  try {
    runtime = await deps.start();
  } catch (error) {
    const problem = deps.journal.failed(error, deps.version);
    if (problem && isUpgradeError(error)) return { kind: 'repair', repair: deps.repair(problem), problem };
    throw error;
  }
  deps.journal.up();
  (deps.later ?? defaultLater)(() => deps.journal.stable(), STABLE_MS);
  return { kind: 'runtime', runtime };
}
