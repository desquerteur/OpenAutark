// Fan-in of split groups (B-057 S6/S15): when every split of a running group has ended, the group is 'settled' and its
// parent agent gets ONE wake – reason 'child', on the thread it split in (its chat, else its task, else its origin's
// source), coalesceKey 'splits:<groupId>', a short note; the group change and the wake are one transaction. The results
// are not in the note: the parent's next turn on that thread gets one "Split results" block (pendingResults – every
// settled group of the thread); when that turn ends 'done' the groups are 'gathered' (markGathered, which also
// withdraws a fan-in wake not yet claimed and releases the splits' native sessions – release.ts).
// A group the person stopped is never settled and wakes nobody. agents.split_results reads the full texts (results).
// Owns: settle, the parent's wake, pendingResults, markGathered and results. Never: starts or stops a split.

import { WorkforceError } from '../../shared/errors.ts';
import type { Split, SplitGroup } from '../../shared/model/splits.ts';
import { isTerminal, type SplitCore } from './core.ts';
import { fullResults, resultsBlock } from './results.ts';

export const coalesceKey = (groupId: string): string => `splits:${groupId}`;
const NOTE_GOAL = 120;

/** The fan-in wake's note (short; the results come as an input block). */
export function wakeNote(group: SplitGroup, statuses: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  const list = [...counts].map(([status, count]) => `${count} ${status}`).join(', ');
  const goal = group.goal.length > NOTE_GOAL ? `${group.goal.slice(0, NOTE_GOAL - 1)}…` : group.goal;
  return `My ${statuses.length === 1 ? 'split' : `${statuses.length} splits`} for "${goal}" ended (${list}). Their results are in this turn's input under "Split results": I merge them.`;
}

/** A running group whose splits all ended: settled, the parent woken once. True when it settled. */
export function settle(core: SplitCore, groupId: string): boolean {
  const group = core.repo.getGroup(groupId);
  if (!group || group.status !== 'running') return false;
  const splits = core.repo.listSplits({ groupId });
  if (!splits.every((split) => isTerminal(split.status))) return false;
  const { deps } = core;
  deps.db.tx(() => {
    core.repo.updateGroup(groupId, { status: 'settled', endedAt: core.now() });
    deps.wakes.wake({
      agentId: group.agentId, reason: 'child', note: wakeNote(group, splits.map((split) => split.status)), coalesceKey: coalesceKey(groupId),
      ...(group.conversationId ? { conversationId: group.conversationId } : {}), ...(group.taskId ? { taskId: group.taskId } : {}),
      ...(group.origin ? { origin: group.origin } : {}),
    });
  });
  return true;
}

/** The parent's "Split results" block for its next turn on `thread`: every settled group there, oldest first. */
export function pendingResults(core: SplitCore, agentId: string, thread: string): { groupIds: string[]; text: string } | undefined {
  const groups = core.repo.listGroups({ agentId, thread, statuses: ['settled'] }).reverse();
  if (!groups.length) return undefined;
  const splits = core.repo.listSplits({ groupIds: groups.map((group) => group.id) });
  const entries = groups.map((group) => ({ group, splits: splits.filter((split) => split.groupId === group.id).sort((a, b) => a.idx - b.idx) }));
  return { groupIds: groups.map((group) => group.id), text: resultsBlock(core.deps.runs, entries) };
}

/** The parent's turn `runId` that got those results ended 'done': the groups are gathered; returns the gathered ids. */
export function markGathered(core: SplitCore, runId: string, groupIds: readonly string[]): string[] {
  const now = core.now();
  const done: string[] = [];
  for (const id of new Set(groupIds)) {
    const group = core.repo.getGroup(id);
    if (!group || group.status !== 'settled') continue;
    core.repo.updateGroup(id, { status: 'gathered', gatheredAt: now });
    // The results reached the parent already: its fan-in wake (when not claimed yet) would bring nothing new.
    try { core.deps.wakes.cancelKey?.(group.agentId, coalesceKey(id)); } catch { /* the wake runs and finds no results */ }
    done.push(id);
  }
  if (!done.length) return done;
  core.deps.log.info('split results gathered', { runId, groups: done.length });
  core.release(core.repo.listSplits({ groupIds: done }));
  return done;
}

/**
 * agents.split_results: a group's (or its part's) full results; without groupId the thread's newest group (no thread: the
 * agent's). A named group of another thread is not shown there (the work of another chat stays there).
 */
export function results(core: SplitCore, agentId: string, q: { groupId?: string; idx?: number; thread?: string }): string {
  let group: SplitGroup | undefined;
  if (q.groupId) {
    group = core.repo.getGroup(q.groupId);
    if (!group || (q.thread !== undefined && group.agentId === agentId && group.thread !== q.thread)) throw new WorkforceError('not_found', `No split group ${q.groupId} in this thread.`);
    if (group.agentId !== agentId) throw new WorkforceError('forbidden', `Split group ${q.groupId} belongs to another agent.`);
  } else {
    // Only this thread's groups: the work of another chat stays there.
    group = core.repo.listGroups({ agentId, ...(q.thread !== undefined ? { thread: q.thread } : {}), limit: 1 })[0];
  }
  if (!group) return q.thread !== undefined ? 'I have no split results in this thread yet.' : 'I have no split results yet.';
  const splits = core.repo.listSplits({ groupId: group.id }).sort((a, b) => a.idx - b.idx);
  if (q.idx !== undefined && !splits.some((split) => split.idx === q.idx)) throw new WorkforceError('not_found', `Split group ${group.id} has no part #${q.idx}.`);
  return fullResults(core.deps.runs, group, splits, q.idx);
}
