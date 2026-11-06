// Chat retries after connection loss, unavailable AI, usage limits and transient engine errors.
// A failed attempt leaves a durable entry; repeated failures wait 1, 2, 4 … 30 minutes.
// One timer waits for the next retry and the earliest usable account; account/model/online events
// can bring recovery forward. Entries survive restarts and long absences until the chat moves on.
// Task turns use ownership.ts instead. Owns: those entries, events, timer and quiet retry line.
// Never: retries unknown tool effects or setup/cancelled errors, polls, or runs the agent itself.

import type { RuntimeServices } from '../contracts.ts';
import type { WorkforceErrorData } from '../../shared/errors.ts';
import { KvRepo } from '../store/kv.ts';
import { effectsKnown } from '../context/recent-actions.ts';
import { OutageTracker, COOLING_END_MARGIN_MS, ONLINE_SETTLE_MS } from './outages.ts';
import { turnAccounts, turnAccountUsable } from '../accounts/failure.ts';
import { blockedUntil, isHealthy } from '../accounts/candidates.ts';
import { DueTimer, REAL_DUE_TIMERS } from '../people/due-timer.ts';
import type { Timers } from '../people/join.ts';

export const REDELIVERY_LINE = 'Retrying interrupted work';
export const REDELIVERY_NOTE = 'Retrying the interrupted turn: I continue from what is already done and include any new messages.';
const NS = 'redelivery';
/** The split service's existing wait horizon; pending chat retries do not expire. */
export const REDELIVERY_MAX_AGE_MS = 86_400_000;

/** `input`: the newest message the failed turn had to answer (not a status line, not its own). */
interface Entry { agentId: string; conversationId: string; cursor: number; input?: number; runId: string; at: number; used?: boolean; attempts?: number; nextAt?: number }

type Services = Pick<RuntimeServices, 'db' | 'clock' | 'log' | 'runs' | 'secrets' | 'org' | 'chats' | 'wakes'>;

/** An explicit cancellation of this chat's work also forgets an older pending retry. */
export function clearChatRetry(s: Pick<RuntimeServices, 'db'>, agentId: string, conversationId: string): void {
  new KvRepo(s.db).delete(NS, `${agentId}:${conversationId}`);
}

/** Seq of the newest message after `cursor` that is not a status line and not the agent's own (its failed bubble). */
function newestInput(services: Services, agentId: string, conversationId: string, cursor: number): number {
  const messages = services.chats.messages(conversationId, { limit: 50 });
  return messages.filter((message) => message.seq > cursor && message.kind !== 'status' && message.authorId !== agentId).at(-1)?.seq ?? cursor;
}

/** Outages, limits and transient errors; setup errors and explicit cancellation wait for a change. */
export function redeliverable(error: Pick<WorkforceErrorData, 'code' | 'details'> | undefined): boolean {
  return Boolean(error && ['unavailable', 'rate_limited', 'timeout', 'internal'].includes(error.code) && error.details?.setup !== true);
}

/**
 * A chat turn ended with `error`: remembers its next retry; true when it did. `cursor` is the
 * agent's chat cursor the turn started from (unchanged by the failure).
 */
export function noteChatOutage(services: Services, input: { agentId: string; conversationId: string; runId: string; cursor: number; error?: WorkforceErrorData; toolCalls: number }): boolean {
  try {
    const kv = new KvRepo(services.db);
    const key = `${input.agentId}:${input.conversationId}`;
    const prior = kv.get<Entry>(NS, key);
    if (prior?.runId === input.runId) return true;
    if (!redeliverable(input.error) || (input.toolCalls > 0 && !effectsKnown(services, input.runId, input.toolCalls))) {
      if (prior) kv.delete(NS, key); // a newer attempt supersedes the older pending failure
      return false;
    }
    const newest = newestInput(services, input.agentId, input.conversationId, input.cursor);
    const now = services.clock.now();
    const attempts = prior?.cursor === input.cursor && newest <= (prior.input ?? Number.MAX_SAFE_INTEGER) ? (prior.attempts ?? 1) + 1 : 1;
    const delay = Math.max(Math.min(60_000 * 2 ** Math.min(attempts - 1, 5), 30 * 60_000), input.error?.retryAfterMs ?? 0);
    kv.set(NS, key, { agentId: input.agentId, conversationId: input.conversationId, cursor: input.cursor, input: newest, runId: input.runId, at: now, attempts, nextAt: now + delay } satisfies Entry, now);
    return true;
  } catch (error) {
    services.log.warn('chat outage not noted', { runId: input.runId, error: String(error) });
    return false;
  }
}

type WatchServices = Services & Pick<RuntimeServices, 'bus' | 'accounts' | 'catalog' | 'host'>;

export class ChatRedelivery {
  private readonly services: () => WatchServices;
  private readonly timer: DueTimer;
  private off?: () => void;

  constructor(deps: { services: () => WatchServices; timers?: Timers }) {
    this.services = deps.services;
    this.timer = new DueTimer(deps.timers ?? REAL_DUE_TIMERS, () => this.services().clock.now(), () => {
      try { this.deliver(false); } catch (error) { this.services().log.warn('chat retry failed', { error: String(error) }); }
    });
  }

  /**
   * Listens for recovery events and failed turns. A run's end is emitted just before its retry entry
   * is written, so scheduling happens after that synchronous finish. Idempotent; returns the unsubscribe.
   */
  watch(): () => void {
    if (this.off) return this.off;
    const s = this.services();
    const tracker = new OutageTracker(safeList(() => s.accounts.list()), safeList(() => s.catalog.list()), s.clock.now());
    const paused = new Set(s.org.list().filter(agent => agent.status === 'paused').map(agent => agent.id));
    const offs = [
      s.bus.on('account.upserted', (account) => { if (tracker.account(account, this.services().clock.now())) this.deliver(); }),
      s.bus.on('account.removed', ({ id }) => tracker.removed(id)),
      s.bus.on('models.updated', (list) => { if (tracker.models(list)) this.deliver(); }),
      s.bus.on('run.upserted', (run) => {
        if (run.status === 'failed' && !run.taskId && !run.splitId && run.conversationId) queueMicrotask(() => { if (this.off) this.schedule(); });
      }),
      s.bus.on('agent.upserted', (agent) => {
        const wasPaused = paused.delete(agent.id);
        if (agent.status === 'paused') paused.add(agent.id);
        else if (wasPaused) this.schedule();
      }),
    ];
    try { offs.push(s.host.onPower((event) => { if (event === 'online') this.online(); })); } catch { /* a host without power events */ }
    this.off = () => { for (const off of offs.splice(0)) off(); this.timer.stop(); this.off = undefined; };
    this.online(); // B-044 integration: an 'online' while the runtime was down is lost – the start stands in for it
    return this.off;
  }

  /** A new connection (or runtime start) settles briefly before the next pending retry. */
  online(): void {
    const s = this.services();
    const now = s.clock.now();
    const at = now + ONLINE_SETTLE_MS;
    try {
      const kv = new KvRepo(s.db);
      for (const { key, value: entry } of kv.list<Entry | undefined>(NS)) {
        if (entry && !entry.used && (entry.nextAt ?? at) > at) kv.set(NS, key, { ...entry, nextAt: at } satisfies Entry, now);
      }
      this.schedule(at);
    } catch (error) { s.log.warn('chat retry after reconnect not scheduled', { error: String(error) }); }
  }

  /** Re-delivers every pending chat turn that still waits; returns how many (none while no account can run a turn). */
  deliver(recovered = true): number {
    const s = this.services();
    const kv = new KvRepo(s.db);
    const now = s.clock.now();
    if (!turnAccountUsable(safeList(() => s.accounts.list()), now)) { this.schedule(); return 0; }
    let delivered = 0;
    for (const { key, value: entry } of kv.list<Entry | undefined>(NS)) {
      try {
        if (!entry || !this.waiting(s, entry)) { kv.delete(NS, key); continue; }
        if (entry.used) continue;
        if (s.org.get(entry.agentId)?.status === 'paused') continue;
        if (!recovered && (entry.nextAt ?? 0) > now) continue;
        if (s.wakes.list(entry.agentId).some((wake) => wake.conversationId === entry.conversationId)) { kv.delete(NS, key); continue; } // a turn there comes anyway
        s.db.tx(() => {
          kv.set(NS, key, { ...entry, used: true } satisfies Entry, now);
          s.chats.status(entry.conversationId, { type: 'note', text: REDELIVERY_LINE, details: { redelivery: true, runId: entry.runId } }, { authorId: entry.agentId });
          s.wakes.wake({ agentId: entry.agentId, reason: 'retry', conversationId: entry.conversationId, note: REDELIVERY_NOTE, coalesceKey: `redeliver:${entry.conversationId}` });
        });
        delivered++;
      } catch (error) {
        s.log.warn('chat re-delivery failed', { key, error: String(error) });
        if (entry) kv.set(NS, key, { ...entry, nextAt: now + 60_000 } satisfies Entry, now);
      }
    }
    this.schedule();
    return delivered;
  }

  /** One due moment, recomputed only after a failure, a recovery event or that moment itself. */
  private schedule(floor = this.services().clock.now()): void {
    const s = this.services();
    try {
      const now = s.clock.now();
      const accounts = turnAccounts(safeList(() => s.accounts.list()));
      const available = accounts.flatMap((account) => {
        if (isHealthy(account, now)) return [now];
        const until = blockedUntil(account, now);
        return until !== undefined && isHealthy(account, until + COOLING_END_MARGIN_MS) ? [until + COOLING_END_MARGIN_MS] : [];
      });
      const entries = new KvRepo(s.db).list<Entry | undefined>(NS).flatMap(({ value }) => value && !value.used && this.waiting(s, value) && s.org.get(value.agentId)?.status !== 'paused' ? [value] : []);
      const at = available.length && entries.length
        ? Math.max(floor, Math.min(...available), Math.min(...entries.map((entry) => entry.nextAt ?? now))) : undefined;
      this.timer.arm(at);
    } catch (error) { s.log.warn('chat retry scheduling failed', { error: String(error) }); }
  }

  /** The agent can still run there and its cursor has not passed the failed input. */
  private waiting(s: Services, entry: Entry): boolean {
    const agent = s.org.get(entry.agentId);
    if (!agent || agent.archivedAt !== undefined) return false;
    const member = s.chats.members(entry.conversationId).find((item) => item.memberId === entry.agentId && !item.leftAt);
    return member !== undefined && (member.readSeq ?? 0) <= entry.cursor;
  }
}

function safeList<T>(read: () => T[]): T[] {
  try { return read(); } catch { return []; }
}
