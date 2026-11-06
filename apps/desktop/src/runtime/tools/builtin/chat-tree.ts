// B-078 sub-chats and threads for agents (runtime/chat/children.ts holds the rules):
//  - chat.set_parent: puts a chat I am in under another chat I am in (one level), or back on top (without parentId) –
//    the way I keep a work group's special chats under its main chat.
//  - chat.thread: the thread on one message (found or opened with that chat's members) – a small side space for one
//    piece of work, so the main chat stays readable. Answers its chat id; I write there with chat.send {chatId}.
// Owns: these tools and their wording. Never: changes members (runtime/chat/members-change.ts).

import type { ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { openThread, setParent } from '../../chat/children.ts';
import { defineTool, internal, resolveChat, viewTitle } from './util.ts';

const refused = (error: unknown) => (error instanceof WorkforceError ? failure(`Nothing was changed. ${error.message}`) : failure(String(error)));

const setParentTool = defineTool<{ chatId?: string; parentId?: string }>({
  name: 'chat.set_parent',
  description: 'I put a chat I am in under another chat I am in (parentId), so the special chats of one topic or work group sit under its main chat in the list; without parentId it goes back on top. One level: a sub-chat holds no sub-chats.',
  inputSchema: {
    type: 'object',
    properties: { chatId: { type: 'string' }, parentId: { type: 'string', minLength: 1, maxLength: 64 } },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(args.parentId ? `Put chat under ${args.parentId}` : 'Put chat on top', args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const chatId = resolveChat(ctx, args.chatId);
    try {
      const chat = setParent(ctx.services, chatId, args.parentId?.trim() || null, ctx.agent.id);
      return json({ ok: true, chatId: chat.id, parentId: chat.settings.parentId ?? null });
    } catch (error) {
      return refused(error);
    }
  },
});

const threadTool = defineTool<{ chatId?: string; seq?: number; messageId?: string; title?: string }>({
  name: 'chat.thread',
  description: 'The thread on one message (#seq in a chat I am in, or its messageId): found, or opened now with the members of that chat. I use it for one piece of work that needs a few lines of its own, so the main chat stays readable; I write there with chat.send {chatId}.',
  inputSchema: {
    type: 'object',
    properties: {
      chatId: { type: 'string' }, seq: { type: 'integer', minimum: 1 }, messageId: { type: 'string', minLength: 1, maxLength: 64 }, title: { type: 'string', maxLength: 120 },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(`Thread on ${args.messageId ?? `#${args.seq ?? '?'}`}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    let messageId = args.messageId;
    if (!messageId && args.seq !== undefined) {
      const chatId = resolveChat(ctx, args.chatId);
      messageId = ctx.services.chats.messages(chatId, { afterSeq: args.seq - 1, limit: 1 }).find((message) => message.seq === args.seq)?.id;
      if (!messageId) return failure(`No message #${args.seq} in this chat.`);
    }
    if (!messageId) return failure('Name the message: its #seq (with chatId when it is another chat) or its messageId.');
    try {
      const thread = openThread(ctx.services, messageId, ctx.agent.id, args.title);
      return json({ ok: true, chatId: thread.id, title: viewTitle(ctx, thread, ctx.services.chats.members(thread.id)), parentId: thread.settings.parentId });
    } catch (error) {
      return refused(error);
    }
  },
});

export const chatTreeTools: ToolDef[] = [setParentTool, threadTool];
