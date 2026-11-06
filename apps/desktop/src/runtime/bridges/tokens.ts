// Bot tokens of chat bridges: reading one from the secret vault, checking it with getMe and
// storing a new one as the catalog entry "Telegram bot @name" (saved from api.telegram.org).
// Owns: those three steps and their user-safe errors. Never: logs, returns to clients or
// persists a token outside the vault; error texts never contain the token.

import { SYSTEM_ID } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { RuntimeServices } from '../contracts.ts';
import { TELEGRAM_HOST, TelegramError, scrub } from './telegram-api.ts';
import type { TelegramApi, TgUser } from './telegram-api.ts';

/** Decrypts a stored token for the runtime itself (never an agent); the vault checks the domain. */
export function tokenFrom(s: RuntimeServices, secretId: string): Promise<string> {
  return s.secrets.use(secretId, SYSTEM_ID, TELEGRAM_HOST);
}

/** getMe: the token is valid and belongs to a bot. */
export async function verifyToken(s: RuntimeServices, api: TelegramApi, token: string, signal: AbortSignal): Promise<TgUser> {
  let bot: TgUser;
  try {
    bot = await api.getMe(token, signal);
  } catch (error) {
    const failure = error instanceof TelegramError ? error : undefined;
    s.log.warn('telegram token check failed', { kind: failure?.kind ?? 'internal', detail: failure?.detail ?? scrub(String(error), token) });
    if (failure?.kind === 'unauthorized') throw new WorkforceError('bad_request', 'Telegram rejected the bot token.', { details: { param: 'botToken' } });
    throw new WorkforceError('unavailable', failure?.message ?? 'Telegram could not be reached.');
  }
  if (!bot?.is_bot) throw new WorkforceError('bad_request', 'This token does not belong to a Telegram bot.', { details: { param: 'botToken' } });
  return bot;
}

/** Saves the token (a new token for a known bot replaces the old value); returns the vault id. */
export async function storeToken(s: RuntimeServices, token: string, bot: TgUser): Promise<string> {
  const label = `Telegram bot ${bot.username ? `@${bot.username}` : bot.id}`;
  const existing = s.secrets.list().find((info) => info.label === label && info.kind === 'token');
  const saved = existing
    ? await s.secrets.save({ id: existing.id, label, kind: 'token', value: token })
    : await s.secrets.save({ label, kind: 'token', value: token, source: TELEGRAM_HOST });
  return saved.id;
}
