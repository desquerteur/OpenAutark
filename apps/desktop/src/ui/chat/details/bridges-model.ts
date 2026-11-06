// Pure helpers for the chat details "Telegram" rows (Bridges.tsx): status labels, keeping the
// list in step with bridge.upserted events, and quick input checks before connecting.
// Owns: those rules. Never: calls RPC, touches the DOM or holds a bot token after a submit.

import type { Bridge } from '../../../shared/model/bridges.ts';

/** Same shapes the runtime checks (rpc/handlers/bridges.ts); the runtime stays authoritative. */
const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,128}$/;
const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{4,32})$/;

export function statusText(bridge: Bridge): string {
  switch (bridge.status) {
    case 'connecting': return 'Connecting…';
    case 'connected': return 'Connected';
    case 'stopped': return 'Stopped';
    default: return bridge.error ?? 'Error';
  }
}

/** Applies an event to this chat's list: upsert, or drop when the bridge stopped. */
export function applyBridge(list: Bridge[], bridge: Bridge, conversationId: string): Bridge[] {
  if (bridge.conversationId !== conversationId) return list;
  const rest = list.filter((entry) => entry.id !== bridge.id);
  if (bridge.status === 'stopped') return rest.length === list.length ? list : rest;
  const index = list.findIndex((entry) => entry.id === bridge.id);
  if (index === -1) return [...list, bridge];
  const next = list.slice();
  next[index] = bridge;
  return next;
}

/** First problem with the form input, or undefined when it can be sent. */
export function connectProblem(botToken: string, chatId: string): string | undefined {
  if (!BOT_TOKEN.test(botToken.trim())) return 'Paste the full bot token from @BotFather.';
  if (!TELEGRAM_CHAT.test(chatId.trim())) return 'Enter a numeric chat id or an @channel name.';
  return undefined;
}
