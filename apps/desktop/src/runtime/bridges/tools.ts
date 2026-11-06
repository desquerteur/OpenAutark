// The agent's own way to connect Telegram (skill telegram-setup): telegram.connect mirrors a chat (default: the one
// the agent works in) to a Telegram chat with a bot. The token is a secret://<id> handle of the secrets catalog or
// the token itself (then saved to the catalog as "Telegram bot @name"). Without a Telegram chat id it takes the
// newest private chat that wrote to the bot – that person's account is the bridge's owner (owner-link.ts).
// Owns: the tool's arguments and texts. Never: returns or logs the token.

import { WorkforceError } from '../../shared/errors.ts';
import type { Bridge, ConnectTelegramInput } from '../../shared/model/bridges.ts';
import type { ToolDef } from '../tools/types.ts';
import { failure, json } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { TelegramApi, TgUpdate } from './telegram-api.ts';
import { tokenFrom } from './tokens.ts';

const HANDLE = /^secret:\/\/([A-Za-z0-9_-]{1,128})$/;

export interface TelegramToolHost {
  api: TelegramApi;
  connect(input: ConnectTelegramInput): Promise<Bridge>;
}

/** The newest private chat in the bot's waiting updates (someone wrote to the bot), or undefined. */
export function newestPrivateChat(updates: readonly TgUpdate[]): { id: string; name: string } | undefined {
  for (const update of [...updates].reverse()) {
    const chat = update.message?.chat;
    if (chat?.type === 'private') return { id: String(chat.id), name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Telegram user' };
  }
  return undefined;
}

export function telegramTools(host: TelegramToolHost): ToolDef[] {
  return [defineTool<{ botToken: string; externalChatId?: string; conversationId?: string }>({
    name: 'telegram.connect',
    description: 'Mirror a chat to Telegram through a bot (skill telegram-setup). botToken: secret://<id> or the token from @BotFather. externalChatId: the Telegram chat id; without it, the newest private chat that wrote to the bot (that person becomes the owner). conversationId: default this chat.',
    inputSchema: {
      type: 'object',
      properties: {
        botToken: { type: 'string', minLength: 10, maxLength: 200 },
        externalChatId: { type: 'string', minLength: 1, maxLength: 64 },
        conversationId: { type: 'string', minLength: 1, maxLength: 120 },
      },
      required: ['botToken'], additionalProperties: false,
    },
    category: 'communicate',
    describe: () => ({ summary: 'Connect a chat to Telegram', external: true }),
    async run(args, ctx) {
      const conversationId = args.conversationId ?? ctx.conversationId ?? ctx.split?.parentConversationId;
      if (!conversationId) return failure('Name the chat to mirror (conversationId).');
      const handle = HANDLE.exec(args.botToken.trim())?.[1];
      let externalChatId = args.externalChatId?.trim();
      let owner: string | undefined;
      if (!externalChatId) {
        let updates: TgUpdate[];
        try {
          const token = handle ? await tokenFrom(ctx.services, handle) : args.botToken.trim();
          updates = await host.api.getUpdates(token, { timeout: 0 }, ctx.signal);
        } catch (error) {
          return failure(`The bot's messages could not be read (${error instanceof WorkforceError ? error.message : 'Telegram did not answer'}). Give externalChatId.`);
        }
        const chat = newestPrivateChat(updates);
        if (!chat) return failure('Nobody wrote to the bot yet: ask the person to open the bot in Telegram and send it "hi", then call this again.');
        externalChatId = chat.id;
        owner = chat.name;
      }
      const bridge = await host.connect({ conversationId, externalChatId, ...(handle ? { secretId: handle } : { botToken: args.botToken.trim() }) });
      return json({ ...bridge, ...(owner ? { note: `Connected to the private chat of ${owner}; their messages count as the person's.` } : {}) });
    },
  })];
}
