// AF-001: a limit on agents restarting themselves. The ownership loop continues a task 1 s after a turn that did something
// (tasks/ownership.ts), a lead re-picks owners, chat retries and re-checks come back, model.set now restarts a turn at once
// (dispatcher continueNow) – work that nobody new asked for. A turn that keeps "doing something" without ending would
// so wake its agent forever. The dispatcher counts these automatic restarts per agent: at most RESTART_LIMIT within
// RESTART_WINDOW_MS; the start that reaches the limit still runs, then the agent's automatic restarts wait RESTART_COOLDOWN_MS
// (their wakes go back to the queue with that due time, so the scheduler's one timer brings them back – no polling). A
// message, an answer, task news, an event or a schedule is no automatic restart: it still wakes the agent at once.
// When the limit takes effect, one warning goes to the log and one quiet line into the chat the restart was for (else the
// agent's 1:1 with the person), so the person sees why the agent pauses. In memory: a runtime start begins afresh.
// Owns: which wake groups count as automatic, the per-agent count, the cooldown, the log entry and the chat line.
// Never: drops a wake, delays a person's message, or pauses an agent (its status stays as it is).

import type { RuntimeServices } from '../contracts.ts';
import type { WakeReason } from '../../shared/model/runs.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { findDirect } from '../chat/direct.ts';
import { wakeIds, type WakeGroup } from './dispatch-groups.ts';

export const RESTART_LIMIT = 30;
export const RESTART_WINDOW_MS = 10 * 60_000;
export const RESTART_COOLDOWN_MS = 10 * 60_000;

/** Wakes only the agent's own earlier work queues: the ownership loop's retries and re-checks, a lead's pick, a chat retry. */
export const AUTOMATIC_REASONS: ReadonlySet<WakeReason> = new Set<WakeReason>(['retry', 'review']);

export interface RestartLimit {
  limit: number;
  windowMs: number;
  cooldownMs: number;
}

export const DEFAULT_RESTART_LIMIT: RestartLimit = { limit: RESTART_LIMIT, windowMs: RESTART_WINDOW_MS, cooldownMs: RESTART_COOLDOWN_MS };

/** A group every wake of which is an automatic restart (an empty group is none). */
export function automaticGroup(group: Pick<WakeGroup, 'wakes'>): boolean {
  return group.wakes.length > 0 && group.wakes.every((wake) => AUTOMATIC_REASONS.has(wake.reason));
}

export class RestartGuard {
  readonly limits: RestartLimit;
  private readonly starts = new Map<string, number[]>(); // agent → its automatic restarts in the current window
  private readonly cooling = new Map<string, number>(); // agent → until when its automatic restarts wait

  constructor(limits: Partial<RestartLimit> = {}) {
    const pick = (value: number | undefined, fallback: number, min: number) => (value !== undefined && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback);
    this.limits = {
      limit: pick(limits.limit, RESTART_LIMIT, 1),
      windowMs: pick(limits.windowMs, RESTART_WINDOW_MS, 1),
      cooldownMs: pick(limits.cooldownMs, RESTART_COOLDOWN_MS, 1),
    };
  }

  /** Until when the agent's automatic restarts wait; undefined when they may run now. */
  holdUntil(agentId: string, now: number): number | undefined {
    const until = this.cooling.get(agentId);
    if (until === undefined) return undefined;
    if (until > now) return until;
    this.cooling.delete(agentId);
    return undefined;
  }

  /** One automatic restart starts now; returns the end of the cooldown when it used up the window's budget. */
  record(agentId: string, now: number): number | undefined {
    const recent = (this.starts.get(agentId) ?? []).filter((at) => now - at < this.limits.windowMs);
    recent.push(now);
    if (recent.length < this.limits.limit) {
      this.starts.set(agentId, recent);
      return undefined;
    }
    this.starts.delete(agentId);
    const until = now + this.limits.cooldownMs;
    this.cooling.set(agentId, until);
    return until;
  }

  /** Automatic restarts the agent has made in the current window (diagnostics, tests). */
  count(agentId: string, now: number): number {
    return (this.starts.get(agentId) ?? []).filter((at) => now - at < this.limits.windowMs).length;
  }
}

/**
 * The dispatcher's gate before it picks a group: while the agent cools down, its automatic groups go back to the queue,
 * due when the cooldown ends (not counted as a run attempt); the rest – a message, an answer … – still competes.
 */
export function holdRestarts(services: RuntimeServices, guard: RestartGuard, agentId: string, groups: WakeGroup[]): WakeGroup[] {
  const until = guard.holdUntil(agentId, services.clock.now());
  if (until === undefined) return groups;
  const automatic = groups.filter(automaticGroup);
  if (!automatic.length) return groups;
  services.wakes.release(wakeIds(automatic), until, true);
  return groups.filter((group) => !automatic.includes(group));
}

/** Counts an automatic restart that starts now (a group the dispatcher runs, or a model.set now); at the limit: log and chat line. */
export function countRestart(services: RuntimeServices, guard: RestartGuard, agentId: string, conversationId: string | undefined): void {
  const now = services.clock.now();
  const until = guard.record(agentId, now);
  if (until === undefined) return;
  const { limit, windowMs, cooldownMs } = guard.limits;
  services.log.warn('agent restart limit reached', { agentId, restarts: limit, windowMs, cooldownMs, until });
  try {
    const name = services.org.get(agentId)?.name ?? 'The agent';
    const chat = conversationId ?? findDirect(services, agentId, HUMAN_ID);
    if (!chat) return;
    const text = `${name} restarted its own work ${limit} times within ${minutes(windowMs)}, so its automatic restarts pause for ${minutes(cooldownMs)}. A message still reaches it at once.`;
    services.chats.status(chat, { type: 'note', text, details: { restartLimit: { restarts: limit, windowMs, cooldownMs, until } } }, { authorId: agentId });
  } catch (error) {
    services.log.warn('restart limit line not written', { agentId, error: String(error) });
  }
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return value === 1 ? '1 minute' : `${value} minutes`;
}
