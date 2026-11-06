// OwnershipService – one simple rule: an owner keeps working on its task until it is done or it asks.
// After each turn of the task's owner (or of the lead, for unowned team work):
//  - a finished task plans nothing; another agent's turn on it (a manager helping) plans nothing either;
//  - a task that waits (waiting, needs you, blocked, or a turn that ended 'waiting') gets one re-check after a day –
//    the event it waits on (an answer, a message, a child's result) wakes the owner sooner;
//  - a usage limit or an outage retries after 1 min, doubling up to 30 min, and at once when an account becomes
//    usable or a model available (watchOutages – events, no timer);
//  - any other turn continues: soon after a turn that did something (progressed), else with a doubling pause
//    (1 min · 2^n, at most a day; n = turns in a row without progress, ledger.stalls).
// A person's Stop pauses the task (no retry until they resume it).
// recover(): after a restart every unfinished agent task gets one wake; work a cut-off run belonged to (chat or task)
// hears INTERRUPTED_NOTE.
// Owns: the follow-up wakes and ledger.tried / stalls / nextCheckAt. Never: completes, blocks or escalates a task.

import { HUMAN_ID, SYSTEM_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { OwnershipService, RuntimeServices } from '../contracts.ts';
import type { TaskLedger, TaskView } from '../../shared/model/tasks.ts';
import { dropFollowUps, isPaused, roleOf } from './owners.ts';
import { dropRechecks } from './lifecycle.ts';
import { INTERRUPTED_NOTE } from './recover-notes.ts';
import { OutageTracker, isOutage, onlineDeliveryAt } from '../agents/outages.ts';

export type OwnershipDeps = Pick<RuntimeServices, 'tasks' | 'wakes' | 'chats' | 'clock'>
  & Partial<Pick<RuntimeServices, 'org' | 'log' | 'bus' | 'accounts' | 'catalog' | 'host' | 'runs'>>;

export const CONTINUE_MS = 1000;
export const STALL_BASE_MS = 60_000;
export const STALL_MAX_MS = 24 * 3600_000;
export const OUTAGE_MAX_MS = 30 * 60_000;
export const RECHECK_MS = 24 * 3600_000;
const TRIED_CAP = 20;

const CONTINUE_NOTE = 'I continue the task.';
const STALL_NOTE = 'My last turn did not move this task. I continue, try another way, or ask someone (human.ask, a colleague) when I need help.';
const OUTAGE_NOTE = 'The last turn could not reach a model (usage limit, signed out or connection lost). I continue the task.';
const RECHECK_NOTE = 'I re-check what this task is waiting on.';
const PICK_OWNER_NOTE = 'Nobody owns this task yet. I give it an owner (tasks.assign) or take it myself (tasks.claim).';
const WAITING: ReadonlySet<string> = new Set(['waiting', 'needs_you', 'blocked']);

type TurnInput = Parameters<OwnershipService['afterTurn']>[0];

/** The pause after `stalls` turns in a row without progress: 1 min, 2 min, 4 min … at most a day. */
export function stallDelay(stalls: number): number {
  return Math.min(STALL_BASE_MS * 2 ** Math.max(0, stalls - 1), STALL_MAX_MS);
}

/** Outages in a row at the end of `tried`. */
function outageStreak(tried: TaskLedger['tried']): number {
  let count = 0;
  for (let index = (tried?.length ?? 0) - 1; index >= 0 && isOutage(tried![index].outcome); index--) count++;
  return count;
}

export class OwnershipServiceImpl implements OwnershipService {
  private readonly s: OwnershipDeps;
  private offOutages: (() => void) | undefined;

  constructor(deps: OwnershipDeps) {
    this.s = deps;
  }

  afterTurn(input: TurnInput): void {
    const task = this.s.tasks.get(input.taskId);
    if (!task) return;
    if (task.status === 'done' || task.status === 'cancelled') { this.s.wakes.cancelTask(task.id, ['retry']); dropRechecks(this.s.wakes, task); return; }
    const role = roleOf(task, input.agentId);
    if (role === 'other') { dropFollowUps(this.s, task, input.agentId); return; }
    if (input.outcome === 'stopped') { this.pause(task, input.agentId); return; }
    if (isPaused(task)) return; // the person's next message, an answer or Resume continues it
    const now = this.s.clock.now();
    const ledger: TaskLedger = { ...task.ledger };
    ledger.tried = [...(ledger.tried ?? []), { approach: excerpt(input.approach ?? input.note ?? input.outcome, 160), outcome: input.outcome, at: now }].slice(-TRIED_CAP);
    const attempts = task.attempts + (isOutage(input.outcome) ? 0 : 1);

    if (input.outcome === 'waiting' || WAITING.has(task.status)) {
      this.follow(task, ledger, attempts, input.agentId, now + RECHECK_MS, RECHECK_NOTE, 'review');
      return;
    }
    if (isOutage(input.outcome)) {
      const delay = Math.max(Math.min(STALL_BASE_MS * 2 ** Math.max(0, outageStreak(ledger.tried) - 1), OUTAGE_MAX_MS), input.retryAfterMs ?? 0);
      this.follow(task, ledger, attempts, input.agentId, now + delay, OUTAGE_NOTE);
      return;
    }
    if (input.progressed || input.outcome === 'interrupted') {
      ledger.stalls = 0;
      ledger.lastProgressAt = input.progressed ? now : ledger.lastProgressAt;
    } else {
      ledger.stalls = (ledger.stalls ?? 0) + 1;
    }
    const delay = ledger.stalls ? stallDelay(ledger.stalls) : CONTINUE_MS;
    const note = role === 'lead' ? PICK_OWNER_NOTE : input.outcome === 'interrupted' ? INTERRUPTED_NOTE : ledger.stalls ? STALL_NOTE : CONTINUE_NOTE;
    this.follow(task, ledger, attempts, input.agentId, now + delay, note, role === 'lead' ? 'review' : 'retry');
  }

  recover(input: { interruptedRuns?: readonly string[] } = {}): number {
    const now = this.s.clock.now();
    const cut = new Set<string>();
    const chats = new Map<string, { agentId: string; conversationId: string }>();
    for (const runId of input.interruptedRuns ?? []) {
      const run = this.s.runs?.get(runId);
      if (!run) continue;
      if (run.taskId) cut.add(run.taskId);
      else if (run.conversationId) chats.set(`${run.agentId}:${run.conversationId}`, { agentId: run.agentId, conversationId: run.conversationId });
    }
    const active = (agentId: string) => { if (!this.s.org) return true; const owner = this.s.org.get(agentId); return owner !== undefined && owner.archivedAt === undefined; };
    let continued = 0;
    for (const task of this.s.tasks.list({ status: ['open', 'working', 'waiting', 'needs_you', 'blocked'], includeSteps: true, limit: 1000 })) {
      if (task.assigneeKind !== 'agent' || !task.assigneeId || !active(task.assigneeId) || isPaused(task)) continue;
      if (task.parentId && task.status === 'open') continue; // a step is worked through its task
      const waits = WAITING.has(task.status);
      const planned = task.ledger.nextCheckAt;
      const due = planned !== undefined && planned > now ? planned : waits ? now + RECHECK_MS : now; // a planned pause survives a restart
      const note = cut.has(task.id) ? INTERRUPTED_NOTE : waits ? RECHECK_NOTE : CONTINUE_NOTE;
      if (!waits) continued++;
      this.wake(task, task.assigneeId, cut.has(task.id) ? now : due, waits ? 'review' : 'retry', note);
    }
    // Interrupted chat turns (no task): one note wake per agent and chat; it joins the re-queued wake of that chat.
    for (const { agentId, conversationId } of chats.values()) {
      if (active(agentId)) this.s.wakes.wake({ agentId, reason: 'retry', conversationId, dueAt: now, note: INTERRUPTED_NOTE, coalesceKey: `recover:${conversationId}` });
    }
    return continued;
  }

  /** Outages end with an event: an account that becomes usable or a model that becomes available, the host back online. Idempotent; returns the unsubscribe. */
  watchOutages(): () => void {
    const bus = this.s.bus;
    if (!bus) return () => {};
    if (this.offOutages) return this.offOutages;
    const tracker = new OutageTracker(this.accounts(), this.s.catalog?.list() ?? [], this.s.clock.now());
    const offs = [
      bus.on('account.upserted', (account) => { if (tracker.account(account, this.s.clock.now())) this.endOutages(); }),
      bus.on('account.removed', ({ id }) => tracker.removed(id)),
      bus.on('models.updated', (list) => { if (tracker.models(list)) this.endOutages(); }),
    ];
    try {
      if (this.s.host) offs.push(this.s.host.onPower((event) => { if (event === 'online') this.endOutages(onlineDeliveryAt(this.accounts(), this.s.clock.now())); }));
    } catch { /* a host without power events */ }
    this.offOutages = () => { for (const off of offs.splice(0)) off(); this.offOutages = undefined; };
    return this.offOutages;
  }

  /** Brings the planned retries of tasks whose last turn met an outage forward to `at` (default now). */
  endOutages(at = this.s.clock.now()): void {
    const hit = new Map(this.s.tasks.list({ status: ['open', 'working'], includeSteps: true, limit: 1000 })
      .filter((task) => isOutage(task.ledger.tried?.at(-1)?.outcome ?? '') && !isPaused(task)).map((task) => [task.id, task]));
    if (!hit.size) return;
    const agents = new Set<string>();
    for (const task of hit.values()) {
      if (task.assigneeKind === 'agent' && task.assigneeId) agents.add(task.assigneeId);
      else if (task.assigneeKind === 'team') for (const agent of this.s.org?.list() ?? []) agents.add(agent.id);
    }
    for (const agentId of agents) {
      const ids = this.s.wakes.list(agentId)
        .filter((wake) => wake.taskId !== undefined && hit.has(wake.taskId) && wake.claimedAt === undefined && wake.dueAt > at && (wake.reason === 'retry' || wake.reason === 'review'))
        .map((wake) => wake.id);
      if (ids.length) this.s.wakes.release(ids, at);
    }
  }

  // ------------------------------------------------------------- internals

  private accounts() {
    try { return this.s.accounts?.list() ?? []; } catch { return []; }
  }

  /** Plans the next turn; the due time also goes into the ledger (a restart keeps it). */
  private follow(task: TaskView, ledger: TaskLedger, attempts: number, agentId: string, due: number, note: string, reason: 'retry' | 'review' = 'retry'): void {
    ledger.nextCheckAt = due;
    try { this.s.tasks.update(task.id, { ledger, attempts }, SYSTEM_ID); } catch (error) {
      this.s.log?.warn('ownership ledger save failed', { taskId: task.id, error: String(error) });
    }
    this.wake(task, agentId, due, reason, note);
  }

  /** The task's one planned follow-up wake (coalesced per task). */
  private wake(task: TaskView, agentId: string, dueAt: number, reason: 'retry' | 'review', note: string): void {
    this.s.wakes.wake({ agentId, reason, conversationId: task.conversationId, taskId: task.id, dueAt, note, coalesceKey: `own:${task.id}` });
  }

  /** The person pressed Stop: nothing is retried; the task waits for them ("Paused by you"). */
  private pause(task: TaskView, agentId: string): void {
    dropFollowUps(this.s, task, agentId, true);
    try { this.s.tasks.pause?.(task.id, HUMAN_ID); } catch (error) {
      this.s.log?.warn('ownership pause failed', { taskId: task.id, error: String(error) });
    }
  }
}
