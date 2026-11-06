// What the split service's parts share (B-057): its dependencies, the status sets of the lifecycle, the clock, an
// agent's name for texts and the 'split.upserted' emit. The lifecycle of a group: 'pending' (created by the parent's
// agents.split call) → 'running' (the parent's turn ended) → 'settled' (every split terminal; the parent was woken once)
// → 'gathered' (a parent turn with the results ended 'done'); or 'stopped' (the person stopped it, or the turn that split).
// A split: 'pending' (its group waits, or the parts it builds on run) → 'queued' (ready, waiting for a lane) →
// 'running' (on its lane) → 'done' | 'failed' | 'stopped' | 'skipped' (a part it builds on did not end done).
// Owns: those sets, the dependencies' shape, the emit and the session release call. Never: a lifecycle step itself
// (runner.ts, gather.ts).

import type { Bus } from '../bus.ts';
import type { Clock, Dispatcher, Logger, OrgService, RunJournal, RuntimeServices, WakeQueue } from '../contracts.ts';
import '../contracts/splits.ts'; // the dispatcher's lane members, RunJournal.listBySplit
import type { Db } from '../db/database.ts';
import type { Split, SplitGroup, SplitGroupStatus, SplitStatus } from '../../shared/model/splits.ts';
import type { SplitRepo } from '../store/splits.ts';
import { releaseSessions, type ReleasedSession } from './release.ts';
import type { canIsolate, finishSplitWorktree, mergeSplit, openSplitWorktree, sweepSplitWorktrees } from '../git/split-worktree.ts';
import { groupViews } from './views.ts';

/** What the split service works with (compose/splits.ts). The dispatcher and the whole record are late-bound. */
export interface SplitServiceDeps {
  db: Db;
  bus: Bus;
  clock: Clock;
  log: Logger;
  /** split_groups / splits rows. */
  repo: SplitRepo;
  /** The run journal (split runs: listBySplit; the parent's run). */
  runs: RunJournal;
  /** The parent's fan-in wake. */
  wakes: WakeQueue;
  org: OrgService;
  /** Late-bound: the dispatcher's lanes (startSplit, stopSplit, splitLanes). */
  dispatcher: () => Dispatcher;
  /** Late-bound: the services record for helpers that take it (worktrees, budget, chats, catalog). */
  services: () => RuntimeServices;
  /** `worktree: true` parts (git/split-worktree.ts – git runs processes, so it is injected); `sweep`: the boot recovery's close of ended parts' folders. */
  worktrees: { canIsolate: typeof canIsolate; open: typeof openSplitWorktree; finish: typeof finishSplitWorktree; merge: typeof mergeSplit; sweep?: typeof sweepSplitWorktrees };
}

/** Groups that count toward SPLIT_LIMITS.activeGroupsPerAgent (work in flight). */
export const BUSY_GROUPS: readonly SplitGroupStatus[] = ['pending', 'running'];
/** Groups not yet gathered or stopped (splits.list `active`). */
export const OPEN_GROUPS: readonly SplitGroupStatus[] = ['pending', 'running', 'settled'];
/** Splits that have not ended. */
export const LIVE_SPLITS: readonly SplitStatus[] = ['pending', 'queued', 'running'];

export const isTerminal = (status: SplitStatus): boolean => status === 'done' || status === 'failed' || status === 'stopped' || status === 'skipped';

export class SplitCore {
  readonly deps: SplitServiceDeps;
  readonly repo: SplitRepo;

  constructor(deps: SplitServiceDeps) {
    this.deps = deps;
    this.repo = deps.repo;
  }

  now(): number { return this.deps.clock.now(); }

  /** The agent's name for texts ('This agent' when it is unknown). */
  agentName(agentId: string): string {
    try { return this.deps.org.get(agentId)?.name ?? 'This agent'; } catch { return 'This agent'; }
  }

  /** 'split.upserted' for each of these groups (their full views); never throws. */
  emit(groupIds: Iterable<string>): void {
    const ids = [...new Set(groupIds)];
    if (!ids.length) return;
    try {
      const groups = ids.map((id) => this.repo.getGroup(id)).filter((group): group is SplitGroup => group !== undefined);
      for (const view of groupViews(this.deps, groups)) this.deps.bus.emit('split.upserted', view);
    } catch (error) {
      this.deps.log.warn('split update not announced', { groups: ids.length, error: String(error) });
    }
  }

  /** The native sessions of these splits go (release.ts – a part that ended for good, a gathered or stopped group's) and leave their engine's memory; never throws. */
  release(splits: ReadonlyArray<Pick<Split, 'id' | 'agentId'>>): void {
    try { releaseSessions(this.deps.db, splits, (session) => this.unload(session)); } catch (error) { this.deps.log.warn('split sessions not released', { splits: splits.length, error: String(error) }); }
  }

  /** A released session leaves a shared engine process (Engine.unload – a Codex app-server's loaded thread); in the background. */
  private unload(session: ReleasedSession): void {
    const s = this.services();
    if (!s || !session.accountId) return;
    const lost = (error: unknown) => this.deps.log.warn('split session not unloaded', { engine: session.engine, error: String(error) });
    try {
      const engine = s.engines.get(session.engine);
      const account = s.accounts.get(session.accountId);
      if (engine?.unload && account) engine.unload(account, session.ref).catch(lost);
    } catch (error) { lost(error); }
  }

  /** The services record, or undefined while it is not wired (fakes). */
  services(): RuntimeServices | undefined {
    try { return this.deps.services(); } catch { return undefined; }
  }
}
