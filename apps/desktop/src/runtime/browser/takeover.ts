// The person's takeover of an agent's own browser: one flag per agent. While it is on (Take over, the person's input
// in the live view, Show window) every browser step of the agent answers PERSON_USING. Hand back – or the browser
// closing while the agent waited – ends it, and the agent is woken in the chat and task of its last browser call
// (wired in view.ts). Owner 29.10.2026 ("immer, wenn möglich, auch das Passwort noch zwischenspeichern"): password field
// values the person sent a form with meanwhile are kept in memory and go to the vault when the takeover ends
// (keepPasswords) – a value already in the vault is skipped.
// Owns: the flags, the last use per agent and those passwords. Never: logs or returns a value, or wakes by itself.

import { WorkforceError } from '../../shared/errors.ts';
import type { BrowserTakeover } from '../../shared/model/browser.ts';
import type { RuntimeServices } from '../contracts.ts';
import { registrableDomain } from '../secrets/service.ts';

export const PERSON_USING = 'The person has taken over my browser. I do other work meanwhile; I am woken when they hand it back.';
const MAX_KEPT = 5;

/** The chat and task of the agent's last browser call (a wake goes there). */
export interface UseContext { conversationId?: string; taskId?: string }
export interface SeenPassword { host: string; value: string }
/** `wake`: a hand back that wakes the agent, or a close while the agent was refused. */
export interface TakeoverEnded { agentId: string; reason: 'hand_back' | 'closed'; wake: boolean; context?: UseContext; passwords: SeenPassword[] }

export class Takeovers {
  private readonly taken = new Map<string, BrowserTakeover>();
  private readonly uses = new Map<string, UseContext>();
  private readonly seen = new Map<string, SeenPassword[]>();
  private readonly listeners = new Set<(event: TakeoverEnded) => void>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  state(agentId: string): BrowserTakeover | undefined {
    const on = this.taken.get(agentId);
    return on ? { ...on } : undefined;
  }

  active(agentId: string): boolean {
    return this.taken.has(agentId);
  }

  /** True when this started it (it was off). */
  start(agentId: string): boolean {
    if (this.taken.has(agentId)) return false;
    this.taken.set(agentId, { since: this.now(), waiting: false });
    return true;
  }

  /** The agent's browser call: remembers where it came from; refused while the person has the browser. */
  guard(agentId: string, use?: UseContext): void {
    if (use && (use.conversationId || use.taskId)) this.uses.set(agentId, use);
    const on = this.taken.get(agentId);
    if (!on) return;
    on.waiting = true;
    throw new WorkforceError('conflict', PERSON_USING, { details: { takeover: true } });
  }

  /** Password field values the person sends a form with during the takeover (see the header). */
  keep(agentId: string, host: string, values: readonly string[]): void {
    if (!this.taken.has(agentId) || !host || !values.length) return;
    const kept = (this.seen.get(agentId) ?? []).filter((entry) => !values.includes(entry.value));
    this.seen.set(agentId, [...kept, ...values.map((value) => ({ host, value }))].slice(-MAX_KEPT));
  }

  /** Hand back (`wake` false: a to-do's answer wakes the agent already); false when it was not on. */
  end(agentId: string, wake = true): boolean {
    const on = this.taken.get(agentId);
    if (!on) return false;
    this.taken.delete(agentId);
    this.emit({ agentId, reason: 'hand_back', wake, context: this.uses.get(agentId), passwords: this.take(agentId) });
    return true;
  }

  /** The browser closed: a waiting agent is woken; at shutdown nothing happens. */
  forget(agentId: string, reason: 'closed' | 'shutdown'): void {
    const on = this.taken.get(agentId);
    this.taken.delete(agentId);
    const passwords = this.take(agentId);
    const context = this.uses.get(agentId);
    this.uses.delete(agentId);
    if (on && reason === 'closed') this.emit({ agentId, reason, wake: on.waiting, context, passwords });
  }

  onEnd(listener: (event: TakeoverEnded) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private take(agentId: string): SeenPassword[] {
    const seen = this.seen.get(agentId) ?? [];
    this.seen.delete(agentId);
    return seen;
  }

  private emit(event: TakeoverEnded): void {
    for (const listener of [...this.listeners]) { try { listener(event); } catch { /* a listener's failure ends nothing */ } }
  }
}

/** Stores the kept passwords as the agent's secrets "<domain> password" (skipping values the vault holds); returns how many. */
export async function keepPasswords(services: Pick<RuntimeServices, 'secrets' | 'log'>, agentId: string, seen: readonly SeenPassword[]): Promise<number> {
  let kept = 0;
  for (const { host, value } of seen) {
    const domain = registrableDomain(host);
    if (!domain || /^secret:\/\/[\w-]+$/.test(services.secrets.redact(value))) continue;
    if (services.secrets.holding && (await services.secrets.holding(value, agentId)).length) continue;
    await services.secrets.save({
      label: `${domain} password`, kind: 'password', value, source: domain, createdBy: agentId,
      description: `Password the person entered on ${domain} while they had your browser.`,
    });
    kept++;
  }
  if (kept) services.log.info('passwords from a browser takeover kept in the vault', { agentId, count: kept }); // never a value
  return kept;
}

/** Wakes the agent after a hand back (or a close it waited on) in the chat and task of its last browser call. */
export function wakeAfterTakeover(services: Pick<RuntimeServices, 'wakes' | 'log'>, event: TakeoverEnded, kept: number): void {
  const { conversationId, taskId } = event.context ?? {};
  if (!event.wake || (!conversationId && !taskId)) return;
  const note = event.reason === 'hand_back'
    ? 'The person handed my browser back. I take a new browser.snapshot before I go on.'
    : 'My browser closed while the person had it. I open the page again with browser.open, then go on.';
  try {
    services.wakes.wake({
      agentId: event.agentId, reason: taskId ? 'task' : 'message', conversationId, taskId, coalesceKey: `browser-takeover:${event.agentId}`,
      note: kept ? `${note} The password they signed in with is now in the vault (secrets.list).` : note,
    });
  } catch (error) {
    services.log.debug('browser takeover wake failed', { agentId: event.agentId, error: String(error).split('\n')[0] });
  }
}
