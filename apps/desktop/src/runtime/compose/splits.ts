// Composition of splits (B-057): the split service on RuntimeServices.splits, built on its repository, the run journal,
// the wake queue, the org and the late-bound dispatcher, with the git worktree helpers injected. Called once from compose/services.ts right after the dispatcher exists: a freed dispatcher lane or slot
// pumps the split service (onLaneFree – absent until the dispatcher has lanes); the stops that come as events
// (work-stop, an agent paused or archived) are watched; and the boot recovery runs once (splits/reconcile.ts – the
// dispatcher has not started, so no lane or turn runs yet; idempotent). Parts it queued again start once a lane frees.
// Owns: this wiring. Never: behaviour, or a timer.

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/splits.ts'; // RuntimeServices.splits, the dispatcher's lane members
import { SplitServiceImpl } from '../splits/service.ts';
import { SplitRepo } from '../store/splits.ts';
import { canIsolate, finishSplitWorktree, mergeSplit, openSplitWorktree, sweepSplitWorktrees } from '../git/split-worktree.ts';

export function createSplits(s: RuntimeServices): SplitServiceImpl {
  const splits = new SplitServiceImpl({
    db: s.db, bus: s.bus, clock: s.clock, log: s.log, repo: new SplitRepo(s.db), runs: s.runs, wakes: s.wakes, org: s.org,
    dispatcher: () => s.dispatcher,
    services: () => s,
    worktrees: { canIsolate, open: openSplitWorktree, finish: finishSplitWorktree, merge: mergeSplit, sweep: sweepSplitWorktrees },
  });
  s.splits = splits;
  s.dispatcher.onLaneFree?.(() => splits.pump());
  splits.watch();
  try { splits.reconcile(); } catch (error) { s.log.warn('splits not reconciled', { error: String(error) }); }
  return splits;
}
