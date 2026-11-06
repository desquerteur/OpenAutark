// SplitServiceImpl (B-057, contracts/splits.ts SplitService): an agent splits itself into parallel workers. A group is
// created by the parent's agents.split call (validate.ts; status pending, `ultra` when the person's latest message there
// suggested Ultra) and starts when that
// turn ends (afterParentTurn); ready splits start on their own dispatcher lanes (runner.ts pump → dispatcher.startSplit,
// again on onLaneFree); a split run's end (onSplitRunEnd) settles it, retries once or skips its dependants; a settled
// group wakes the parent once ('child', coalesceKey splits:<groupId>) and its results reach the parent's next turn on
// that thread (gather.ts pendingResults). The lane builds a split's TurnRequest from turnFor and inputFor
// (results.ts: the part's brief and the results of the parts it builds on). Stops: splits.stop, agents.split_stop,
// the person's work-stop ('work.state' stopped), pausing or archiving the agent ('agent.upserted') and deleting the chat
// it was split in ('conversation.removed'; settled groups there, or of an archived agent, end too – nobody gathers them) –
// watch(), which also starts parts that wait for an account when one becomes usable (holds.ts).
// Boot recovery: reconcile.ts. Views: views.ts.
// Owns: the split lifecycle (create, start, settle, gather, stop, reconcile) on the split repo. Never: runs a turn itself
// (the dispatcher's lanes do), touches the parent's native session, ledger or chat, or lets a split split again.

import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { cleanOrigin } from '../../shared/model/origin.ts';
import { SPLIT_LIMITS, type Split, type SplitGroup, type SplitGroupView, type SplitPartInput, type SplitTurn, type SplitView } from '../../shared/model/splits.ts';
import type { SplitCreateContext, SplitProgress, SplitRunEnd, SplitService } from '../contracts/splits.ts';
import { BUSY_GROUPS, LIVE_SPLITS, OPEN_GROUPS, SplitCore, isTerminal, type SplitServiceDeps } from './core.ts';
import { checkCreate } from './validate.ts';
import { SplitRunner } from './runner.ts';
import { coalesceKey, markGathered, pendingResults, results } from './gather.ts';
import { workerNotes } from './results.ts';
import { RESTART_NOTE, reconcileSplits, type SplitRecovery } from './reconcile.ts';
import { groupView, groupViews } from './views.ts';

export type { SplitServiceDeps } from './core.ts';

export const PARENT_STOPPED = 'Not started: the person stopped the turn that split.';
export const WORK_STOPPED = 'Stopped: the person stopped all agent work.';
export const CHAT_REMOVED = 'Stopped: the chat it was split in was deleted.';
const LIST_LIMIT = 200;

type ListQuery = { agentId?: string; parentRunId?: string; groupId?: string; conversationId?: string; active?: boolean; limit?: number };

export class SplitServiceImpl implements SplitService {
  private readonly core: SplitCore;
  private readonly runner: SplitRunner;

  constructor(deps: SplitServiceDeps) {
    this.core = new SplitCore(deps);
    this.runner = new SplitRunner(this.core);
  }

  create(ctx: SplitCreateContext, input: { goal: string; parts: SplitPartInput[] }): SplitGroupView {
    const { goal, parts } = checkCreate(this.core, ctx, input);
    const { repo, deps } = this.core;
    const now = this.core.now();
    const origin = cleanOrigin(ctx.origin);
    const group: SplitGroup = {
      id: newId('sgr', now), agentId: ctx.agentId, parentRunId: ctx.runId,
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(origin ? { origin } : {}), thread: ctx.thread, ...(ctx.modeKey ? { modeKey: ctx.modeKey } : {}), ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      goal, ultra: this.ultraOf(ctx.conversationId), status: 'pending', parts: parts.length, createdAt: now,
    };
    const splits: Split[] = parts.map((part, index) => ({
      id: newId('spl', now), groupId: group.id, agentId: ctx.agentId, idx: index + 1, of: parts.length, ...part,
      status: 'pending', attempts: 0, createdAt: now,
    }));
    deps.db.tx(() => {
      repo.saveGroup(group);
      for (const split of splits) repo.saveSplit(split);
    });
    deps.log.info('split group created', { agentId: ctx.agentId, groupId: group.id, parts: parts.length, runId: ctx.runId });
    const view = groupView(deps, repo.getGroup(group.id) ?? group);
    deps.bus.emit('split.upserted', view);
    return view;
  }

  /** Did the person's latest message in the chat the group was split in suggest Ultra (MessageMeta.ultra)? A record only. */
  private ultraOf(conversationId: string | undefined): boolean {
    if (!conversationId) return false;
    try {
      const messages = this.core.services()?.chats.messages(conversationId, { limit: 30 }) ?? [];
      return messages.findLast((message) => message.authorKind === 'human')?.meta?.ultra === true;
    } catch { return false; }
  }

  afterParentTurn(runId: string, status: 'done' | 'failed' | 'stopped'): void {
    const groups = this.core.repo.listGroups({ parentRunId: runId, statuses: ['pending'] });
    if (!groups.length) return;
    for (const group of groups) {
      if (status === 'stopped') this.runner.stopPending(group.id, PARENT_STOPPED);
      else this.runner.startGroup(group.id);
    }
    this.core.emit(groups.map((group) => group.id));
    this.runner.pump();
  }

  onSplitRunEnd(splitId: string, end: SplitRunEnd): void {
    this.runner.onRunEnd(splitId, end);
  }

  turnFor(splitId: string): SplitTurn | undefined {
    const split = this.core.repo.getSplit(splitId);
    if (!split || (split.status !== 'queued' && split.status !== 'running')) return undefined;
    const group = this.core.repo.getGroup(split.groupId);
    if (!group || group.status !== 'running') return undefined;
    const folder = this.runner.folderOf(splitId);
    if (split.worktree && !folder) return undefined; // a worktree part never runs in the parent's folder
    const cwd = folder ?? group.cwd;
    return {
      splitId, groupId: group.id, idx: split.idx, of: split.of, title: split.title, parentRunId: group.parentRunId,
      parentThread: group.thread, ...(group.conversationId ? { parentConversationId: group.conversationId } : {}),
      ...(group.taskId ? { parentTaskId: group.taskId } : {}), context: split.context, ...(group.modeKey ? { modeKey: group.modeKey } : {}),
      ...(cwd ? { cwd } : {}), ...(split.model ? { model: split.model } : {}), ...(split.effort ? { effort: split.effort } : {}),
      // S4: every run of a part may seed its session from the parent – the pipeline does so only when this attempt has no
      // session of its own for the engine and account it routes to (turn-prepare.ts chooseSession), so a retry resumes
      // the session an earlier attempt left there, and one routed to another engine or account starts as the parent
      // again instead of blind; a renewal inside a run never re-seeds (turn.ts sets firstTurn false).
      firstTurn: true,
    };
  }

  inputFor(splitId: string): Array<{ text: string; at: number }> {
    const split = this.core.repo.getSplit(splitId);
    const group = split && this.core.repo.getGroup(split.groupId);
    if (!split || !group) return [];
    const splits = this.core.repo.listSplits({ groupId: group.id });
    const notes = workerNotes(this.core.deps.runs, group, split, splits);
    // Live test L7: an attempt after a restart's put-back is told why it runs again (before the recap of the cut attempt's calls).
    return this.runner.restarted(splitId) ? [...notes, { text: RESTART_NOTE, at: this.core.now() }] : notes;
  }

  pendingResults(agentId: string, thread: string): { groupIds: string[]; text: string } | undefined {
    return pendingResults(this.core, agentId, thread);
  }

  markGathered(runId: string, groupIds: string[]): void {
    this.core.emit(markGathered(this.core, runId, groupIds));
  }

  results(agentId: string, q: { groupId?: string; idx?: number; thread?: string }): string {
    return results(this.core, agentId, q);
  }

  stop(q: { splitId?: string; groupId?: string; agentId?: string; conversationId?: string; taskId?: string }, by: string): number {
    return this.runner.stop(q, by);
  }

  list(q: ListQuery): SplitGroupView[] {
    const limit = Math.max(1, Math.min(LIST_LIMIT, Math.floor(q.limit ?? 50)));
    const statuses = q.active ? OPEN_GROUPS : undefined;
    const { repo } = this.core;
    let groups: SplitGroup[];
    if (q.groupId) {
      const group = repo.getGroup(q.groupId);
      const fits = group && (!q.agentId || group.agentId === q.agentId) && (!q.parentRunId || group.parentRunId === q.parentRunId)
        && (!q.conversationId || group.conversationId === q.conversationId) && (!statuses || statuses.includes(group.status));
      groups = fits ? [group] : [];
    } else {
      groups = repo.listGroups({
        ...(q.agentId ? { agentId: q.agentId } : {}), ...(q.parentRunId ? { parentRunId: q.parentRunId } : {}),
        ...(q.conversationId ? { conversationId: q.conversationId } : {}), ...(statuses ? { statuses } : {}), limit,
      });
    }
    return groupViews(this.core.deps, groups);
  }

  /** R1-4: the agent's groups still at work on `thread` with their counts (the 'splits' line of its own turns – context/split-section.ts). */
  activeOn(agentId: string, thread: string, limit: number = SPLIT_LIMITS.activeGroupsPerAgent): SplitProgress[] {
    const groups = this.core.repo.listGroups({ agentId, thread, statuses: BUSY_GROUPS, limit });
    if (!groups.length) return [];
    const splits = this.core.repo.listSplits({ groupIds: groups.map((group) => group.id) });
    return groups.map((group) => {
      const own = splits.filter((split) => split.groupId === group.id);
      const count = (fits: (split: Split) => boolean) => own.filter(fits).length;
      return {
        id: group.id, goal: group.goal, status: group.status === 'pending' ? 'pending' : 'running', parts: Math.max(group.parts, own.length),
        done: count((split) => split.status === 'done'), running: count((split) => split.status === 'running'),
        ended: count((split) => isTerminal(split.status) && split.status !== 'done'),
      };
    });
  }

  get(splitId: string): { split: SplitView; group: SplitGroupView } | undefined {
    const split = this.core.repo.getSplit(splitId);
    const group = split && this.core.repo.getGroup(split.groupId);
    if (!group) return undefined;
    const view = groupView(this.core.deps, group);
    const found = view.splits.find((item) => item.id === splitId);
    return found ? { split: found, group: view } : undefined;
  }

  /** agents.split_merge's outcome (git/split-worktree.ts) on the part's row; published like any split change. */
  markBranch(splitId: string, branch: NonNullable<Split['branch']>): void {
    const split = this.core.repo.getSplit(splitId);
    if (!split) return;
    this.core.repo.updateSplit(splitId, { branch: { ...split.branch, ...branch } });
    this.core.emit([split.groupId]);
  }

  /** How the split's session was seeded (S4: native fork, ledger rebuild, text or fresh), shown on the split's view. */
  markFork(splitId: string, fork: NonNullable<Split['fork']>): void {
    const split = this.core.repo.getSplit(splitId);
    if (!split) return;
    this.core.repo.updateSplit(splitId, { fork });
    this.core.emit([split.groupId]);
  }

  pump(): void {
    this.runner.pump();
  }

  reconcile(): SplitRecovery {
    return reconcileSplits(this.core, this.runner);
  }

  /**
   * The stops that come as events (S13): the person's work-stop stops every running and waiting split; pausing or
   * archiving an agent stops its splits; deleting a chat stops the groups split there. Settled groups nobody can gather
   * any more (their chat deleted, their agent archived) end as stopped. Account and model changes start the parts that
   * wait for an account (holds.ts). Returns the unsubscribe.
   */
  watch(): () => void {
    const { bus } = this.core.deps;
    const s = this.core.services();
    const list = <T>(read: () => T[] | undefined): T[] => { try { return read() ?? []; } catch { return []; } };
    const outages = this.runner.holds.watch({ accounts: list(() => s?.accounts?.list()), models: list(() => s?.catalog?.list()) });
    const offs = [
      bus.on('work.state', (state) => { if (state.stopped) this.stopLive({}, WORK_STOPPED); }),
      bus.on('agent.upserted', (agent) => {
        if (agent.archivedAt !== undefined) {
          this.stopLive({ agentId: agent.id }, `Stopped: ${agent.name} was archived.`);
          this.endSettled({ agentId: agent.id }); // its fan-in wake is dropped: those results are never gathered
        }
        else if (agent.status === 'paused') this.stopLive({ agentId: agent.id }, `Stopped: ${agent.name} was paused.`);
      }),
      // The person deleted the chat: the work split there ends (its parts stop; settled results can reach nobody).
      bus.on('conversation.removed', ({ id }) => {
        try { this.runner.stop({ conversationId: id }, HUMAN_ID, CHAT_REMOVED); } catch (error) { this.core.deps.log.warn('splits of a removed chat not stopped', { error: String(error) }); }
        this.endSettled({ conversationId: id });
      }),
      // Parts waiting for an account (holds.ts) start when one becomes usable.
      bus.on('account.upserted', (account) => outages.account(account)),
      bus.on('account.removed', ({ id }) => outages.removed(id)),
      bus.on('models.updated', (models) => outages.models(models)),
    ];
    return () => { for (const off of offs) off(); };
  }

  /** Settled groups that can no longer be gathered (their chat is gone, their agent archived) end as stopped; their sessions go. */
  private endSettled(q: { agentId?: string; conversationId?: string }): void {
    try {
      const groups = this.core.repo.listGroups({ ...q, statuses: ['settled'] });
      for (const group of groups) {
        this.core.repo.updateGroup(group.id, { status: 'stopped' });
        try { this.core.deps.wakes.cancelKey?.(group.agentId, coalesceKey(group.id)); } catch { /* the wake finds nothing to gather */ }
        this.core.release(this.core.repo.listSplits({ groupId: group.id }));
      }
      this.core.emit(groups.map((group) => group.id));
    } catch (error) {
      this.core.deps.log.warn('settled splits not ended', { ...q, error: String(error) });
    }
  }

  /** Stops as the person when anything still runs or waits there (cheap no-op otherwise). */
  private stopLive(q: { agentId?: string }, reason: string): void {
    try {
      if (!this.core.repo.listSplits({ ...q, statuses: LIVE_SPLITS }).length) return;
      this.runner.stop(q, HUMAN_ID, reason);
    } catch (error) {
      this.core.deps.log.warn('splits not stopped', { ...q, error: String(error) });
    }
  }
}
