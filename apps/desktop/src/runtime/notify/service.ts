// NotificationService: the single path for "the human should know".
// Every notification goes on the bus ('notify' with a `toast` flag: whether the in-window toast
// should show). OS pushes (host.notify) and extra channels (web push, registered later via
// addChannel): to-dos, blockers and important messages always (B-078, D17 – Settings only has the sound switch; an
// old settings.json with them off cannot silence them); replies and finished work when Settings.notifications allow
// it: enabled, kind listed in pushFor, outside quiet hours (evaluated in the profile timezone). 'info' never pushes.
// With a sound by default (main plays one per burst: main/host-services.ts).
// Per chat (C3, notify/levels.ts): the conversation's notification level filters pushes and
// toasts ('off' lets only human to-dos and approvals through, 'mentions' also important messages
// and blockers, 'all' pushes replies and results past pushFor) and its `sound: false` makes the
// push silent. The chat settings come from a lookup wired in compose/services.ts.
// Owns: the push filter, the per-chat filter, light de-duplication, channel fan-out with error
// isolation. Never: decides *what* is important (callers pass the kind) or blocks on a channel.
// Employees' devices: pwa/person-push.ts.
// The owner's other PCs: a notification that pushes here gets an id and goes to the `relay` hook (every online CEO PC,
// devices/sync/notify.ts); a PC that gets one (`relayed`) hands it only to its channels – its phones – and never on again.

import { randomUUID } from 'node:crypto';
import type { Bus } from '../bus.ts';
import type { ConversationSettings } from '../../shared/model/chat.ts';
import type { Clock, Logger, NotificationChannel, NotificationInput, NotificationService, SettingsService } from '../contracts.ts';
import type { Host } from '../host.ts';
import { levelAllows, levelForcesPush, toastFor } from './levels.ts';

export interface NotifyDeps {
  bus: Bus;
  host: Pick<Host, 'notify'>;
  settings: Pick<SettingsService, 'get'>;
  clock: Clock;
  log: Logger;
  /** The chat a notification belongs to (its level and sound); late-bound in the composition root. */
  chat?: (conversationId: string) => { settings: ConversationSettings } | undefined;
  /** Hands a notification that pushes here to the owner's other PCs (their phones); wired in compose/services.ts. */
  relay?: (pushed: Pushed) => void;
}

/** A notification as it pushes: its id (the same on every PC and phone it reaches), sound and tag. */
export type Pushed = Parameters<NotificationChannel>[0];

/** The kinds that push ('info' never does). */
const PUSHED = new Set<string>(['todo', 'blocker', 'important', 'done', 'reply']);
/** B-078 (D17): these push whatever enabled, pushFor or quiet hours say (Settings shows no switch for them any more). */
const ALWAYS: ReadonlySet<string> = new Set(['todo', 'blocker', 'important']);

/** Same tag within this window is not pushed twice (bursts of status changes). */
const DEDUPE_MS = 3000;

/** Minutes since local midnight in `timeZone` for epoch `ms`. */
export function localMinutes(ms: number, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  }
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** Quiet hours may span midnight ("22:00"–"07:00"). from === to means no quiet time. */
export function inQuietHours(ms: number, timeZone: string, quiet?: { from: string; to: string }): boolean {
  if (!quiet) return false;
  const toMinutes = (value: string) => {
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
  };
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  const now = localMinutes(ms, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export class Notifications implements NotificationService {
  private readonly deps: NotifyDeps;
  private readonly channels = new Set<NotificationChannel>();
  private readonly recent = new Map<string, number>();

  constructor(deps: NotifyDeps) {
    this.deps = deps;
  }

  addChannel(channel: NotificationChannel): () => void {
    this.channels.add(channel);
    return () => { this.channels.delete(channel); };
  }

  notify(input: NotificationInput): void {
    const clean: NotificationInput = {
      ...input,
      title: input.title.slice(0, 120),
      body: input.body.slice(0, 400),
    };
    const chat = this.chatSettings(clean.conversationId);
    this.deps.bus.emit('notify', { ...clean, toast: toastFor(chat?.notifications, clean.kind) });
    if (!this.pushes(clean.kind, chat)) return;

    const settings = this.deps.settings.get().notifications;
    const tag = clean.taskId ?? clean.conversationId;
    const now = this.deps.clock.now();
    if (tag) {
      const last = this.recent.get(`${clean.kind}:${tag}`);
      if (last !== undefined && now - last < DEDUPE_MS) return;
      this.recent.set(`${clean.kind}:${tag}`, now);
      if (this.recent.size > 200) this.prune(now);
    }
    const pushed: Pushed = { ...clean, id: randomUUID(), silent: !settings.sound || chat?.sound === false, tag };
    this.deps.host.notify({ title: pushed.title, body: pushed.body, silent: pushed.silent, tag }).catch((error: unknown) => {
      this.deps.log.warn('notification failed', { error });
    });
    this.toChannels(pushed);
    this.deps.relay?.(pushed);
  }

  /** A notification another of the owner's PCs pushed (mesh 'notify.relay'): its filters decided, it reaches this PC's phones. */
  relayed(params: unknown): void {
    const p = (params ?? {}) as Partial<Record<keyof Pushed, unknown>>;
    if (!this.channels.size || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.body !== 'string' || !PUSHED.has(String(p.kind))) return;
    const text = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 200) : undefined);
    this.toChannels({
      id: p.id.slice(0, 100), kind: p.kind as Pushed['kind'], title: p.title.slice(0, 120), body: p.body.slice(0, 400),
      conversationId: text(p.conversationId), taskId: text(p.taskId), tag: text(p.tag), silent: p.silent === true,
    });
  }

  /** The channels (web push), each on its own. */
  private toChannels(pushed: Pushed): void {
    for (const channel of this.channels) {
      try {
        Promise.resolve(channel(pushed)).catch((error: unknown) => this.deps.log.warn('notification channel failed', { error }));
      } catch (error) {
        this.deps.log.warn('notification channel failed', { error });
      }
    }
  }

  /** Exposed for tests and the settings preview ("would this push now?"); with a chat, its level counts. */
  shouldPush(input: Pick<NotificationInput, 'kind' | 'conversationId'>): boolean {
    return this.pushes(input.kind, this.chatSettings(input.conversationId));
  }

  private pushes(kind: NotificationInput['kind'], chat: ConversationSettings | undefined): boolean {
    if (kind === 'info' || !levelAllows(chat?.notifications, kind)) return false;
    if (ALWAYS.has(kind)) return true; // B-078 (D17): what needs the person always arrives
    const settings = this.deps.settings.get();
    const notifications = settings.notifications;
    if (!notifications.enabled) return false;
    if (!notifications.pushFor.includes(kind) && !levelForcesPush(chat?.notifications, kind)) return false;
    return !inQuietHours(this.deps.clock.now(), settings.profile.timezone, notifications.quietHours);
  }

  /** The chat's settings; a missing chat or a failing lookup means the global settings alone decide. */
  private chatSettings(conversationId: string | undefined): ConversationSettings | undefined {
    if (!conversationId || !this.deps.chat) return undefined;
    try {
      return this.deps.chat(conversationId)?.settings;
    } catch (error) {
      this.deps.log.warn('chat settings lookup failed', { conversationId, error: String(error) });
      return undefined;
    }
  }

  private prune(now: number): void {
    for (const [key, at] of this.recent) if (now - at >= DEDUPE_MS) this.recent.delete(key);
  }
}
