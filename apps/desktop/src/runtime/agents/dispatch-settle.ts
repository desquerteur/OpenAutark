// How the dispatcher settles a main-lane turn that did not end the normal way (B-059), next to dispatch-runs.ts:
// - #17 the executor threw after the run started (a database write in finish, a block parser, the lease …): the run is
//   closed as failed (dispatch-runs.ts closeRun), this run's placeholder that still streams ends as a failed bubble
//   (the person's Retry, as when a turn fails before its engine – turn.ts; a background run's silent row goes) and a task turn gets its normal after-turn
//   handling (ownership.afterTurn 'failed': the follow-up with its pause, never a silent 'working' task) –
//   only when the run was still open (else its own finish may have run afterTurn), never after the person's Stop or a
//   shutdown, and not when its wakes go back to the queue anyway.
// - #18 last-resort release: a turn that has not ended RELEASE_MS (60 s) after its abort (the person's Stop, an urgent
//   hand-over, a shutdown) – a tool or engine that ignores its abort signal – is released: its slot frees, its run ends
//   'interrupted' with a journal note, its calls in flight become 'unknown' in the journal (markOwnUnknown and the
//   pending ones), its streaming bubble ends 'stopped', and after the person's Stop its task pauses ('stopped'). Accepted: the hung work
//   may still end later (its late answer can still be posted; the dispatcher's bookkeeping ignores it).
//   B-057: a split lane is released the same way – its run closed and its cut calls marked, no bubble, groups or task –
//   and its lane frees; the split service hears the person's Stop then (dispatch-runs.ts release → split-turn.ts
//   turnEndedEarly), a shutdown's cut only from the hung turn's own late end (no second turn on its session meanwhile).
// Owns: those settle steps, each best effort. Never: re-runs a turn, decides a split's lifecycle (the split service
// does), or decides what runs next.

import type { RuntimeServices } from '../contracts.ts';
import type { Message } from '../../shared/model/chat.ts';
import { RunItemRepo } from '../store/runs.ts';
import type { RunEntry } from './dispatch-runs.ts';

/** How long an aborted turn may take to end before it is released. */
export const RELEASE_MS = 60_000;
export const CRASH_NOTE = 'The turn failed unexpectedly.';
export const RELEASED_NOTE = 'The turn did not stop; it was released.';

/** #18: arms the release once the turn is aborted – B-057: a split lane's too (one unref'd timer per abort; a turn that ended is skipped by `release`). */
export function armRelease(entry: RunEntry, ms: number, release: () => void): void {
  entry.controller.signal.addEventListener('abort', () => {
    const timer = setTimeout(release, ms);
    (timer as { unref?: () => void }).unref?.();
  }, { once: true });
}

/** #17: the executor threw – the streaming bubble fails and a task turn that was still open gets its after-turn handling. */
export function settleCrash(services: RuntimeServices, entry: RunEntry, wasOpen: boolean): void {
  endStreaming(services, entry, 'failed', CRASH_NOTE);
  if (!entry.taskId || !wasOpen || entry.control.stopKind || entry.settle === 'release' || entry.split) return;
  try {
    services.ownership.afterTurn({ agentId: entry.agentId, taskId: entry.taskId, runId: entry.runId, outcome: 'failed', progressed: false, note: CRASH_NOTE });
  } catch (error) {
    services.log.warn('after-turn of a crashed turn failed', { taskId: entry.taskId, error: String(error) });
  }
}

/** #18: the turn did not end after its abort – close its run, name its cut calls, end its bubble; the caller frees the slot. */
export function abandonRun(services: RuntimeServices, entry: RunEntry): void {
  const stopKind = entry.control.stopKind;
  services.log.warn('turn did not stop after its abort; released', { agentId: entry.agentId, runId: entry.runId, stopKind });
  let open = false;
  try {
    services.runs.item(entry.runId, { kind: 'note', data: { released: true, ...(stopKind ? { stopKind } : {}) }, effectStatus: 'none' });
    const run = services.runs.get(entry.runId);
    open = run !== undefined && (run.status === 'running' || run.status === 'queued');
    if (open) services.runs.finish(entry.runId, { status: 'interrupted', endedAt: services.clock.now(), error: RELEASED_NOTE });
  } catch (error) {
    services.log.warn('released run not closed', { runId: entry.runId, error: String(error) });
  }
  markCut(services, entry.runId);
  if (entry.split) return; // B-057: a split lane has no bubble, groups or task – its release tells the split service (dispatch-runs.ts)
  endStreaming(services, entry, 'stopped');
  // B-057: the groups this turn split start now – or, after the person's Stop, never (S13); its late finish finds none pending.
  try { services.splits?.afterParentTurn(entry.runId, stopKind === 'human' ? 'stopped' : 'failed'); } catch (error) { services.log.warn('splits of a released turn not settled', { runId: entry.runId, error: String(error) }); }
  if (!entry.taskId || !open || stopKind !== 'human') return; // urgent/shutdown: its wakes come back with the task
  try {
    services.ownership.afterTurn({ agentId: entry.agentId, taskId: entry.taskId, runId: entry.runId, outcome: 'stopped', progressed: false, note: RELEASED_NOTE });
  } catch (error) {
    services.log.warn('after-turn of a released turn failed', { taskId: entry.taskId, error: String(error) });
  }
}

/** Native calls without a result and our calls still pending become 'unknown' in the journal. */
function markCut(services: RuntimeServices, runId: string): void {
  try {
    for (const item of new RunItemRepo(services.db).markOwnUnknown([runId])) services.bus.emit('run.item', item);
    for (const item of services.runs.items(runId)) {
      if (item.kind === 'tool_call' && item.effectStatus === 'pending') services.runs.updateItem(item.id, { effectStatus: 'unknown' });
    }
  } catch (error) {
    services.log.warn('cut calls of a released turn not marked', { runId, error: String(error) });
  }
}

/**
 * This run's row that still streams (found among the chat's live rows, however much came after it) ends as `state`, its
 * streamed text kept; a silent one (a background run's live row) goes, as nothing was posted (chat/publish-message.ts).
 */
function endStreaming(services: RuntimeServices, entry: RunEntry, state: Message['state'], error?: string): void {
  if (!entry.conversationId) return;
  try {
    const live = services.chats.summary(entry.conversationId).live?.find((run) => run.runId === entry.runId);
    const message = live && services.chats.message(live.messageId);
    if (message?.state === 'streaming') services.chats.finishAgentMessage(message.id, { body: message.body, state, ...(error ? { meta: { error } } : {}) });
  } catch (failure) {
    services.log.warn('streaming bubble not ended', { runId: entry.runId, error: String(failure) });
  }
}
