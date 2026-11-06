// The agent's own messages and its settings of a chat (B-050 K10), all through ChatService with the agent as `by`:
//  - chat.edit / chat.delete: only the agent's own finished messages (by seq, as chat.read shows them, or by id);
//    the service refuses anyone else's (chat/message-edits.ts, chat/lifecycle.ts removeMessage). Of its status lines
//    only its work updates (chat.send status) go: the others (members, name, lead, tasks, calendar …) record what
//    happened in the chat and stand in for an approval of these calls, so they stay.
//  - chat.archive: takes a chat out of the person's list (C2: its agents keep working there; an important message or
//    an @mention of the person brings it back) – a room of agents only, or one the agent started where the person is
//    the only one besides agents; never a default 1:1 (K1: the one chat of its pair, the person's to hide) or a chat
//    with colleagues or outside members (they could not write there any more). One quiet line names the agent.
//  - chat.reply_mode: how the agent answers messages in a group that @mention nobody (chat/reply-modes.ts), with one
//    quiet line naming the agent and the mode, so a change is seen.
// Owns: these tool definitions and the delete and archive rules. Never: changes another member's message or mode, or
// an app-owned chat (To-do, Customize).

import type { ToolContext, ToolDef } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { REPLY_MODES, type Message, type ReplyMode } from '../../../shared/model/chat.ts';
import { replyModeOf, setReplyMode } from '../../chat/reply-modes.ts';
import { defineTool, internal, resolveChat } from './util.ts';

const APP_CHAT = 'This chat belongs to the app: it stays as it is.';
const WHICH = { chatId: { type: 'string' }, seq: { type: 'integer', minimum: 1 }, messageId: { type: 'string', minLength: 1, maxLength: 100 } };
const ANSWERS: Record<ReplyMode, string> = { auto: 'when the lead or a pick decides', mentions: 'only when @mentioned', all: 'to every message' };

/** A work-update line the agent posted with chat.send status (B-047 D4: details.by 'agent'). */
const workUpdate = (message: Message): boolean => message.meta.status?.type === 'note' && message.meta.status.details?.by === 'agent';

/** The agent's own finished message named by id or by seq (in a chat it is a member of), or why not. */
function ownMessage(ctx: ToolContext, args: { chatId?: string; seq?: number; messageId?: string }): Message | string {
  let message: Message | undefined;
  if (args.messageId) {
    message = ctx.services.chats.message(args.messageId);
    if (message) resolveChat(ctx, message.conversationId);
  } else if (args.seq !== undefined) {
    const chatId = resolveChat(ctx, args.chatId);
    message = ctx.services.chats.messages(chatId, { afterSeq: args.seq - 1, limit: 1 }).find((item) => item.seq === args.seq);
  } else {
    return 'Name the message: seq (as chat.read shows it) or messageId.';
  }
  if (!message) return 'No such message.';
  if (message.authorId !== ctx.agent.id) return 'Only my own messages can be changed.';
  if (message.state === 'streaming') return 'This message is still being written.';
  if (message.kind !== 'text' && message.kind !== 'status') return 'Only my own text messages and status lines can be changed.';
  if (message.kind === 'status' && !workUpdate(message)) return 'This line records what happened in the chat: it stays. Of my status lines only work updates (chat.send status) can be deleted.';
  return message;
}

/** A refusal of the service as a tool result (its message is meant for the agent). */
function refused(error: unknown) {
  if (error instanceof WorkforceError && ['forbidden', 'conflict', 'bad_request', 'not_found'].includes(error.code)) return failure(error.message);
  throw error;
}

const editMessage = defineTool<{ chatId?: string; seq?: number; messageId?: string; text: string }>({
  name: 'chat.edit',
  description: 'Change the text of one of my own messages (by seq as chat.read shows it, or messageId). The chat shows it as edited.',
  inputSchema: { type: 'object', properties: { ...WHICH, text: { type: 'string', minLength: 1, maxLength: 60_000 } }, required: ['text'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Edit message ${args.messageId ?? `#${args.seq ?? '?'}`}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const message = ownMessage(ctx, args);
    if (typeof message === 'string') return failure(message);
    if (message.kind !== 'text') return failure('Only my own text messages can be edited.');
    try {
      const edited = ctx.services.chats.edit(message.id, args.text, ctx.agent.id);
      return json({ ok: true, messageId: edited.id, seq: edited.seq, chatId: edited.conversationId });
    } catch (error) { return refused(error); }
  },
});

const deleteMessage = defineTool<{ chatId?: string; seq?: number; messageId?: string }>({
  name: 'chat.delete',
  description: 'Delete one of my own messages or work updates (by seq as chat.read shows it, or messageId).',
  inputSchema: { type: 'object', properties: WHICH, additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Delete message ${args.messageId ?? `#${args.seq ?? '?'}`}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const message = ownMessage(ctx, args);
    if (typeof message === 'string') return failure(message);
    try {
      ctx.services.chats.removeMessage(message.id, ctx.agent.id);
      return json({ ok: true, deleted: message.id, seq: message.seq, chatId: message.conversationId });
    } catch (error) { return refused(error); }
  },
});

/** Why the agent may not archive `chatId`; undefined when it may (see the header). The chat's lead counts for nothing
 *  here: the one agent of a person's chat leads it without having started it. */
function archiveRefusal(ctx: ToolContext, chatId: string): string | undefined {
  const chat = ctx.services.chats.get(chatId)!;
  if (chat.settings.system) return APP_CHAT;
  if (chat.settings.direct) return 'A default 1:1 stays: it is the one chat of its pair.';
  const people = ctx.services.chats.members(chatId).filter((member) => !member.leftAt && member.kind !== 'agent');
  if (people.some((member) => member.memberId !== HUMAN_ID)) return 'Colleagues or outside members are in this chat (they could not write here any more): only the person archives it.';
  return people.length && chat.createdBy !== ctx.agent.id ? 'The person is in this chat and I did not start it: only they archive it.' : undefined;
}

const archiveChat = defineTool<{ chatId?: string }>({
  name: 'chat.archive',
  description: 'Archive a chat I started (or a room of agents only; never a default 1:1 or a chat with colleagues or outside members): it leaves the person\'s list, work there goes on, and an important message or an @mention of the person brings it back.',
  inputSchema: { type: 'object', properties: { chatId: { type: 'string' } }, additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal('Archive chat', args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const chatId = resolveChat(ctx, args.chatId);
    const why = archiveRefusal(ctx, chatId);
    if (why) return failure(`Nothing was changed. ${why}`);
    if (ctx.services.chats.get(chatId)!.archivedAt !== undefined) return text('This chat is archived already.');
    ctx.services.chats.status(chatId, { type: 'note', text: `Archived by ${ctx.agent.name}`, details: { archived: true, by: ctx.agent.id } }, { authorId: ctx.agent.id });
    ctx.services.chats.archive(chatId);
    return json({ ok: true, chatId, archived: true });
  },
});

const replyMode = defineTool<{ chatId?: string; mode: ReplyMode }>({
  name: 'chat.reply_mode',
  description: 'How I answer messages in a group chat that @mention nobody: "auto" (the lead or a pick decides), "mentions" (only when I am @mentioned) or "all" (every such message wakes me). A 1:1 always reaches me.',
  inputSchema: { type: 'object', properties: { chatId: { type: 'string' }, mode: { type: 'string', enum: REPLY_MODES } }, required: ['mode'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Reply mode ${args.mode}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const chatId = resolveChat(ctx, args.chatId);
    if (ctx.services.chats.get(chatId)!.settings.system) return failure(APP_CHAT);
    const current = replyModeOf(ctx.services.chats, chatId, ctx.agent.id);
    if (current === args.mode) return text(`My reply mode here is "${args.mode}" already.`);
    try {
      setReplyMode(ctx.services, chatId, ctx.agent.id, args.mode, ctx.agent.id);
    } catch (error) { return refused(error); }
    const line = `${ctx.agent.name} answers here ${ANSWERS[args.mode]}`;
    ctx.services.chats.status(chatId, { type: 'note', text: line, details: { replyMode: args.mode, by: ctx.agent.id } }, { authorId: ctx.agent.id });
    return json({ ok: true, chatId, mode: args.mode });
  },
});

export const chatMessageTools: ToolDef[] = [editMessage, deleteMessage, archiveChat, replyMode];
