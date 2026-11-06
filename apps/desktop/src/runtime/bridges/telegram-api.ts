// Telegram Bot API client for chat bridges: getMe, getUpdates (long poll) and sendMessage over
// HTTPS to api.telegram.org, with error classification (bad token, conflict, rate limit with
// retry_after, chat refused, network).
// Owns: request/response shapes and the user-safe error sentences.
// Never: contacts any host other than api.telegram.org (redirects are refused), logs, stores or
// returns the bot token (it only appears in the request URL), or hands raw provider bodies to
// users (descriptions stay in a scrubbed `detail` for logs only).

export const TELEGRAM_HOST = 'api.telegram.org';
const BASE = `https://${TELEGRAM_HOST}`;
/** Longest text Telegram accepts in one message. */
export const MESSAGE_LIMIT = 4096;

export interface TgUser { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string }
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  sender_chat?: TgChat;
  text?: string;
  caption?: string;
  migrate_to_chat_id?: number;
  [key: string]: unknown; // photo, voice, document … (only their presence is used)
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  /** C9: edits are read only for '/link …' (bridges/route.ts routeEdit) – never posted. */
  edited_message?: TgMessage;
  edited_channel_post?: TgMessage;
}

export type TelegramFailure = 'unauthorized' | 'conflict' | 'rate_limited' | 'chat' | 'bad_request' | 'server' | 'network';

const SENTENCES: Record<TelegramFailure, string> = {
  unauthorized: 'Telegram rejected the bot token.',
  conflict: 'Another app reads the updates of this bot.',
  rate_limited: 'Telegram asked to slow down.',
  chat: 'Telegram refused messages for this chat.',
  bad_request: 'Telegram refused the request.',
  server: 'Telegram had a problem.',
  network: 'Telegram is not reachable.',
};

/** A failed Bot API call. `message` is a fixed, user-safe sentence. */
export class TelegramError extends Error {
  readonly kind: TelegramFailure;
  readonly retryAfterMs?: number;
  /** Scrubbed provider description or transport error, for logs only. */
  readonly detail?: string;
  /** Telegram moved a group to a supergroup with this new chat id. */
  readonly migrateTo?: string;

  constructor(kind: TelegramFailure, options: { retryAfterMs?: number; detail?: string; migrateTo?: string } = {}) {
    super(SENTENCES[kind]);
    this.name = 'TelegramError';
    this.kind = kind;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.migrateTo !== undefined) this.migrateTo = options.migrateTo;
  }
}

/** The numeric bot id in front of the token ("<bot id>:<secret>"); identifies the update stream. */
export function botIdOf(token: string): string {
  return token.split(':')[0] ?? '';
}

/** Removes the token (and anything shaped like one) from text bound for logs. */
export function scrub(text: string, token?: string): string {
  const plain = token ? text.split(token).join('•••') : text;
  return plain.replace(/\d{3,20}:[A-Za-z0-9_-]{20,}/g, '•••');
}

interface ApiBody<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramApi {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  getMe(token: string, signal?: AbortSignal): Promise<TgUser> {
    return this.call<TgUser>(token, 'getMe', {}, { signal, timeoutMs: 15_000 });
  }

  /** Long poll: Telegram holds the request up to `timeout` seconds until updates arrive. */
  getUpdates(token: string, params: { offset?: number; timeout: number }, signal?: AbortSignal): Promise<TgUpdate[]> {
    const body = { offset: params.offset, timeout: params.timeout, allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post'] };
    return this.call<TgUpdate[]>(token, 'getUpdates', body, { signal, timeoutMs: (params.timeout + 15) * 1000 });
  }

  /** Plain text (no parse_mode), link previews off. */
  sendMessage(token: string, chatId: string, text: string, signal?: AbortSignal): Promise<TgMessage> {
    const body = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
    return this.call<TgMessage>(token, 'sendMessage', body, { signal, timeoutMs: 30_000 });
  }

  async call<T>(token: string, method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<T> {
    const caller = options.signal;
    const signal = caller ? AbortSignal.any([caller, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
    let response: Response;
    let body: ApiBody<T>;
    try {
      response = await this.fetchImpl(`${BASE}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), redirect: 'error', signal,
      });
    } catch (error) {
      if (caller?.aborted) throw aborted(caller);
      throw new TelegramError('network', { detail: scrub(describe(error), token) });
    }
    try {
      body = await response.json() as ApiBody<T>;
    } catch (error) {
      if (caller?.aborted) throw aborted(caller);
      throw new TelegramError(response.status >= 500 ? 'server' : 'bad_request', { detail: scrub(`HTTP ${response.status}: ${describe(error)}`, token) });
    }
    if (response.ok && body.ok) return body.result as T;
    throw failure(response.status, body, token);
  }
}

function failure(status: number, body: ApiBody<unknown>, token: string): TelegramError {
  const code = Number(body.error_code ?? status);
  const detail = scrub(String(body.description ?? `HTTP ${status}`), token).slice(0, 200);
  const migrate = body.parameters?.migrate_to_chat_id;
  const migrateTo = migrate === undefined ? undefined : String(migrate);
  if (code === 401 || code === 404) return new TelegramError('unauthorized', { detail });
  if (code === 409) return new TelegramError('conflict', { detail });
  if (code === 429) {
    const seconds = Number(body.parameters?.retry_after);
    return new TelegramError('rate_limited', { detail, retryAfterMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000 });
  }
  if (code === 403 || migrateTo || (code === 400 && /chat not found|chat_id|rights|kicked|blocked|deactivated/i.test(detail))) {
    return new TelegramError('chat', { detail, migrateTo });
  }
  if (code >= 500) return new TelegramError('server', { detail });
  return new TelegramError('bad_request', { detail });
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  return `${error.name}: ${error.message}${cause ? ` (${String(cause)})` : ''}`;
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}
