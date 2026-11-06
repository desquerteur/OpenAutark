// RPC handlers: chat bridges (mirror a chat to Telegram, list, disconnect; C9: link/unlink the
// owner's own Telegram account).
// Owns: param checks; all methods are owner only. A bot token in the params is checked for its
// shape only and handed straight to the bridges service (which stores it in the vault).
// Never: bridge logic (Bridges via extras.bridges), echoes or logs a bot token (errors name the
// parameter, never its value).

import { WorkforceError } from '../../../shared/errors.ts';
import type { ConnectTelegramInput } from '../../../shared/model/bridges.ts';
import type { OwnerLinkApi } from '../../contracts/bridges.ts';
import { bad, id, input, onlyKeys, optId, optText, text } from '../params.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

/** Telegram bot token shape: "<bot id>:<secret>". */
const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,128}$/;
/** Telegram chat id (user/group/supergroup, may be negative) or a public "@channel" name. */
const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{4,32})$/;

export function register(table: HandlerTable): void {
  table.add('bridges.list', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId']);
    return ctx.extras.bridges.list(optId(o, 'conversationId'));
  });

  table.add('bridges.connectTelegram', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'botToken', 'secretId', 'externalChatId']);
    const botToken = optText(o, 'botToken', { max: 200 })?.trim();
    if (botToken !== undefined && !BOT_TOKEN.test(botToken)) bad('botToken', 'a Telegram bot token');
    const secretId = optId(o, 'secretId');
    if ((botToken === undefined) === (secretId === undefined)) bad('botToken', 'either a bot token or a secretId');
    const externalChatId = text(o, 'externalChatId', { max: 64 }).trim();
    if (!TELEGRAM_CHAT.test(externalChatId)) bad('externalChatId', 'a Telegram chat id or @channel name');
    const request: ConnectTelegramInput = { conversationId: id(o, 'conversationId'), externalChatId };
    if (botToken !== undefined) request.botToken = botToken;
    if (secretId !== undefined) request.secretId = secretId;
    return ctx.extras.bridges.connectTelegram(request);
  });

  table.add('bridges.disconnect', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    ctx.extras.bridges.disconnect(id(o));
    return { ok: true };
  });

  // C9: "Link my Telegram" – a one-time code for /link in the bridged chat – and unlinking it.
  table.add('bridges.linkOwner', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return ownerLink(ctx).linkOwner(id(o));
  });

  table.add('bridges.unlinkOwner', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return ownerLink(ctx).unlinkOwner(id(o));
  });
}

/** Bridges implement OwnerLinkApi (C9); RpcExtras.bridges is still typed as BridgesApi only. */
function ownerLink(ctx: HandlerContext): OwnerLinkApi {
  const api = ctx.extras.bridges as unknown as Partial<OwnerLinkApi>;
  if (typeof api.linkOwner !== 'function' || typeof api.unlinkOwner !== 'function') {
    throw new WorkforceError('unavailable', 'Linking a Telegram account is not available.');
  }
  return api as OwnerLinkApi;
}
