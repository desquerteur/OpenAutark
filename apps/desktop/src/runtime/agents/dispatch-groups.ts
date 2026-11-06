// Dispatcher rules for one pump (pure, no queue writes): claimed wakes are grouped by
// (chat, task) – B-054: a wake with neither chat nor task also by its origin's source, so a mail, task news and a
// review never fold into one turn (groupKey; chat and task groups are unchanged; the group keeps the oldest origin);
// the most important group runs first (answer/approval > handoff/child >
// message/manual > task/event > schedule > retry/review/report; the chats – or single tasks – that
// urgent() named beat everything, in the order named); within a rank the more urgent task goes first (task
// priority 2 > 1 > 0, then an overdue task, T10), then the earliest wake due time; message groups
// with nothing unseen any more (e.g. the message was steered into the previous turn) are stale and
// need no paid turn – so is a pure quiet pickup whose lines another turn read meanwhile; the quiet pickup's note
// travels only on a pure review turn (B-050 K4). Plus small time/capacity helpers.
// B-050 group cost (live scenario 4: an AI-only work group answered twice and polled for replies):
//  - a chat's plain message wakes ride along with a hand-over or a colleague's result ('handoff'/'child') in that
//    chat: one turn reads the line and takes the work (rideAlong), as 'message' – its answer reaches the other
//    member of a room of two (K3) – at the hand-over's rank;
//  - a group that only answers colleagues' still running turns – every unseen line was posted by such a turn, its
//    'child' results are their tasks – waits for them to end (waitsFor; the dispatcher pumps it when they ended):
//    a line and a task of one turn reach the colleague in one turn, and its reply comes as the sender's next turn anyway;
//    Nachtrag Runde 5: a quiet pickup too (a quiet answer sent mid-turn waits for that turn; one waits while any colleague answers there);
//  - a hand-over whose task is finished already needs no turn (isStaleHandOver); one that arrives after the agent
//    already wrote in that chat without it carries a note naming those lines (answeredNote) instead of a second answer.
// Owns: those rules. Never: claims/releases wakes or runs turns (dispatcher.ts does).

import * as os from 'node:os';
import type { ChatService, Wake } from '../contracts.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import type { Origin } from '../../shared/model/origin.ts';
import type { Task, TaskStatus } from '../../shared/model/tasks.ts';
import { QUIET_NOTE } from '../chat/quiet-pickup.ts';
import { PICKED_NOTE } from '../chat/responders.ts';

/** Lower runs first. */
export const REASON_RANK: Record<WakeReason, number> = {
  answer: 0, approval: 0,
  handoff: 1, child: 1,
  message: 2, manual: 2, setup: 2, // B-044: a setup wake still queued from before B-066 (nothing queues one now)
  task: 3, event: 3, // B-054: an outside event (a new mail) runs where mail ran before as 'task'
  schedule: 4,
  retry: 5, review: 5, report: 5, // T08: a manager's bundled report of finished work is background like a review
  split: 6, // B-057: a split's run (its own lane) – never a queued wake, so it ranks last
};

export interface WakeGroup {
  conversationId?: string;
  taskId?: string;
  /** B-054: the oldest origin of its wakes (becomes TurnRequest.origin). */
  origin?: Origin;
  /** B-054 fix: the note of the wake that origin came from – only an outside event's ('event'), never an agent's own. */
  originNote?: string;
  wakes: Wake[];
  /** Strongest reason in the group (becomes TurnRequest.reason). */
  reason: WakeReason;
  rank: number;
  dueAt: number; // earliest
  createdAt: number; // earliest
  /** T10 (taskFacts): the task's priority (0 without a task) and whether its due time has passed. */
  priority: Task['priority'];
  overdue: boolean;
  /** B-050: a note the dispatcher adds for this turn (answeredNote), after the wakes' own notes. */
  aware?: { text: string; at: number };
}

/** A running turn as waitsFor sees it (dispatch-runs.ts RunEntry). */
export interface RunningTurn {
  agentId: string;
  runId: string;
  taskId?: string;
}

/** What runs next after urgent(): a chat, or one task in it (a task made urgent, T10). */
export interface UrgentPick {
  conversationId: string;
  taskId?: string;
}

function rankOf(reason: WakeReason): number {
  return REASON_RANK[reason] ?? REASON_RANK.retry;
}

/** What a chat's plain message wakes ride along with (B-050): a hand-over or a colleague's result in that chat. */
const CARRIERS: ReadonlySet<WakeReason> = new Set<WakeReason>(['handoff', 'child']);

/** A note that keeps a message wake plain: none, or the responder pick's (C4-live, chat/responders.ts PICKED_NOTE). */
const plainNote = (wake: Wake): boolean => !(wake.note && wake.note.trim()) || wake.note === PICKED_NOTE;

/** A plain message wake: a line to answer, no task and no note but the pick's (the shape isStaleMessageGroup checks). */
const plainMessage = (wake: Wake): boolean => wake.reason === 'message' && !wake.taskId && plainNote(wake);

/** A quiet pickup (chat/quiet-pickup.ts: 'review' under quiet:<chat> with QUIET_NOTE, no task) – it too answers the chat's unseen lines. */
const quietPickup = (wake: Wake): boolean => wake.reason === 'review' && !wake.taskId && wake.note === QUIET_NOTE;

/** What waitsFor checks against the chat's unseen lines: a plain line or a quiet pickup. */
const answersLines = (wake: Wake): boolean => plainMessage(wake) || quietPickup(wake);

/**
 * B-050 group cost: the plain message group of a chat joins a hand-over or a colleague's result in the same chat,
 * so one turn reads the line and takes the work – before, one turn answered the line and the next the task (the
 * colleague answered twice). The joined group runs as 'message' (K3: its answer reaches the other member of a
 * room of two; an answer or approval in it stays the reason) at the hand-over's rank.
 */
function rideAlong(groups: WakeGroup[]): WakeGroup[] {
  const out = [...groups];
  for (const lines of groups) {
    if (lines.taskId || !lines.conversationId || !lines.wakes.every(plainMessage)) continue;
    const carrier = out.find((group) => group.taskId && group.conversationId === lines.conversationId && group.wakes.some((wake) => CARRIERS.has(wake.reason)));
    if (!carrier) continue;
    carrier.wakes.push(...lines.wakes);
    if (CARRIERS.has(carrier.reason)) carrier.reason = 'message';
    carrier.dueAt = Math.min(carrier.dueAt, lines.dueAt);
    carrier.createdAt = Math.min(carrier.createdAt, lines.createdAt);
    out.splice(out.indexOf(lines), 1);
  }
  return out;
}

/**
 * B-054: the group a wake joins – its chat and task as before; only a wake with neither also by its origin's source,
 * so chat-free, task-free work of different sources runs as separate turns (each on its own thread, origin.ts).
 */
export function groupKey(wake: Pick<Wake, 'conversationId' | 'taskId' | 'origin'>): string {
  const conv = wake.conversationId ?? '';
  const task = wake.taskId ?? '';
  return `${conv}\u0000${task}\u0000${conv || task ? '' : wake.origin?.source ?? ''}`;
}

/** The note an outside event's wake brings with its origin (an 'event' wake only: app text, quoted as data). */
function eventNote(wake: Wake): { originNote?: string } {
  return wake.origin && wake.reason === 'event' && wake.note?.trim() ? { originNote: wake.note } : {};
}

/** Groups wakes by groupKey, plain lines riding along with a hand-over of their chat; keeps the input order inside a group. */
export function groupWakes(wakes: Wake[]): WakeGroup[] {
  const groups = new Map<string, WakeGroup>();
  for (const wake of wakes) {
    const key = groupKey(wake);
    const rank = rankOf(wake.reason);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        conversationId: wake.conversationId, taskId: wake.taskId, ...(wake.origin ? { origin: wake.origin } : {}), ...eventNote(wake), wakes: [wake],
        reason: wake.reason, rank, dueAt: wake.dueAt, createdAt: wake.createdAt, priority: 0, overdue: false,
      });
      continue;
    }
    group.wakes.push(wake);
    if (wake.origin && (!group.origin || wake.createdAt < group.createdAt)) { // the oldest origin wins (queue.ts merges alike)
      group.origin = wake.origin;
      group.originNote = eventNote(wake).originNote; // its note goes with it – or none
    }
    if (rank < group.rank) { group.rank = rank; group.reason = wake.reason; }
    group.dueAt = Math.min(group.dueAt, wake.dueAt);
    group.createdAt = Math.min(group.createdAt, wake.createdAt);
  }
  return rideAlong([...groups.values()]);
}

/** Fills each task group's priority and overdue flag from its task (an unknown task counts as normal). */
export function taskFacts(groups: WakeGroup[], taskOf: (id: string) => Pick<Task, 'priority' | 'dueAt'> | undefined, now: number): void {
  for (const group of groups) {
    const task = group.taskId ? taskOf(group.taskId) : undefined;
    group.priority = task?.priority ?? 0;
    group.overdue = task?.dueAt !== undefined && task.dueAt <= now;
  }
}

/** True when the group is what urgent() named: its chat, and its task when one was named. */
export function isUrgent(group: WakeGroup, pick: UrgentPick | undefined): boolean {
  return Boolean(pick) && sameChat(group.conversationId, pick!.conversationId) && (pick!.taskId === undefined || group.taskId === pick!.taskId);
}

/** B-054 fix: no chat is no chat – '' (a chat-free task's group) and undefined (its group) match. */
const sameChat = (a: string | undefined, b: string | undefined): boolean => (a || '') === (b || '');

/** Sort order: the urgent pick first, then rank, task priority, overdue, the oldest due time, then creation. */
export function compareGroups(a: WakeGroup, b: WakeGroup, urgent?: string | UrgentPick): number {
  const pick = typeof urgent === 'string' ? { conversationId: urgent } : urgent;
  if (pick) {
    const ua = isUrgent(a, pick) ? 0 : 1;
    const ub = isUrgent(b, pick) ? 0 : 1;
    if (ua !== ub) return ua - ub;
  }
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
  return a.createdAt - b.createdAt;
}

export function pickGroup(groups: WakeGroup[], urgent?: string | UrgentPick): WakeGroup | undefined {
  return [...groups].sort((a, b) => compareGroups(a, b, urgent))[0];
}

/** Queues a pick behind the ones urgent() named before (each chat or task once). */
export function addPick(picks: UrgentPick[] = [], pick: UrgentPick): UrgentPick[] {
  return picks.some((item) => sameChat(item.conversationId, pick.conversationId) && item.taskId === pick.taskId) ? picks : [...picks, pick];
}

/**
 * The group to run: that of the first pick with live wakes, else the normal order. `left` are the
 * picks still waiting – one ends once its chat (task) runs, or has nothing left to run.
 */
export function nextGroup(live: WakeGroup[], picks: UrgentPick[] = []): { group?: WakeGroup; left: UrgentPick[] } {
  const pick = picks.find((item) => live.some((group) => isUrgent(group, item)));
  const group = pickGroup(live, pick);
  return { group, left: picks.filter((item) => item !== pick && live.some((other) => other !== group && isUrgent(other, item))) };
}

export function wakeIds(groups: WakeGroup[]): string[] {
  return groups.flatMap((group) => group.wakes.map((wake) => wake.id));
}

/**
 * The group's wake notes for the turn input ("My own scheduled note from …" for schedules). The quiet
 * pickup's note ("nobody expects an answer … else [[internal]]") only on a pure review turn: merged
 * with other work (a person's new line, a task) it would silence an answer someone waits for – the
 * quiet lines still read "(quiet)" in the context. The dispatcher's own note for the turn (`aware`) comes last.
 */
export function notesOf(group: WakeGroup): Array<{ text: string; at: number; reason?: WakeReason }> {
  const review = group.wakes.every((wake) => wake.reason === 'review');
  const notes = group.wakes
    .filter((wake) => wake.note && wake.note.trim() && (review || wake.note !== QUIET_NOTE))
    .map((wake) => ({ text: wake.note!, at: wake.createdAt, reason: wake.reason }))
    .sort((a, b) => a.at - b.at);
  return group.aware ? [...notes, group.aware] : notes;
}

/**
 * True for a plain message group (only 'message' wakes without notes, no task) – or a pure quiet pickup ('review'
 * wakes with only the pickup's note, B-050 K4) – whose chat has nothing new for the agent: no line after its cursor
 * from someone else. Also true when the agent is no longer a member (its answer could not be posted anyway).
 * Unknown state → false (the turn executor decides).
 */
export function isStaleMessageGroup(chats: Pick<ChatService, 'members' | 'messages'>, agentId: string, group: WakeGroup): boolean {
  if (!group.conversationId || group.taskId) return false;
  const unseenOnly = (wake: Wake) => (wake.reason === 'message' && plainNote(wake)) || (wake.reason === 'review' && wake.note === QUIET_NOTE);
  if (!group.wakes.every(unseenOnly)) return false;
  try {
    const member = chats.members(group.conversationId).find((item) => item.memberId === agentId && !item.leftAt);
    if (!member) return true;
    const unseen = chats.messages(group.conversationId, { afterSeq: member.readSeq, limit: 200 });
    return !unseen.some((message) => message.authorId !== agentId && message.kind !== 'status' && message.state !== 'streaming');
  } catch {
    return false;
  }
}

/**
 * B-050 group cost: the colleagues whose still running turns this group only answers – every unseen line from
 * others in its chat was posted by such a turn (message.runId), and each 'child' result is the task of such a
 * turn. The group waits for them to end: that turn may still add to its request (another line, a task for the
 * same thing), and its sender reads the reply only in a turn of its own anyway. Nachtrag Runde 5: a quiet pickup counts
 * like a plain line – a colleague's quiet answer sent by chat.send mid-turn is picked up once that turn ended, not 5 s
 * after the line while it still runs (the asker then needed a second turn for what followed). Live round 5: a pure pickup
 * also waits beside lines of finished runs (a colleague still answers there). Empty: it runs now – any other wake, a
 * person's line, a line of a finished run (a pickup: only such lines), nothing unseen, or unknown state.
 */
export function waitsFor(chats: Pick<ChatService, 'members' | 'messages'>, agentId: string, group: WakeGroup, running: readonly RunningTurn[]): string[] {
  const colleagues = new Set<string>();
  for (const wake of group.wakes) {
    if (answersLines(wake)) continue;
    const turn = wake.reason === 'child' && wake.taskId ? running.find((item) => item.taskId === wake.taskId && item.agentId !== agentId) : undefined;
    if (!turn) return [];
    colleagues.add(turn.agentId);
  }
  if (group.wakes.some(answersLines)) {
    if (!group.conversationId) return [];
    try {
      const member = chats.members(group.conversationId).find((item) => item.memberId === agentId && !item.leftAt);
      if (!member) return [];
      const unseen = chats.messages(group.conversationId, { afterSeq: member.readSeq, limit: 200 })
        .filter((message) => message.authorId !== agentId && message.kind !== 'status');
      if (!unseen.length) return [];
      const pickup = group.wakes.every(quietPickup); // live round 5: a pure pickup also waits for colleagues still answering there
      for (const message of unseen) {
        const turn = message.runId ? running.find((item) => item.agentId === message.authorId && item.runId === message.runId) : undefined;
        if (turn) colleagues.add(turn.agentId);
        else if (!pickup) return [];
      }
    } catch {
      return [];
    }
  }
  return [...colleagues];
}

/** A hand-over ('handoff' wakes only) whose task is finished already – done in a turn that read its line: no paid turn. */
export function isStaleHandOver(group: WakeGroup, statusOf: (taskId: string) => TaskStatus | undefined): boolean {
  if (!group.taskId || !group.wakes.every((wake) => wake.reason === 'handoff')) return false;
  const status = statusOf(group.taskId);
  return status === 'done' || status === 'cancelled';
}

/**
 * B-050 made aware: the agent already wrote in this chat after the task was handed to it (the newest hand-over line
 * "X → agent" about it, agents/handoff.ts), in a turn that did not have it – its 'handoff' wake still waited, e.g. it
 * answered the colleague's line while the hand-over arrived. The note names those lines, so a reply that already
 * does what the task asks finishes the task instead of being said again. Undefined: nothing of the kind (or unknown state).
 */
export function answeredNote(chats: Pick<ChatService, 'messages'>, agentId: string, group: WakeGroup): string | undefined {
  if (!group.taskId || !group.conversationId || !group.wakes.some((wake) => wake.reason === 'handoff')) return undefined;
  try {
    const recent = chats.messages(group.conversationId, { limit: 100 });
    const since = recent.filter((message) => message.taskId === group.taskId && message.meta.status?.type === 'handoff' && message.meta.status.details?.to === agentId).at(-1)?.seq;
    if (since === undefined) return undefined;
    const own = recent.filter((message) => message.seq > since && message.authorId === agentId && message.kind === 'text' && message.state !== 'streaming');
    if (!own.length) return undefined;
    const seqs = own.map((message) => `#${message.seq}`).join(', ');
    return `I already wrote in this chat after this task reached me (${seqs}), in a turn that did not have the task yet. If that already does what it asks, I finish it with tasks.complete (evidence: ${seqs}) instead of saying it again; otherwise I continue the task.`;
  } catch {
    return undefined;
  }
}

/** Start of the next calendar month in UTC (budget periods are UTC months). */
export function nextUtcMonthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** Default global cap of parallel turns: clamp(cpus − 2, 2, 6). */
export function defaultMaxConcurrent(cpus: number = os.availableParallelism?.() ?? os.cpus().length): number {
  return Math.min(6, Math.max(2, cpus - 2));
}

/** Resolves when all promises settled or after `ms` (whichever comes first). */
export async function settleWithin(promises: Array<Promise<unknown>>, ms: number): Promise<void> {
  if (!promises.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); });
  try {
    await Promise.race([Promise.allSettled(promises).then(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
