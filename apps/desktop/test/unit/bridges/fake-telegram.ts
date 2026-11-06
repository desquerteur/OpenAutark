// Test fixtures for chat bridges: a fake Telegram Bot API (one `fetch` that routes getMe,
// getUpdates and sendMessage like api.telegram.org, with long polls that block until updates
// arrive or the request is aborted – so a busy loop cannot hide) and a bridge setup on the chat
// harness (real ChatService on SQLite) with an in-memory secret vault and a memory logger.
// Owns: fixtures only. Never: imported by production code, touches the network.

import { Bridges } from '../../../src/runtime/bridges/service.ts';
import type { TgMessage, TgUpdate } from '../../../src/runtime/bridges/telegram-api.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import type { SecretService, SettingsService } from '../../../src/runtime/contracts.ts';
import type { SecretInfo } from '../../../src/shared/model/security.ts';
import { agent, harness } from '../chat/harness.ts';

export const TOKEN = '123456789:AAHcorrectHorseBatteryStaple_test-token';
export const OTHER_TOKEN = '987654321:AAHanotherBotTokenThatIsLongEnough_x';
export const BOT = { id: 123456789, is_bot: true, first_name: 'Workforce', username: 'wf_test_bot' };
export const GROUP_ID = -100777;

type SendRule = (text: string, chatId: string) => { status: number; body: Record<string, unknown> } | undefined;

export interface Call { method: string; token: string; body: Record<string, unknown> }

/** A fake api.telegram.org. Push updates with `push`; inspect requests in `calls`. */
export class FakeTelegram {
  readonly calls: Call[] = [];
  readonly sent: Array<{ chatId: string; text: string }> = [];
  validTokens = new Set([TOKEN]);
  /** Updates the bot has received (including a backlog before the bridge was linked). */
  private updates: TgUpdate[] = [];
  private nextId = 500;
  private waiters: Array<() => void> = [];
  /** Rules for sendMessage answers, consumed in order (undefined = success). */
  sendRules: SendRule[] = [];

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const match = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (!match) throw new Error(`unexpected host or path: ${url}`);
    const [, token, method] = match;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    this.calls.push({ method, token, body });
    if (!this.validTokens.has(token)) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    if (method === 'getMe') return reply(200, { ok: true, result: BOT });
    if (method === 'getUpdates') return reply(200, { ok: true, result: await this.getUpdates(body, init?.signal ?? undefined) });
    if (method === 'sendMessage') {
      const text = String(body.text);
      const chatId = String(body.chat_id);
      const rule = this.sendRules.shift()?.(text, chatId);
      if (rule) return reply(rule.status, rule.body);
      this.sent.push({ chatId, text });
      return reply(200, { ok: true, result: { message_id: this.nextId++, date: 0, chat: { id: Number(chatId), type: 'group' }, text } });
    }
    return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
  }) as typeof fetch;

  /** Delivers a message to the bot (wakes a waiting long poll). */
  push(message: Partial<TgMessage> & { text?: string }, chatId = GROUP_ID): TgUpdate {
    return this.deliver('message', message, chatId);
  }

  /** Delivers an edit of an earlier message (Telegram's edited_message; pass its message_id). */
  edit(message: Partial<TgMessage> & { text?: string }, chatId = GROUP_ID): TgUpdate {
    return this.deliver('edited_message', { edit_date: 1, ...message }, chatId);
  }

  private deliver(kind: 'message' | 'edited_message', message: Partial<TgMessage>, chatId: number): TgUpdate {
    const update: TgUpdate = {
      update_id: this.nextId++,
      [kind]: { message_id: this.nextId++, date: 0, chat: { id: chatId, type: 'supergroup', title: 'Team' }, from: { id: 42, is_bot: false, first_name: 'Ana', last_name: 'Lee' }, ...message } as TgMessage,
    };
    this.updates.push(update);
    for (const wake of this.waiters.splice(0)) wake();
    return update;
  }

  /** How many getUpdates requests were made. */
  polls(): number {
    return this.calls.filter((call) => call.method === 'getUpdates').length;
  }

  private async getUpdates(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<TgUpdate[]> {
    const offset = typeof body.offset === 'number' ? body.offset : undefined;
    if (offset === -1) return this.updates.slice(-1); // backlog skip: Telegram returns the newest one
    const fresh = () => this.updates.filter((update) => offset === undefined || update.update_id >= offset);
    while (!fresh().length) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
        this.waiters.push(resolve);
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    return fresh();
  }
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An in-memory vault with the domain/agent rules the bridge relies on. */
export function fakeVault() {
  const rows = new Map<string, { info: SecretInfo; value: string }>();
  let seq = 0;
  const vault = {
    list: () => [...rows.values()].map((row) => row.info),
    async save(input: Parameters<SecretService['save']>[0]): Promise<SecretInfo> {
      const id = input.id ?? `sec_${++seq}`;
      const old = rows.get(id);
      const info: SecretInfo = { id, label: input.label, kind: input.kind, createdAt: 0, ...(input.source ?? old?.info.source ? { source: input.source ?? old?.info.source } : {}) };
      rows.set(id, { info, value: input.value ?? old?.value ?? '' });
      return info;
    },
    async use(id: string, _agentId: string, domain?: string): Promise<string> {
      const row = rows.get(id);
      if (!row) throw new Error('unknown secret');
      return row.value;
    },
    remove: (id: string) => { rows.delete(id); },
    redact: (text: string) => text,
    values: () => [...rows.values()].map((row) => row.value),
  };
  return vault;
}

/** Bridge setup: chat harness + fake Telegram + vault + memory log, one agent and one chat. */
export function bridgeSetup(options: { ownerName?: string } = {}) {
  const h = harness();
  const telegram = new FakeTelegram();
  const vault = fakeVault();
  const log = new MemoryLogger();
  const sleeps: number[] = [];
  h.services.secrets = vault as unknown as SecretService;
  h.services.log = log;
  h.services.settings = { get: () => ({ profile: { name: options.ownerName ?? 'Sam' } }) } as unknown as SettingsService;
  h.org.add(agent('ag_ada', 'Ada'));
  const chat = h.chats.create({ title: 'Team', agentIds: ['ag_ada'], createdBy: 'human' });
  const make = () => new Bridges({
    services: () => h.services,
    fetch: telegram.fetch,
    sleep: async (ms) => { sleeps.push(ms); }, // backoff and retry_after resolve at once
  });
  const bridges = make();
  return { h, telegram, vault, log, sleeps, chat, bridges, make };
}

/** Lets pending promises and setImmediate callbacks run until `check` holds (bounded). */
export async function until(check: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

// ------------------------------------------------------------------ added by C9 (owner link)

/** The owner's own Telegram account in the owner-link tests (a person, not a bot). */
export const OWNER_TG = { id: 4242, is_bot: false, first_name: 'Sam', last_name: 'Owner' };

/** Pushes the messages and waits until the bot handled the batch and every reply was sent. */
export async function delivered(telegram: FakeTelegram, bridges: Bridges, ...messages: Array<Partial<TgMessage> & { chatId?: number }>): Promise<void> {
  const polls = telegram.polls();
  for (const { chatId, ...message } of messages) telegram.push(message, chatId);
  await until(() => telegram.polls() > polls);
  await bridges.settled();
}

/** bridgeSetup with `make()` for another instance (a restart). */
export function ownerSetup(options: { ownerName?: string } = {}) {
  const setup = bridgeSetup(options);
  const make = () => new Bridges({
    services: () => setup.h.services,
    fetch: setup.telegram.fetch,
    sleep: async (ms) => { setup.sleeps.push(ms); },
  });
  return { ...setup, bridges: make(), make };
}
