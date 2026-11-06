// Chat tools: agents read and write the WhatsApp-like channels they are members of.
// Owns: chat.send (with `files`: workspace paths or visible file ids → attachments, stored
// by media/outputs.ts; its ask blocks and ```app todo=true mini-apps become the person's to-dos
// like a turn's answer; B-050 K4 `level`: 'important' sends an important message (for what the person would surely
// want a push for now – a blocker, a decisive result, big news; round 3; B-072: a step others now see that the agent
// took on its own, publishing.ts ON_YOUR_OWN), which chat/delivery.ts routes and brakes,
// 'silent' posts without unread or notification but still reaches mentioned agents – `urgent` and `silent` stay as
// older names;
// B-047 D4: every post carries the run's runId (meta.sentDuringRun), `status` posts one quiet kind 'status'
// work-update line – ≤ 200 characters, rate-limited per run; B-049 F8: the result says when the line was cut, and a
// post's result when the important brake sent it as normal (both limits left the lean description); B-050 group cost: the result names the colleagues the line
// woke and says their reply comes as a new turn – chat-replies.ts; B-054 P16 `to`: the agent's default 1:1 with that
// member (chat.direct's rule), so a run without a chat tells someone in one call; `taskId` without text: a kind
// 'task' live reference – any task link into another chat only for a task the agent reads and not "Only me"), chat.read (the same hint when it finds nothing new
// after the agent's own line of this run; B-050 round 4: a complete read of the turn's own chat counts as seen when the
// turn ends done – chat/turn-reads.ts) and chat.search (B-050 K5: the lines of the
// agent's context – chat-lines.ts over context/render.ts –, so a line the person wrote from a linked Telegram account
// carries the same note, C9), chat.list (archived chats included and marked: archive only hides a chat from the
// person's list, C2; the title the agent sees, B-050 K2) and chat.leave; making chats (chat.create, chat.direct) is in
// chat-rooms.ts, the membership tools (add/remove members, rename, lead) in chat-members.ts (whom a call names and
// who may join by an agent: chat-joins.ts), the agent's own messages
// and its settings of a chat (edit, delete, archive, reply mode) in chat-messages.ts.
// Never: posts into chats the agent is not a member of, attaches files from outside the
// workspace or files the agent may not see (or that the target chat's readers may not), or lets urgency raise permissions.

import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';
import { failure, json, text } from '../types.ts';
import { importFiles, OUTPUT_LIMITS } from '../../media/outputs.ts';
import { runStatusLines } from '../../chat/message-repo.ts';
import { noteTurnRead, readThrough } from '../../chat/turn-reads.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { directPair, levelFields, type MessageLevel, type MessageMeta } from '../../../shared/model/chat.ts';
import { appTodosOf, uiBlocksOf } from '../../../shared/blocks/parse.ts';
import { authorName, clip, defineTool, internal, isMember, readChat as readsIn, resolveChat, viewTitle } from './util.ts';
import { chatMemberTools } from './chat-members.ts';
import { chatRoomTools } from './chat-rooms.ts';
import { chatMessageTools } from './chat-messages.ts';
import { hitLines, readLines } from './chat-lines.ts';
import { readHint, sendNote } from './chat-replies.ts';
import { findDirect, findOrCreateDirect } from '../../chat/direct.ts';
import { namedMembers, scopeRefusal } from './chat-joins.ts';
import { canReadTask, onlyMe } from '../../tasks/access.ts';
import { ON_YOUR_OWN } from '../../agents/publishing.ts';

/** chat.send status (B-047 D4): one line of at most this many characters, at most one per gap and so many per run. */
export const STATUS_CHARS = 200;
export const STATUS_GAP_MS = 10_000;
export const STATUS_PER_RUN = 20;
const LEVELS: MessageLevel[] = ['normal', 'important', 'silent'];
/** chat.send's note when the important brake (chat/delivery.ts) stored the line as normal. */
const BRAKED = 'Sent as normal, not important: I sent too many important messages in this chat lately.';

type SendArgs = { chatId?: string; to?: string; text?: string; level?: MessageLevel; urgent?: boolean; mentions?: string[]; silent?: boolean; status?: boolean; taskId?: string; replyTo?: string; files?: string[] };

/**
 * B-054 P16: `to` – the agent's default 1:1 with that member, as chat.direct {with} without a topic (found, else
 * checked and made: chat/direct.ts findOrCreateDirect), so telling someone is one call and binds nothing.
 */
function directTo(ctx: ToolContext, to: string): string | ToolOutput {
  const named = namedMembers(ctx, [to]);
  if (typeof named === 'string') return failure(`Nothing was sent. ${named}`);
  const [other] = named;
  if (!other || other === ctx.agent.id) return failure('Nothing was sent: to names someone else ("human", an agent id or a colleague\'s per_… id).');
  const found = findDirect(ctx.services, ctx.agent.id, other);
  if (found) return resolveChat(ctx, found);
  const why = scopeRefusal(ctx, [], [ctx.agent.id, other]);
  if (why) return failure(`Nothing was sent. ${why}`);
  return findOrCreateDirect(ctx.services, ctx.agent.id, other, { createdBy: ctx.agent.id });
}

/**
 * B-054: why task `taskId` may not be linked to a message in `chatId` (undefined: it may). A task message there
 * lets that chat's agents read the task (tasks/access.ts), so outside the task's own chat: the agent reads
 * the task and it is not "Only me".
 */
export function taskLinkRefusal(ctx: ToolContext, taskId: string, chatId: string): string | undefined {
  const task = ctx.services.tasks.get(taskId);
  if (!task || !canReadTask(ctx.services, ctx.agent.id, task)) return `Task ${taskId} not found.`;
  if (task.conversationId === chatId) return undefined;
  if (onlyMe(ctx.services, task)) return `Task ${taskId} is marked "Only me" (or belongs to such a task): it is shown in no other chat.`;
  return undefined;
}

/** chat.send {taskId} without text: one kind 'task' message – the UI shows it as a live reference to the task. */
function postReference(ctx: ToolContext, conversationId: string, taskId: string, runId: string | undefined, args: SendArgs): ToolOutput {
  if (args.files?.length || args.mentions?.length || args.replyTo || args.status) {
    return failure('Nothing was sent. A task reference is the task alone: add text to send files, mentions, replyTo or a status with it.');
  }
  const task = ctx.services.tasks.get(taskId)!;
  const message = ctx.services.chats.send({
    conversationId, body: task.title, kind: 'task', taskId, authorId: ctx.agent.id, authorKind: 'agent', ...loudness(args),
    ...(runId ? { runId, meta: { sentDuringRun: true } } : {}),
  });
  return json({ ok: true, messageId: message.id, seq: message.seq, chatId: conversationId, taskId, note: 'Shown here as a live reference to the task.' });
}

/** The message's priority and silent flag: `level` when given, else the older urgent / silent flags. */
function loudness(args: SendArgs): { priority: 'normal' | 'important'; silent?: boolean } {
  if (args.level) return levelFields(args.level);
  return { priority: args.urgent ? 'important' : 'normal', silent: args.silent };
}

const sendMessage = defineTool<SendArgs>({
  name: 'chat.send',
  description: `Post a message into one of my chats (default: this one). to: "human", an agent id or a colleague's per_… id – sends into my 1:1 with them (opened if needed); works in a run without a chat. taskId without text: shows that task here as a live reference (tasks and to-dos need no chat; this only shows one). level: "normal" (default: unread and a notification), "important" (a push: what the person would surely want to hear at once – a real blocker, a decisive result, big news, ${ON_YOUR_OWN}; it also interrupts the agents it reaches: those I mention, else the only other agent or the lead) or "silent" (no unread or notification; reaches only the members I mention). status: true posts one short, quiet work-update line. mentions: member ids ("human", agent or per_… ids). files: workspace paths or file ids.`,
  inputSchema: {
    type: 'object',
    properties: {
      chatId: { type: 'string' }, to: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 60_000 }, level: { type: 'string', enum: LEVELS },
      urgent: { type: 'boolean' }, mentions: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      silent: { type: 'boolean' }, status: { type: 'boolean' }, taskId: { type: 'string' }, replyTo: { type: 'string' },
      files: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, maxItems: OUTPUT_LIMITS.files },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args, ctx) => internal(
    `${args.status ? 'Status update' : args.taskId && !args.text ? `Show task ${args.taskId}` : 'Message'} to ${args.to ? args.to : `chat ${args.chatId ?? ctx.conversationId ?? '?'}`}`,
    args.to ?? args.chatId ?? ctx.conversationId,
  ),
  async run(args, ctx) {
    if (args.to && args.chatId) return failure('Nothing was sent: give chatId or to, not both.');
    if (!args.text && !args.taskId) return failure('Nothing was sent: give text, or taskId to show a task here.');
    const target = args.to ? directTo(ctx, args.to) : resolveChat(ctx, args.chatId);
    if (typeof target !== 'string') return target;
    const conversationId = target;
    const runId = ctx.runId || undefined;
    const refusal = args.taskId ? taskLinkRefusal(ctx, args.taskId, conversationId) : undefined;
    if (refusal) return failure(`Nothing was sent. ${refusal}`);
    if (!args.text) return postReference(ctx, conversationId, args.taskId!, runId, args);
    const body = args.text;
    if (args.status) return statusUpdate(ctx, conversationId, runId, { ...args, text: body });
    const imported = args.files?.length ? await importFiles(ctx.services, ctx.agent.id, args.files, conversationId) : undefined;
    if (imported?.errors.length) return failure(`Nothing was sent. ${imported.errors.join(' ')}`);
    const meta: MessageMeta = { ...(runId ? { sentDuringRun: true } : {}) };
    const message = ctx.services.chats.send({
      conversationId, body, authorId: ctx.agent.id, authorKind: 'agent', attachments: imported?.attachments,
      ...loudness(args), mentions: args.mentions, taskId: args.taskId, replyTo: args.replyTo,
      ...(runId ? { runId } : {}), ...(Object.keys(meta).length ? { meta } : {}),
    });
    // Ask blocks and mini-app to-dos become the person's to-dos as in a turn's answer
    // (agents/turn-finish.ts), so a to-do stands behind each one ("todo": false keeps a block in
    // the chat only) – in their own savepoint: one that fails never leaves half of them behind.
    const blocks = uiBlocksOf(body);
    if (blocks.length || appTodosOf(body).length) {
      try { ctx.services.db.tx(() => ctx.services.tasks.ingestBlocks(message, blocks.map((item) => item.block), blocks.map((item) => item.index))); } catch (error) {
        ctx.services.log?.warn('chat.send to-dos failed', { messageId: message.id, error: String(error) });
      }
    }
    const replies = sendNote(ctx, conversationId, message); // B-050: who answers, and that it comes as a new turn
    // B-049 F8: the important brake (chat/delivery.ts) is no longer in the description – the result says when it applied.
    const braked = loudness(args).priority === 'important' && ctx.services.chats.message?.(message.id)?.priority === 'normal';
    const note = [braked ? BRAKED : '', replies?.note ?? ''].filter(Boolean).join(' ');
    return json({ ok: true, messageId: message.id, seq: message.seq, chatId: conversationId, files: message.attachments.map((file) => ({ name: file.name, fileId: file.fileId })), ...(replies ?? {}), ...(note ? { note } : {}) });
  },
});

/** chat.send status (B-047 D4): one quiet kind 'status' line of the run (runId and meta.fromRun), rate-limited per run. */
function statusUpdate(ctx: ToolContext, conversationId: string, runId: string | undefined, args: SendArgs & { text: string }): ToolOutput {
  if (args.files?.length || args.urgent || args.level === 'important' || args.mentions?.length || args.replyTo) {
    return failure('Nothing was sent. A status update is one plain line: no files, important level, mentions, replyTo or model – send those as a message.');
  }
  const flat = args.text.replace(/\s+/g, ' ').trim();
  const line = clip(flat, STATUS_CHARS - 1); // clip adds the ellipsis
  if (runId) {
    const posted = runStatusLines(ctx.services.db, runId);
    const now = ctx.services.clock.now();
    if (posted.count >= STATUS_PER_RUN || (posted.lastAt !== undefined && now - posted.lastAt < STATUS_GAP_MS)) {
      return json({ ok: false, note: `Not posted: at most one status update every ${STATUS_GAP_MS / 1000} seconds and ${STATUS_PER_RUN} per run. It goes into my next update or my final text.` });
    }
  }
  // The run's own task goes with the line only where it may be shown (an explicit taskId was checked before).
  const taskId = args.taskId ?? (ctx.taskId && !taskLinkRefusal(ctx, ctx.taskId, conversationId) ? ctx.taskId : undefined);
  const message = ctx.services.chats.status(conversationId, { type: 'note', text: line, details: { by: 'agent', ...(runId ? { runId } : {}) } }, {
    authorId: ctx.agent.id, taskId, ...(runId ? { runId, fromRun: runId } : {}),
  });
  return json({ ok: true, messageId: message.id, seq: message.seq, chatId: conversationId, status: true, ...(line !== flat ? { note: `Cut to ${STATUS_CHARS} characters: a status update is one short line.` } : {}) });
}

const readChat = defineTool<{ chatId?: string; beforeSeq?: number; afterSeq?: number; limit?: number; seq?: number }>({
  name: 'chat.read',
  description: 'Read a chat\'s messages (newest last) as lines like in my context, each led by its #seq. beforeSeq pages back; seq: one message in full.',
  inputSchema: {
    type: 'object',
    properties: {
      chatId: { type: 'string' }, beforeSeq: { type: 'integer', minimum: 0 }, afterSeq: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      seq: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  category: 'read',
  describe: (args, ctx) => internal('Read chat', args.chatId ?? ctx.conversationId),
  async run(args, ctx) {
    const conversationId = resolveChat(ctx, args.chatId, { read: true });
    const limit = args.limit ?? 30;
    const messages = args.seq !== undefined
      ? ctx.services.chats.messages(conversationId, { afterSeq: args.seq - 1, limit: 1 }).filter((message) => message.seq === args.seq)
      : ctx.services.chats.messages(conversationId, { beforeSeq: args.beforeSeq, afterSeq: args.afterSeq, limit });
    if (args.seq === undefined && args.beforeSeq === undefined && conversationId === ctx.conversationId) {
      // B-050 round 4: what this read showed of the turn's own chat is seen when the turn ends done (no second turn for it).
      const cursor = ctx.services.chats.members(conversationId).find((member) => member.memberId === ctx.agent.id && !member.leftAt)?.readSeq ?? 0;
      noteTurnRead(ctx.services, ctx.runId, conversationId, readThrough(messages, { cursor, limit, afterSeq: args.afterSeq }));
    }
    const lines = readLines(ctx, messages, { full: args.seq !== undefined });
    const hint = args.seq === undefined && args.beforeSeq === undefined ? readHint(ctx, conversationId) : undefined; // B-050: no polling
    if (hint) lines.push(...(lines.length ? [''] : []), hint);
    return text(lines.length ? lines.join('\n') : args.seq !== undefined ? `No message #${args.seq} in this chat.` : 'No messages.');
  },
});

const listChats = defineTool<{ search?: string }>({
  name: 'chat.list',
  description: 'List the chats I am a member of with id, title, members and open tasks. "archived": the person hid it from their list; work there goes on. "direct": my default 1:1 with that member. "parentId": the chat it sits under; "thread": it answers one message there.',
  inputSchema: { type: 'object', properties: { search: { type: 'string' } }, additionalProperties: false },
  category: 'read',
  describe: () => internal('List chats'),
  async run(args, ctx) {
    const chats = ctx.services.chats.list({ forMember: ctx.agent.id, search: args.search, includeHidden: true });
    return json(chats.slice(0, 100).map((chat) => ({
      id: chat.id, title: viewTitle(ctx, chat, chat.members), lastSeq: chat.lastSeq, openTasks: chat.openTasks,
      // B-078: the chat tree I build with chat.set_parent and chat.thread.
      ...(chat.settings.parentId ? { parentId: chat.settings.parentId } : {}), ...(chat.settings.anchorId ? { thread: true } : {}),
      // K1: "direct" only for the agent's own default 1:1 – one others' default it joined is not.
      ...(chat.archivedAt !== undefined ? { archived: true } : {}), ...(directPair(chat.settings, chat.members.filter((member) => !member.leftAt))?.includes(ctx.agent.id) ? { direct: true } : {}),
      members: chat.members.filter((member) => !member.leftAt).map((member) => (member.memberId === HUMAN_ID ? 'human' : `${authorName(ctx, member.memberId)} (${member.memberId})`)),
    })));
  },
});

const searchChats = defineTool<{ text: string; chatId?: string; limit?: number }>({
  name: 'chat.search',
  description: 'Full-text search over messages in my chats (other conversations included); each hit as "<chat id> #seq" and its line.',
  inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 }, chatId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['text'], additionalProperties: false },
  category: 'read',
  describe: (args) => internal(`Search chats for "${clip(args.text, 60)}"`),
  async run(args, ctx) {
    if (args.chatId) resolveChat(ctx, args.chatId, { read: true });
    const hits = ctx.services.chats.search(args.text, { conversationId: args.chatId, memberId: ctx.agent.id, limit: args.limit ?? 10 });
    if (!hits.length) return text('No matches.');
    return text(hitLines(ctx, hits).join('\n'));
  },
});

const leaveChat = defineTool<{ chatId: string }>({
  name: 'chat.leave',
  description: 'Leave a chat I no longer need to follow.',
  inputSchema: { type: 'object', properties: { chatId: { type: 'string' } }, required: ['chatId'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal('Leave chat', args.chatId),
  async run(args, ctx) {
    if (!isMember(ctx, args.chatId)) return text('I am not a member of that chat.');
    ctx.services.chats.setMembers(args.chatId, { remove: [ctx.agent.id] }, ctx.agent.id);
    return json({ ok: true });
  },
});

export const chatTools: ToolDef[] = [sendMessage, readChat, listChats, searchChats, ...chatRoomTools, ...chatMemberTools, ...chatMessageTools, leaveChat];
