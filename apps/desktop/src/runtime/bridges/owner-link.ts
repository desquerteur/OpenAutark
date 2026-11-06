// The owner's own Telegram account on a bridge: its messages post as the person (inbound.ts ingestOwner), so the
// person runs the team from Telegram. Two ways to link it:
//  * a private chat with the bot is the owner's by itself – Telegram makes that chat's id the user's id, and the
//    person (or the AI for them) entered it when connecting: that user is the owner without any step;
//  * in a group, "Link my Telegram" (bridges.linkOwner) makes a one-time code (10 minutes, memory only); "/link
//    <code>" sent there by a person (not a bot, a channel or an anonymous admin) makes that user the owner and the
//    bot confirms once. A code is used up once it appears in the chat, whoever sent it.
// Owner messages are never echoed (outbound.ts skips meta.via 'bridge').
// Owns: the codes, linking/unlinking and the bot's reply text. Never: stores or logs a code, accepts a code in
// another Telegram chat than its bridge's, or runs a timer (expiry is checked on each message).

import { randomInt, timingSafeEqual } from 'node:crypto';
import { WorkforceError } from '../../shared/errors.ts';
import { OWNER_LINK_CODE_MS } from '../../shared/model/bridges.ts';
import type { Bridge, OwnerLinkCode } from '../../shared/model/bridges.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { RuntimeServices } from '../contracts.ts';
import { humanLabel } from '../context/render.ts';
import { bodyOf, ingestOwner, senderOf } from './inbound.ts';
import { publicBridge } from './repo.ts';
import type { BridgeRecord, BridgeRepo } from './repo.ts';
import type { TgMessage } from './telegram-api.ts';

export const LINK_CODE_LENGTH = 8;
/** No 0/O or 1/I/L: easy to read off a screen and to type on a phone. */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function linkedText(ownerName: string): string {
  return `Linked. Messages you write in this chat now post as ${ownerName} in the app.`;
}

/** '/link <code>' or '/link@bot <code>' → the code part ('' for a bare /link); undefined for other text. */
export function linkCommand(text: string | undefined): string | undefined {
  const match = /^\/link(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((text ?? '').trim());
  return match ? (match[1] ?? '').trim() : undefined;
}

/** "abcd-efgh", "ABCD EFGH" → "ABCDEFGH". */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

export function newLinkCode(): string {
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  return code;
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A private chat's id is its user's id (a positive number); groups are negative, channels '@name'. */
export function privateChatOwner(externalChatId: string): string | undefined {
  return /^\d+$/.test(externalChatId.trim()) ? externalChatId.trim() : undefined;
}

export interface OwnerLinkHost {
  services(): RuntimeServices;
  repo(): BridgeRepo;
  /** Announces a changed row (bridge.upserted) and refreshes the running bridge. */
  emit(record: BridgeRecord): void;
  /** Queues one plain-text message to the bridge's Telegram chat. */
  reply(bridgeId: string, text: string): void;
}

export class OwnerLinks {
  private readonly host: OwnerLinkHost;
  private readonly codes = new Map<string, { code: string; expiresAt: number }>(); // bridge id → pending code

  constructor(host: OwnerLinkHost) {
    this.host = host;
  }

  issue(bridgeId: string): OwnerLinkCode {
    const record = this.require(bridgeId);
    if (record.externalChatId.startsWith('@')) {
      throw new WorkforceError('bad_request', 'Channel posts have no sender to link. Link a private chat or a group with the bot instead.', { details: { param: 'id' } });
    }
    const code = newLinkCode();
    const expiresAt = this.now() + OWNER_LINK_CODE_MS;
    this.codes.set(bridgeId, { code, expiresAt });
    return { bridgeId, code, expiresAt };
  }

  unlink(bridgeId: string): Bridge {
    const record = this.require(bridgeId);
    this.forget(bridgeId);
    if (!record.ownerUserId) return publicBridge(record);
    const updated = this.host.repo().setOwner(bridgeId, undefined, this.now());
    if (!updated) return publicBridge(record);
    this.host.services().log.info('telegram owner account unlinked', { bridgeId });
    this.host.emit(updated);
    return publicBridge(updated);
  }

  forget(bridgeId: string): void {
    this.codes.delete(bridgeId);
  }

  clear(): void {
    this.codes.clear();
  }

  /** '/link …' in a chat that `bridgeIds` mirror: handled here and never posted (true = it was one). */
  command(bridgeIds: string[], message: TgMessage): boolean {
    const raw = linkCommand(message.text);
    if (raw === undefined) return false;
    const from = message.sender_chat || message.from?.is_bot ? undefined : message.from; // channels, anonymous admins, bots
    const code = normalizeCode(raw);
    const now = this.now();
    for (const id of bridgeIds) {
      const pending = this.codes.get(id);
      if (!pending) continue;
      if (pending.expiresAt <= now) { this.codes.delete(id); continue; }
      if (!code || !sameCode(code, pending.code)) continue;
      this.codes.delete(id); // single use, and seen in the chat: nobody can copy it from there
      if (from) this.link(id, message, String(from.id));
    }
    return true;
  }

  /** The owner wrote: posted as the person. */
  post(bridge: { id: string; conversationId: string }, message: TgMessage): Message | undefined {
    if (!bodyOf(message)) return undefined; // /start, empty service messages
    return ingestOwner(this.host.services(), bridge, message);
  }

  private link(bridgeId: string, message: TgMessage, userId: string): void {
    const s = this.host.services();
    const now = this.now();
    const name = senderOf(message)?.name ?? 'Telegram user';
    const record = this.host.repo().setOwner(bridgeId, { userId, name, linkedAt: now }, now);
    if (!record) return;
    s.log.info('telegram owner account linked', { bridgeId });
    this.host.emit(record);
    this.host.reply(bridgeId, linkedText(humanLabel(s)));
  }

  private require(bridgeId: string): BridgeRecord {
    const record = this.host.repo().get(bridgeId);
    if (!record) throw new WorkforceError('not_found', 'Bridge not found.', { details: { id: bridgeId } });
    return record;
  }

  private now(): number {
    return this.host.services().clock.now();
  }
}
