// Restarts of splits (B-057 S14). A part that did not really run is put back ('queued') WITHOUT counting the attempt
// its start counted: the pipeline says so (SplitRunEnd.requeue – its agent paused for its budget before the turn
// planned, or the runtime stopped before it ran) or a graceful stop of the runtime cut its run off while it ran
// (runs/journal.ts cutByShutdown) – bounded by PUT_BACKS per part, so a part that ends every run that way (a crash
// loop) still ends.
// Boot recovery (reconcileSplits), idempotent: a split left 'running' with no lane of the dispatcher behind it (the app
// stopped while it ran) whose newest run had already ended 'done' does not run again – its worktree work is committed on
// its branch first, like any ended part (the app stopped while that commit ran) – it ends done; any other is put back
// as above (else failed); a pending group whose parent turn no longer runs starts (that turn ended – also by a crash:
// the parent asked for its parts) or, when the parent's run is gone, is stopped; every running group advances (ready
// parts queued, a group whose parts all ended settles and wakes its parent); the native sessions of ended parts and of
// gathered or stopped groups are released (release.ts) and the worktree folders of ended parts closed (git/split-worktree.ts – in the
// background, never a branch with work on it); then the runner pumps. Called once at composition, before the dispatcher
// starts: its lanes and turns are empty then, so a parent run still marked 'running' is a crash's leftover.
// The attempt after a restart's put-back reads why it runs again (RESTART_NOTE in its input; the runner notes it at the start).
// Owns: those repairs and the put-back rule. Never: runs a turn, or re-wakes a group that settled before the restart (its wake is durable).

import { SPLIT_LIMITS, type Split } from '../../shared/model/splits.ts';
import type { Run } from '../../shared/model/runs.ts';
import type { Dispatcher, RunJournal } from '../contracts.ts';
import type { SplitRunEnd } from '../contracts/splits.ts';
import { cutByShutdown } from '../runs/journal.ts';
import type { SplitCore } from './core.ts';
import { releaseEnded } from './release.ts';
import type { SplitRunner } from './runner.ts';
import { runsBySplit } from './views.ts';

export const RESTART_AGAIN = 'The app stopped while this part ran; it runs once more.';
export const RESTART_FAILED = 'The app stopped while this part ran, too many times; it does not run again.';
export const PARENT_GONE = 'Not started: the turn that split is gone.';
export const PUT_BACK = 'It did not run to the end; it runs again.';
/** A graceful stop of the runtime cut the part's run (agents/split-turn.ts splitEnd's error). */
export const SHUTDOWN_CUT = 'The runtime stopped while the split ran.';
/**
 * The input note of the attempt after a restart put the part back (service.inputFor): live test L7 – with only the
 * generic recap of the cut attempt's calls, a part once would not repeat its harmless command and reported it unverified.
 */
export const RESTART_NOTE = 'The app restarted while I worked on this part, so the earlier attempt was cut. I do the part again from the start and run its commands again to get real outputs; repeating reads and checks is safe.';

/** Did a restart put this part back (the text its put-back left on it – boot: RESTART_AGAIN; a graceful stop: SHUTDOWN_CUT)? */
export function putBackByRestart(error: string | undefined): boolean {
  return error === RESTART_AGAIN || error === SHUTDOWN_CUT;
}
/** How often a part may be put back without counting an attempt, beyond its attempts (SPLIT_LIMITS.attempts). */
export const PUT_BACKS = 3;

export interface SplitRecovery { requeued: number; finished: number; failed: number; started: number; stopped: number }

/**
 * Boot (main.ts): the interrupted runs whose recovery notes (tasks/recover-notes.ts) go to their agents – without split runs.
 * A crash-cut part is put back above and its next run sees what the cut attempt did (turn-prepare.ts previousAttempt); its
 * main self never made those calls (live test L7: a chat-free 'retry' wake had the parent search for its parts' commands).
 * Splits never spend, send or publish (split-lock.ts), so no "Did this happen?" to-do is lost.
 */
export function recoveryRuns(runs: Pick<RunJournal, 'get'>, runIds: readonly string[]): string[] {
  return runIds.filter((id) => { try { return !runs.get(id)?.splitId; } catch { return true; } });
}

/** The run end means "not really run, put it back" (see the header). */
export function putBack(core: SplitCore, end: SplitRunEnd): boolean {
  if (end.status === 'done') return false;
  if (end.requeue === true) return true;
  try { return end.retryable === true && cutByShutdown(core.deps.db, end.runId); } catch { return false; }
}

/** May this part be put back once more without counting an attempt? (PUT_BACKS, counted by its runs). */
export function mayPutBack(core: SplitCore, split: Pick<Split, 'id'>): boolean {
  return runsOf(core, split.id).length <= SPLIT_LIMITS.attempts + PUT_BACKS;
}

function runsOf(core: SplitCore, splitId: string): Run[] {
  return runsBySplit(core.deps.runs, [splitId]).get(splitId) ?? [];
}

export function reconcileSplits(core: SplitCore, runner: SplitRunner): SplitRecovery {
  const out: SplitRecovery = { requeued: 0, finished: 0, failed: 0, started: 0, stopped: 0 };
  let dispatcher: Dispatcher | undefined;
  try { dispatcher = core.deps.dispatcher(); } catch { dispatcher = undefined; }
  let lanes = new Set<string>();
  let turns = new Set<string>();
  try { lanes = new Set((dispatcher?.splitLanes?.() ?? []).map((lane) => lane.splitId)); } catch { /* no lanes */ }
  try { turns = new Set((dispatcher?.activity() ?? []).map((entry) => entry.runId)); } catch { /* no turns */ }
  const changed = new Set<string>();
  const now = core.now();

  for (const split of core.repo.listSplits({ statuses: ['running'] })) {
    if (lanes.has(split.id) || runner.busy(split.id)) continue;
    if (runsOf(core, split.id).at(-1)?.status === 'done') { // journaled as done; the app stopped before the part was told (or committed)
      if (split.worktree) runner.finishThenEnd(split, { status: 'done' });
      else core.repo.updateSplit(split.id, { status: 'done', endedAt: now, error: undefined });
      out.finished++;
    } else if (mayPutBack(core, split)) {
      core.repo.updateSplit(split.id, { status: 'queued', attempts: Math.max(0, split.attempts - 1), error: RESTART_AGAIN });
      out.requeued++;
    } else {
      core.repo.updateSplit(split.id, { status: 'failed', endedAt: now, error: RESTART_FAILED });
      out.failed++;
    }
    changed.add(split.groupId);
  }

  for (const group of core.repo.listGroups({ statuses: ['pending'] })) {
    let parent: Run | undefined;
    try { parent = core.deps.runs.get(group.parentRunId); } catch { parent = undefined; }
    if (parent && (parent.status === 'running' || parent.status === 'queued') && turns.has(parent.id)) continue; // still running here
    if (parent) { runner.startGroup(group.id); out.started++; } else { runner.stopPending(group.id, PARENT_GONE); out.stopped++; }
    changed.add(group.id);
  }

  for (const group of core.repo.listGroups({ statuses: ['running'] })) if (runner.advance(group.id)) changed.add(group.id);

  let released = 0;
  try { released = releaseEnded(core.deps.db); } catch (error) { core.deps.log.warn('split sessions not released', { error: String(error) }); }
  sweepFolders(core);

  if (out.requeued || out.finished || out.failed || out.started || out.stopped || released) core.deps.log.info('splits reconciled', { ...out, released });
  core.emit(changed);
  runner.pump();
  return out;
}

/** The worktree folders of ended parts (a crash left them open) are closed in the background; never throws. */
function sweepFolders(core: SplitCore): void {
  const sweep = core.deps.worktrees.sweep;
  const s = core.services();
  if (!sweep || !s) return;
  const lost = (error: unknown) => core.deps.log.warn('split worktrees not swept', { error: String(error) });
  try { sweep(s).catch(lost); } catch (error) { lost(error); }
}
