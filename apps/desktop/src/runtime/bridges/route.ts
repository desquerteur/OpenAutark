// Inbound routing of chat bridges: one Telegram message → the running bridges that mirror its chat, and as whom it
// lands there. A supergroup move updates the bridges; '/link …' goes to the owner link once for all of them
// (owner-link.ts, never posted); the owner's account – the linked one, or in a private chat with the bot that chat's
// own user – posts as the person; everyone else becomes an external contact (inbound.ts). Edits are ignored.
// Owns: that decision per update. Never: logs message text or the bot token, posts an edit, or lets one failing
// bridge stop the others.

import type { Bridge } from '../../shared/model/bridges.ts';
import type { RuntimeServices } from '../contracts.ts';
import { ingest, isOwnerSender, matchesChat } from './inbound.ts';
import { privateChatOwner, type OwnerLinks } from './owner-link.ts';
import { scrub } from './telegram-api.ts';
import type { TgMessage, TgUpdate } from './telegram-api.ts';

export interface RouteTarget {
  id: string;
  bridge: Pick<Bridge, 'conversationId' | 'externalChatId'>;
  ownerUserId?: string;
}

export interface RouteHost {
  services(): RuntimeServices;
  owners: OwnerLinks;
  /** The running bridge, read fresh for every message (a move changes its chat id). */
  target(id: string): RouteTarget | undefined;
  migrate(id: string, externalChatId: string): void;
}

type RouteStream = { botId: string; token: string; bridges: Set<string> };

/** One update of a stream: a new message or channel post (edits are ignored). */
export function routeUpdate(host: RouteHost, stream: RouteStream, update: TgUpdate): void {
  const message = update.message ?? update.channel_post;
  if (message) routeMessage(host, stream, message);
}

export function routeMessage(host: RouteHost, stream: RouteStream, message: TgMessage): void {
  const targets = targetsOf(host, stream, message);
  if (!targets.length) return;
  const moved = message.migrate_to_chat_id;
  if (moved === undefined) {
    try {
      if (host.owners.command(targets.map((target) => target.id), message)) return;
    } catch (error) {
      fail(host, stream, targets[0].id, error);
      return;
    }
  }
  for (const target of targets) {
    const bridge = { id: target.id, conversationId: target.bridge.conversationId };
    try {
      if (moved !== undefined) host.migrate(target.id, String(moved));
      else if (isOwnerSender(message, target.ownerUserId ?? privateChatOwner(target.bridge.externalChatId))) host.owners.post(bridge, message);
      else ingest(host.services(), bridge, message);
    } catch (error) {
      fail(host, stream, target.id, error);
    }
  }
}

function targetsOf(host: RouteHost, stream: RouteStream, message: TgMessage): RouteTarget[] {
  const targets: RouteTarget[] = [];
  for (const id of stream.bridges) {
    const target = host.target(id);
    if (target && matchesChat(target.bridge.externalChatId, message.chat)) targets.push(target);
  }
  return targets;
}

function fail(host: RouteHost, stream: RouteStream, id: string, error: unknown): void {
  host.services().log.warn('telegram message could not be added to the chat', { bridgeId: id, error: scrub(String(error), stream.token) });
}
