// Shared chat notes for agents: chat.notes.read, chat.notes.append and chat.notes.write on the Markdown notes
// every member of a chat edits (runtime/notes/store.ts) – the current chat by default, another chat when the
// agent is a member. Last write wins: write replaces the whole text, so read first and keep what others wrote.
// Named chat.notes.* so every mode offering chat.* offers them.
// Owns: these tools and their wording. Never: posts a chat message.

import { NOTES_MAX_CHARS } from '../../../shared/model/notes.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import '../../contracts/people.ts';
import { appendNotes, getNotes, saveNotes } from '../../notes/store.ts';
import type { ToolContext } from '../types.ts';
import { json, text } from '../types.ts';
import { authorName, defineTool, internal, iso, resolveChat } from './util.ts';

/** Who wrote last: the owner, a person of the organisation or an agent. */
const writer = (ctx: ToolContext, id: string | undefined): string => (!id ? 'someone' : isPersonId(id) ? ctx.services.people?.nameOf(id) ?? 'a colleague' : authorName(ctx, id));
const chatArg = { type: 'string', description: 'Default: the current chat.' };

const readNotes = defineTool<{ chatId?: string }>({
  name: 'chat.notes.read',
  description: 'Read the shared notes of a chat I am a member of (a Markdown document every member edits).',
  inputSchema: { type: 'object', properties: { chatId: chatArg }, additionalProperties: false },
  category: 'read',
  describe: (args, ctx) => internal('Read chat notes', args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const chatId = resolveChat(ctx, args.chatId, { read: true });
    const notes = getNotes(ctx.services, chatId);
    if (notes.version === 0) return text(`Notes of chat ${chatId}: empty. Add to them with chat.notes.append.`);
    return text(`Notes of chat ${chatId} · last changed by ${writer(ctx, notes.updatedBy)} at ${iso(notes.updatedAt) ?? '?'}.\n\n${notes.text}`);
  },
});

const appendTool = defineTool<{ chatId?: string; text: string }>({
  name: 'chat.notes.append',
  description: 'Add text at the end of a chat\'s shared notes.',
  inputSchema: { type: 'object', properties: { chatId: chatArg, text: { type: 'string', minLength: 1, maxLength: NOTES_MAX_CHARS } }, required: ['text'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Add to the notes of chat ${args.chatId ?? ctx.conversationId ?? '?'}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const chatId = resolveChat(ctx, args.chatId, { read: true });
    const notes = appendNotes(ctx.services, chatId, args.text, ctx.agent.id);
    return json({ ok: true, chatId, version: notes.version });
  },
});

const writeTool = defineTool<{ chatId?: string; text: string }>({
  name: 'chat.notes.write',
  description: 'Replace the whole text of a chat\'s shared notes (read them first and keep what others wrote).',
  inputSchema: { type: 'object', properties: { chatId: chatArg, text: { type: 'string', maxLength: NOTES_MAX_CHARS } }, required: ['text'], additionalProperties: false },
  category: 'think',
  describe: (args, ctx) => internal(`Rewrite the notes of chat ${args.chatId ?? ctx.conversationId ?? '?'}`, args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const chatId = resolveChat(ctx, args.chatId, { read: true });
    const notes = saveNotes(ctx.services, chatId, args.text, ctx.agent.id);
    return json({ ok: true, chatId, version: notes.version });
  },
});

export const notesTools = [readNotes, appendTool, writeTool];
