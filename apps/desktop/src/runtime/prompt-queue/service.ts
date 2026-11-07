// AF-016 – the chats' prompt queues. One queue per chat, kept in the database (kv `promptQueue`, key = the chat id), so it
// survives a restart; every change is announced as queue.updated (topic chat:<id>). The top prompt goes out as the
// person's next message (the path of messages.send) once nothing works in the chat any more – no run of it at work, no
// row streaming, no chat wake waiting. Triggers, no polling: a run of the chat ended (run.upserted, checked after a short
// settle so the dispatcher has handed over), a prompt was lined up, the queue was resumed, and once after the start (the
// interrupted turns resume first). After a send the next waits a grace while it is decided who answers.
// It pauses by itself (rules.ts): a failed run ('error'), a run that asked the person ('ask'), the person's Stop ('stop' –
// messages.stop and runs.cancel call pause before they stop; the emergency stop through work.state). A pause holds until
// queue.resume; an emptied queue forgets its pause. A prompt that cannot be sent stays on top and pauses the queue.
// Owns: the queues, their storage and when the top prompt goes out. Never: decides who answers (chat delivery) or stops work.

import { HUMAN_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Run } from '../../shared/model/runs.ts';
import '../../shared/model/splits.ts'; // SendMessageInput / MessageMeta ultra (module augmentation)
import { QUEUE_LIMITS, emptyQueue, moveItem, type PromptQueue, type QueuePause, type QueuedPrompt } from '../../shared/model/prompt-queue.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { PromptQueueService, QueuedInput } from '../contracts/prompt-queue.ts';
import { KvRepo } from '../store/kv.ts';
import { afterRun, endsWithQuestion, hasAskBlock } from './rules.ts';

const NS = 'promptQueue';
const SETTLE_MS = 1200;
const SENT_GRACE_MS = 3000;
const START_MS = 5000;
const RECENT_ROWS = 30;

export interface PromptQueueDeps {
  services: () => RuntimeServices;
  /** Tests: shorter waits. */
  settleMs?: number;
  graceMs?: number;
  startMs?: number;
}

export class PromptQueues implements PromptQueueService {
  private readonly timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  private offs: Array<() => void> = [];

  private readonly deps: PromptQueueDeps;

  constructor(deps: PromptQueueDeps) { this.deps = deps; }

  private get s(): RuntimeServices { return this.deps.services(); }
  private kv(): KvRepo { return new KvRepo(this.s.db); }
  private now(): number { return this.s.clock.now(); }

  // ------------------------------------------------------------------ reads and writes

  get(conversationId: string): PromptQueue {
    return this.kv().get<PromptQueue>(NS, conversationId) ?? emptyQueue(conversationId);
  }

  private save(queue: PromptQueue): PromptQueue {
    const next: PromptQueue = { ...queue, updatedAt: this.now() };
    if (!next.items.length) delete next.paused; // an emptied queue forgets its pause
    if (next.items.length || next.paused) this.kv().set(NS, queue.conversationId, next, next.updatedAt);
    else this.kv().delete(NS, queue.conversationId);
    this.s.bus.emit('queue.updated', next);
    return next;
  }

  private item(queue: PromptQueue, id: string): QueuedPrompt {
    const found = queue.items.find((entry) => entry.id === id);
    if (!found) throw new WorkforceError('not_found', 'This queued message is gone.', { details: { id } });
    return found;
  }

  add(conversationId: string, input: QueuedInput): PromptQueue {
    const queue = this.get(conversationId);
    if (queue.items.length >= QUEUE_LIMITS.items) throw new WorkforceError('conflict', `The queue holds at most ${QUEUE_LIMITS.items} messages.`, { details: { conversationId } });
    const at = this.now();
    const saved = this.save({ ...queue, items: [...queue.items, { ...input, id: newId('pq'), createdAt: at, updatedAt: at }] });
    this.schedule(conversationId, 0);
    return saved;
  }

  update(conversationId: string, id: string, patch: Pick<QueuedPrompt, 'body'> & Partial<Pick<QueuedPrompt, 'attachments'>>): PromptQueue {
    const queue = this.get(conversationId);
    const current = this.item(queue, id);
    if (!patch.body.trim() && !(patch.attachments ?? current.attachments).length && !current.secrets?.length) throw new WorkforceError('bad_request', 'A queued message needs text or a file.', { details: { param: 'body' } });
    const edited: QueuedPrompt = { ...current, body: patch.body, ...(patch.attachments ? { attachments: patch.attachments } : {}), updatedAt: this.now() };
    return this.save({ ...queue, items: queue.items.map((entry) => (entry.id === id ? edited : entry)) });
  }

  remove(conversationId: string, id: string): PromptQueue {
    const queue = this.get(conversationId);
    this.item(queue, id);
    return this.save({ ...queue, items: queue.items.filter((entry) => entry.id !== id) });
  }

  move(conversationId: string, id: string, index: number): PromptQueue {
    const queue = this.get(conversationId);
    this.item(queue, id);
    return this.save({ ...queue, items: moveItem(queue.items, id, index) });
  }

  sendNow(conversationId: string, id: string): { queue: PromptQueue; message: Message } {
    const queue = this.get(conversationId);
    const message = this.send(conversationId, this.item(queue, id));
    const after = this.get(conversationId); // the send may have changed it (delivery events)
    return { queue: this.save({ ...after, items: after.items.filter((entry) => entry.id !== id), sentAt: this.now() }), message };
  }

  pause(conversationId: string, reason: QueuePause, note?: string): PromptQueue {
    const queue = this.get(conversationId);
    if (!queue.items.length) return queue;
    if (queue.paused?.reason === reason && queue.paused.note === note) return queue;
    return this.save({ ...queue, paused: { reason, at: this.now(), ...(note ? { note } : {}) } });
  }

  resume(conversationId: string): PromptQueue {
    const queue = this.get(conversationId);
    if (!queue.paused) { this.schedule(conversationId, 0); return queue; }
    const { paused: _, ...rest } = queue;
    const saved = this.save(rest);
    this.schedule(conversationId, 0);
    return saved;
  }

  // ------------------------------------------------------------------ when the top prompt goes out

  /** Listens to the run ends of chats with a queue, the emergency stop and removed chats; checks the stored queues once after the start. */
  watch(): () => void {
    const { bus } = this.s;
    this.offs.push(
      bus.on('run.upserted', (run) => this.runEnded(run)),
      bus.on('work.state', (state) => { if (state.stopped) for (const { key } of this.kv().list<PromptQueue>(NS)) this.pause(key, 'stop'); }),
      bus.on('conversation.removed', ({ id }) => { if (this.kv().delete(NS, id)) this.clearTimer(id); }),
    );
    for (const { key, value } of this.kv().list<PromptQueue>(NS)) if (value?.items?.length && !value.paused) this.schedule(key, this.deps.startMs ?? START_MS);
    return () => this.stop();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  private runEnded(run: Run): void {
    if (run.endedAt === undefined || !run.conversationId || run.splitId || run.status === 'running' || run.status === 'queued') return;
    const queue = this.kv().get<PromptQueue>(NS, run.conversationId);
    if (!queue?.items.length || queue.paused) return;
    const next = afterRun({ status: run.status, error: run.error, asked: run.status === 'done' && this.asked(run) });
    if (next === 'next') this.schedule(run.conversationId, this.deps.settleMs ?? SETTLE_MS);
    else this.pause(run.conversationId, next.pause, next.note);
  }

  /** The run asked the person something: human.ask, an ask block or mini-app to-do, a new to-do of theirs here, a closing question. */
  private asked(run: Run): boolean {
    const s = this.s;
    try {
      if (s.runs.items(run.id).some((item) => item.kind === 'tool_call' && item.name === 'human.ask')) return true;
    } catch { /* journal is best effort */ }
    const answer = s.chats.messages(run.conversationId!, { limit: RECENT_ROWS }).filter((message) => message.runId === run.id && message.authorKind === 'agent').pop();
    if (answer && (hasAskBlock(answer.body) || endsWithQuestion(answer.body))) return true;
    const since = run.startedAt ?? run.endedAt ?? 0;
    return s.tasks.list({ conversationId: run.conversationId, assigneeKind: 'human', status: ['open', 'working', 'waiting', 'needs_you', 'blocked'], limit: 20 })
      .some((task) => task.createdAt >= since);
  }

  /** Something works in the chat: a run of it, a streaming row, a chat wake waiting (or a task wake due now). */
  private busy(conversationId: string): boolean {
    const s = this.s;
    if (s.dispatcher.activity().some((item) => item.conversationId === conversationId)) return true;
    if (s.chats.messages(conversationId, { limit: RECENT_ROWS }).some((message) => message.state === 'streaming')) return true;
    const now = this.now();
    const agents = s.chats.members(conversationId).filter((member) => member.kind === 'agent' && member.leftAt === undefined);
    return agents.some((member) => s.wakes.list(member.memberId).some((wake) => wake.conversationId === conversationId && wake.claimedAt === undefined && (!wake.taskId || wake.dueAt <= now)));
  }

  private schedule(conversationId: string, ms: number): void {
    const at = this.now() + ms;
    const current = this.timers.get(conversationId);
    if (current && current.at <= at) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => { this.timers.delete(conversationId); this.kick(conversationId); }, ms);
    timer.unref?.();
    this.timers.set(conversationId, { at, timer });
  }

  private clearTimer(conversationId: string): void {
    const current = this.timers.get(conversationId);
    if (current) clearTimeout(current.timer);
    this.timers.delete(conversationId);
  }

  /** Sends the top prompt when the queue may and the chat is free. */
  kick(conversationId: string): void {
    try {
      const queue = this.get(conversationId);
      if (!queue.items.length || queue.paused) return;
      const grace = this.deps.graceMs ?? SENT_GRACE_MS;
      const since = queue.sentAt === undefined ? Infinity : this.now() - queue.sentAt;
      if (since < grace) { this.schedule(conversationId, grace - since); return; }
      if (!this.s.chats.get(conversationId)) { this.kv().delete(NS, conversationId); return; }
      if (this.busy(conversationId)) return; // the run's end checks again
      const [top] = queue.items;
      try {
        this.send(conversationId, top);
      } catch (error) {
        this.pause(conversationId, 'error', `The queued message could not be sent: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        return;
      }
      const after = this.get(conversationId);
      this.save({ ...after, items: after.items.filter((entry) => entry.id !== top.id), sentAt: this.now() });
      this.schedule(conversationId, grace); // nobody may answer: then the next one after the grace
    } catch (error) {
      this.s.log.warn('prompt queue check failed', { conversationId, error: String(error) });
    }
  }

  /** The person's message from a queued prompt – messages.send's path (the chat service wakes who answers). */
  private send(conversationId: string, item: QueuedPrompt): Message {
    const { chats } = this.s;
    const chat = chats.get(conversationId);
    if (!chat) throw new WorkforceError('not_found', 'This chat is gone.', { details: { conversationId } });
    const message = chats.send({
      conversationId, body: item.body, attachments: item.attachments, mentions: item.mentions,
      ...(item.priority ? { priority: item.priority } : {}), ...(item.silent ? { silent: true } : {}),
      replyTo: item.replyTo, clientId: `queue:${item.id}`, authorId: HUMAN_ID, authorKind: 'human',
      meta: { ...(item.secrets?.length ? { secrets: item.secrets } : {}), ...(item.ultra ? { ultra: true as const } : {}) },
    });
    if (chat.settings.hiddenFromList && !chat.settings.system) chats.update(conversationId, { settings: { hiddenFromList: undefined } }, HUMAN_ID);
    return message;
  }
}
