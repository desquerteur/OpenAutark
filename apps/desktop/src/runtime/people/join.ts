// Joining the organisation (F-52): a person's phone or browser opens the invite link / scans its QR
// code (#join=<ticket>) or types the invite's 6-digit code on this PC's address, and asks
// (`people.join`, tokenless) – the invite is used up at once. The owner decides on a host-written
// to-do ("Let <device> join as <person>?", Allow / Deny) – the shared host decision to-do of Remote
// (remote/todo.ts DecisionTodos: only the person on this PC answers it, agents can neither answer
// nor change it). The page holds one `people.awaitJoin` long request (≤ 55 s) and receives the
// person's device token once accepted. Limits: 10 open requests, 5 per address in 10 minutes (at
// most 256 addresses tracked; the oldest goes), 24 hours to decide; codes: 10 wrong tries in 2
// minutes from anywhere pause entering codes for the rest of those minutes – the codes stay valid
// and the invite link keeps working, so a stranger can delay codes but never end anyone's invite
// (at most 50 guesses in a code's 10 minutes against a million codes). Requests and codes live in
// memory only (as sha256); the token is issued when the page collects it. B-078 (D15): a person admitted this way is
// welcomed once – the owner's personal manager gets one wake to set up a personal manager for them (org/member-welcome.ts).
// Owns: the code map, the request lifecycle, the per-address limit and the waiters.
// Never: decides on anything but the owner's answer, or keeps tickets, codes or tokens in plain form.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AccessTicket, AccessWait } from '../../shared/api/methods.ts';
import type { ClientScope } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { plainLabel } from '../../shared/text/device-label.ts';
import type { Bus } from '../bus.ts';
import type { Logger } from '../contracts.ts';
import { hashToken } from '../pwa/tokens.ts';
import { DecisionTodos, type DecisionText, type TodoServices } from '../remote/todo.ts';
import { canWelcome, welcomeMember } from '../org/member-welcome.ts';

export const JOIN_TTL_MS = 24 * 60 * 60_000;
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_OPEN = 10;
export const PER_ADDRESS = 5;
export const ADDRESS_WINDOW_MS = 10 * 60_000;
export const AWAIT_MAX_MS = 55_000;
/** Wrong codes (from anywhere) in CODE_WINDOW_MS before entering codes pauses for the rest of that window. */
export const MAX_WRONG_CODES = 10;
export const CODE_WINDOW_MS = 2 * 60_000;
export const MAX_TRACKED_ADDRESSES = 256;
export const JOIN_OPTIONS = { allow: 'Allow', deny: 'Deny' } as const;

export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const REAL_TIMERS: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clear: (handle) => { if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

type Status = 'pending' | 'accepted' | 'denied' | 'expired';
interface Request {
  id: string; hash: string; personId: string; name: string; remote: string; expiresAt: number;
  status: Status; reason?: string; waiter?: () => void; timer?: unknown;
}
interface Code { hash: string; personId: string; expiresAt: number }

export interface JoinDeps {
  now(): number;
  bus: Pick<Bus, 'on'>;
  log: Logger;
  services(): TodoServices | undefined;
  /** The person's display text for the to-do ("Anna Berg · Designer"); undefined = not invitable any more. */
  describe(personId: string): string | undefined;
  /** Issues the device token of an accepted request (only when the page collects it). */
  issue(personId: string, name: string): { token: string; deviceId: string };
  /** Audit and state hooks (people/service.ts). */
  changed(personId: string, action: 'join_requested' | 'join_declined', details: Record<string, unknown>): void;
  timers?: Timers;
}

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Only the owner on this PC (or an in-process caller) admits a person's device. */
export function mayAdmit(scope: ClientScope | undefined): boolean {
  return !scope || scope.kind === 'owner';
}

export class JoinRequests {
  private readonly deps: JoinDeps;
  private readonly timers: Timers;
  private readonly open = new Map<string, Request>();
  private readonly codes = new Map<string, Code>();
  private readonly hits = new Map<string, { start: number; count: number }>();
  private wrong = { start: 0, count: 0 };
  private readonly todos: DecisionTodos;

  constructor(deps: JoinDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.todos = new DecisionTodos({
      bus: deps.bus, log: deps.log, services: deps.services,
      answered: (id, choice, scope) => {
        const request = [...this.open.values()].find((entry) => entry.id === id);
        if (!request) return true;
        if (choice === JOIN_OPTIONS.allow && !mayAdmit(scope)) {
          deps.log.info('person join: allow refused for this caller', { id });
          return false; // the to-do comes back; allow it on the PC
        }
        this.decide(request, choice === JOIN_OPTIONS.allow);
        return true;
      },
    });
  }

  /** A short code for a person's invite (replaces that person's open code); 10 minutes. */
  newCode(personId: string): { code: string; expiresAt: number } {
    this.sweep();
    for (const [key, entry] of this.codes) if (entry.personId === personId) this.codes.delete(key);
    let code = '';
    for (let i = 0; i < 20 && (!code || this.codes.has(hashToken(`code:${code}`))); i++) code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.deps.now() + CODE_TTL_MS;
    const hash = hashToken(`code:${code}`);
    this.codes.set(hash, { hash, personId, expiresAt });
    return { code, expiresAt };
  }

  /** Ends a person's open code (invite closed, person revoked). */
  dropCode(personId: string): void {
    for (const [key, entry] of this.codes) if (entry.personId === personId) this.codes.delete(key);
  }

  /**
   * A typed code → its person (one use). Wrong codes count globally: after MAX_WRONG_CODES in a
   * window, codes are refused until it ends (rate_limited) – open codes are never ended by others.
   */
  redeemCode(value: unknown): string | undefined {
    this.sweep();
    const now = this.deps.now();
    if (now - this.wrong.start >= CODE_WINDOW_MS) this.wrong = { start: now, count: 0 };
    if (this.wrong.count >= MAX_WRONG_CODES) {
      throw new WorkforceError('rate_limited', 'Too many wrong codes were entered. Try again in a few minutes, or open the invite link.', { retryAfterMs: Math.max(1000, this.wrong.start + CODE_WINDOW_MS - now) });
    }
    const digits = typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
    const hash = /^\d{6}$/.test(digits) ? hashToken(`code:${digits}`) : '';
    for (const [key, entry] of this.codes) {
      if (hash && same(key, hash)) { this.codes.delete(key); return entry.personId; }
    }
    this.wrong.count++;
    return undefined;
  }

  /**
   * `people.join`: checks the limits, then `redeem` (the invite ticket or code → its person); opens
   * the request and the owner's to-do; returns the page's ticket (once).
   */
  create(input: { name?: string; remote?: string; redeem: () => string | undefined }): AccessTicket {
    this.sweep();
    const now = this.deps.now();
    const remote = input.remote || 'unknown';
    const wait = this.take(remote, now);
    if (wait > 0) throw new WorkforceError('rate_limited', 'This device asked too often. Try again in a few minutes.', { retryAfterMs: wait });
    if (this.pending() >= MAX_OPEN) throw new WorkforceError('rate_limited', 'Too many people are waiting to join right now. Try again later.', { retryAfterMs: 60_000 });
    const personId = input.redeem();
    const who = personId ? this.deps.describe(personId) : undefined;
    if (!personId || !who) throw new WorkforceError('forbidden', 'This invite is no longer valid. Ask for a new one.');
    const ticket = randomBytes(32).toString('base64url');
    const name = plainLabel(input.name) || 'Browser';
    const request: Request = { id: newId('tok', now), hash: hashToken(ticket), personId, name, remote, expiresAt: now + JOIN_TTL_MS, status: 'pending' };
    this.open.set(request.hash, request);
    request.timer = this.timers.set(() => this.expire(request), JOIN_TTL_MS);
    this.todos.open(request.id, this.todoText(request, who));
    this.deps.changed(personId, 'join_requested', { device: name });
    return { id: request.id, ticket, code: '', expiresAt: request.expiresAt, proven: true };
  }

  /** `people.awaitJoin`: the outcome as soon as there is one, else 'pending' after ≤ 55 s or when the page goes. */
  async wait(ticket: unknown, signal: AbortSignal, maxMs = AWAIT_MAX_MS): Promise<AccessWait> {
    this.sweep();
    const request = typeof ticket === 'string' && ticket.length <= 200 ? this.open.get(hashToken(ticket)) : undefined;
    if (!request) return { status: 'expired' };
    if (request.status === 'pending' && !signal.aborted) {
      await new Promise<void>((resolve) => {
        request.waiter?.();
        let timer: unknown;
        const finish = () => {
          if (request.waiter === finish) request.waiter = undefined;
          this.timers.clear(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        request.waiter = finish;
        timer = this.timers.set(finish, Math.max(0, Math.min(maxMs, request.expiresAt - this.deps.now())));
        signal.addEventListener('abort', finish, { once: true });
      });
      this.sweep();
    }
    if (request.status === 'pending' || signal.aborted) return { status: 'pending', expiresAt: request.expiresAt };
    return this.settle(request);
  }

  /** A person was revoked (or invites closed): their open requests end and no token is issued. */
  closeFor(personId: string, reason = 'This invite was withdrawn.'): void {
    this.dropCode(personId);
    for (const request of [...this.open.values()]) {
      if (request.personId !== personId) continue;
      if (request.status === 'pending' || request.status === 'accepted') Object.assign(request, { status: 'denied', reason });
      this.todos.close(request.id, 'Withdrawn');
      request.waiter?.();
    }
  }

  pending(): number {
    return [...this.open.values()].filter((request) => request.status === 'pending').length;
  }

  /** The open decision to-do of a request (tests). */
  todoOf(requestId: string): string | undefined { return this.todos.todoOf(requestId); }

  private todoText(request: Request, who: string): DecisionText {
    const address = request.remote && request.remote !== 'unknown' && !/^(127\.|::1$)/.test(request.remote) ? `- Address: ${request.remote}` : '';
    return {
      title: `Let ${request.name} join as ${who}?`,
      notes: [`- Person: ${who}`, `- Device: ${request.name}`, '- Used the invite for this person', address, '- Open for 24 hours'].filter(Boolean).join('\n'),
      question: `Allow ${request.name} to join your organisation as ${who}? It sees only the chats and tasks of this person.`,
      options: [{ label: JOIN_OPTIONS.allow, hint: 'Chats and tasks of this person' }, { label: JOIN_OPTIONS.deny }],
      fallback: 'Open Autark on this PC to decide.',
      ring: 'todo',
      binding: `person_${request.id}`,
    };
  }

  private decide(request: Request, allow: boolean): void {
    if (request.status !== 'pending') return;
    request.status = allow ? 'accepted' : 'denied';
    if (!allow) {
      request.reason = 'The organisation did not let this device join.';
      this.deps.changed(request.personId, 'join_declined', { device: request.name });
    }
    request.waiter?.();
  }

  private settle(request: Request): AccessWait {
    this.drop(request);
    if (request.status === 'accepted') {
      try {
        const label = this.deps.describe(request.personId);
        if (!label) throw new WorkforceError('forbidden', 'This person no longer has access.');
        const issued = this.deps.issue(request.personId, request.name);
        this.welcome(request.personId, label);
        return { status: 'accepted', token: issued.token, deviceId: issued.deviceId, access: 'full' };
      } catch (error) {
        this.deps.log.warn('person token not issued', { id: request.id, error: errorText(error) });
        return { status: 'denied', reason: error instanceof WorkforceError ? error.message : 'The PC could not finish joining.' };
      }
    }
    return request.status === 'denied' ? { status: 'denied', reason: request.reason } : { status: 'expired', reason: request.reason };
  }

  /** B-078: one wake for the owner's personal manager the first time this person is admitted; never fails the join. */
  private welcome(personId: string, label: string): void {
    try {
      const s = this.deps.services();
      if (canWelcome(s)) welcomeMember(s, { id: personId, label });
    } catch (error) {
      this.deps.log.warn('person welcome not sent', { personId, error: errorText(error) });
    }
  }

  private expire(request: Request): void {
    if (request.status === 'pending' || request.status === 'accepted') request.status = 'expired';
    this.todos.close(request.id, 'Expired');
    request.waiter?.();
    this.drop(request);
  }

  private sweep(): void {
    const now = this.deps.now();
    for (const request of [...this.open.values()]) if (now >= request.expiresAt) this.expire(request);
    for (const [key, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(key);
  }

  private drop(request: Request): void {
    this.timers.clear(request.timer);
    this.open.delete(request.hash);
  }

  private take(remote: string, now: number): number {
    let entry = this.hits.get(remote);
    if (!entry || now - entry.start >= ADDRESS_WINDOW_MS) {
      this.hits.delete(remote);
      for (const [key, value] of this.hits) if (now - value.start >= ADDRESS_WINDOW_MS) this.hits.delete(key);
      // Strictly bounded: the oldest window goes first (Map keeps insertion order).
      while (this.hits.size >= MAX_TRACKED_ADDRESSES) this.hits.delete(this.hits.keys().next().value!);
      entry = { start: now, count: 0 };
      this.hits.set(remote, entry);
    }
    entry.count++;
    return entry.count <= PER_ADDRESS ? 0 : Math.max(1000, entry.start + ADDRESS_WINDOW_MS - now);
  }
}
