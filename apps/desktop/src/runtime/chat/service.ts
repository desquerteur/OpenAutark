// ChatService: conversations (one group type for 1:1, groups and agent-only rooms), members,
// the canonical message log (per-chat monotonic seq), streaming agent messages, quiet status
// lines, read cursors, search and drafts. Archive/unarchive/remove/delete and publishing (agent
// outputs stored first, then C2's auto-unarchive) live in chat/lifecycle.ts – an archived chat
// is only out of the default list (includeHidden lists it); @mention candidates (the human
// under the profile name, "CEO", "Human" and "You") in chat/mentions.ts; creating a chat in
// chat/create.ts, member changes in chat/members-change.ts and the model choice and tag in
// chat/sticky-model.ts. C2: a rename
// records who named the chat (settings.namedBy) and an explicit lead change posts one
// 'lead_changed' line. C6: a reply names a message of the same chat only (another chat's is
// dropped); the person's text reply to an agent's message addresses that agent when they @mention
// nobody; editing and deleting (the person only their own text messages, notices for agents,
// the tombstone) live in chat/message-edits.ts. MM6: deleting a chat or a message (and
// replacing a chat picture) hands the files it held to the store's blob clean-up
// (chat/reclaim.ts; files/cleanup.ts removes only what nothing else uses), and the start-up
// reconcile also runs the clean-up's orphan reconcile. B-047 D4 (publishing): a run's answer is
// finished in its streaming placeholder or posted at the end without one (chat/publish-message.ts:
// moved to the end when no longer last, quiet unless it @mentions the person, B-050 K4 its level);
// chat.send posts carry their run's runId. B-050: a human text message carries the addressed agent's
// model choice as meta.modelHint (chat/sticky-model.ts, K6), and the default 1:1 (settings.direct,
// chat/direct.ts) never takes a title from its first message (K2). A draft change never does: the
// composer clears its draft right before messages.send, so a file leaving the draft may be on
// its way into a message (an upload taken out of the composer stays in the media library).
// B-078 D7: a 1:1 stays two – the owner's line in two agents' 1:1 is posted without joining it (members-change.ts
// refuses every add). B-078 sub-chats (chat/children.ts): a deleted chat takes its threads along and puts its sub-chats
// back on top; a deleted message's thread stays as a plain sub-chat of that chat (keepThreadOf).
// B-075: a run's row is its live status – its streamed body and meta.live are written into it (chat/streaming.ts,
// throttled; fed by chat/live-row.ts) and the chat summaries read who works from such rows; a run whose answer is kept
// internal gets a silent row (beginAgentMessage `silent`: a quiet seq, no text – only its work). Reads return the rows
// as stored.
// Owns: every write to conversations/members/messages/drafts and the chat events.
// Never: decides who gets woken (DeliveryService does, after commit), never copies message
// text into other tables (tasks reference messages by id) and never removes a file itself.

import { HUMAN_ID, SYSTEM_ID, newId } from '../../shared/ids.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { deriveTitle, findMentions } from '../../shared/text/chat-names.ts';
import { matchesQuery, snippet } from '../../shared/text/normalize.ts';
import type { ChatService, RuntimeServices } from '../contracts.ts';
import type {
  Conversation, ConversationSettings, ConversationSummary, Member, Message, MessageMeta, SendMessageInput, StatusLine,
} from '../../shared/model/chat.ts';
import { reclaimerOf } from '../files/cleanup.ts';
import { ConversationRepo } from './conversation-repo.ts';
import { createConversation } from './create.ts';
import { childrenOf, keepThreadOf } from './children.ts';
import {
  archiveConversation, publish, reconcileStreaming, removeConversation, unarchiveConversation, watchHumanTodos, type ChatCore, type ChatDeps as CoreDeps,
} from './lifecycle.ts';
import { MessageRepo } from './message-repo.ts';
import { deleteMessage, demoteMessage, editMessage } from './message-edits.ts';
import { pickLead } from './lead.ts';
import { changeMembers } from './members-change.ts';
import { mentionCandidates } from './mentions.ts';
import { finishAgentMessage, postAgentMessage, type AnswerFinal } from './publish-message.ts';
import { canReclaim, chatFileIds, messageFileIds, queueReclaim } from './reclaim.ts';
import { withSpeech } from './speech-meta.ts';
import { addressedAgents, applyStickyModel, cleanSettings, modelTag } from './sticky-model.ts';
import { buildSummaries, isHidden } from './summary.ts';
import { StreamingRows } from './streaming.ts';
import { feedLiveRows } from './live-row.ts';
import { isPersonId } from '../../shared/model/people.ts';
import '../contracts/people.ts';

/** The lifecycle's deps plus settings (the human's profile name as an @mention alias, chat/mentions.ts). */
export type ChatDeps = CoreDeps & Partial<Pick<RuntimeServices, 'settings' | 'people'>>;

type SendInput = Parameters<ChatService['send']>[0];

export class ChatServiceImpl implements ChatService {
  private readonly s: ChatDeps;
  private readonly convs: ConversationRepo;
  private readonly msgs: MessageRepo;
  private readonly streams: StreamingRows;
  private readonly unwatch: () => void;
  private readonly unfeed: () => void;

  /** `liveGapMs`: at most one write of a streaming row per that many ms (chat/streaming.ts; tests pass 0). */
  constructor(deps: ChatDeps, options: { liveGapMs?: number } = {}) {
    this.s = deps;
    this.convs = new ConversationRepo(deps.db);
    this.msgs = new MessageRepo(deps.db);
    this.streams = new StreamingRows({ msgs: this.msgs, bus: deps.bus, written: (message) => this.emitConversation(message.conversationId) }, options.liveGapMs);
    this.unfeed = feedLiveRows(deps.bus, this.streams, (message, error) => deps.log?.warn(message, { error: String(error) }));
    this.unwatch = watchHumanTodos(this.core());
  }

  // ------------------------------------------------------------- conversations

  list(options: { includeHidden?: boolean; search?: string; forMember?: string } = {}): ConversationSummary[] {
    let rows = buildSummaries(this.convs.list({ forMember: options.forMember, includeArchived: options.includeHidden }), this.repos());
    if (!options.includeHidden) rows = rows.filter(row => !isHidden(row));
    if (options.search?.trim()) {
      const query = options.search;
      rows = rows.filter(row => matchesQuery([row.title, ...row.members.map(m => this.nameOf(m.memberId))].join(' '), query));
    }
    return rows;
  }

  get(id: string): Conversation | undefined {
    return this.convs.get(id);
  }

  summary(id: string): ConversationSummary {
    return buildSummaries([this.require(id)], this.repos())[0];
  }

  members(id: string): Member[] {
    return this.convs.members(id);
  }

  lead(conversationId: string): string | undefined {
    const members = this.convs.members(conversationId);
    return members.find(m => m.kind === 'agent' && m.role === 'lead')?.memberId
      ?? pickLead({ agentIds: members.filter(m => m.kind === 'agent').map(m => m.memberId), createdBy: this.get(conversationId)?.createdBy ?? '', org: this.s.org });
  }

  create(input: Parameters<ChatService['create']>[0]): Conversation {
    const conversation = createConversation({ db: this.s.db, convs: this.convs, org: this.s.org, now: this.s.clock.now(), nameOf: (id) => this.nameOf(id) }, input);
    this.emitConversation(conversation.id);
    return conversation;
  }

  update(id: string, patch: { title?: string; pinned?: boolean; settings?: Partial<ConversationSettings> }, by: string): Conversation {
    const conversation = this.require(id);
    const now = this.s.clock.now();
    const renamed = patch.title !== undefined && patch.title.trim() && patch.title.trim() !== conversation.title;
    if (patch.pinned !== undefined) conversation.pinned = patch.pinned;
    const image = conversation.settings.image;
    if (patch.settings) conversation.settings = cleanSettings({ ...conversation.settings, ...patch.settings });
    if (renamed) { conversation.title = patch.title!.trim(); conversation.titleNamed = true; conversation.settings = { ...conversation.settings, namedBy: by }; }
    conversation.updatedAt = now;
    this.convs.update(conversation);
    if (image && image !== conversation.settings.image) queueReclaim(this.s.files, [image]); // MM6: a replaced chat picture
    if (renamed) this.status(id, { type: 'renamed', text: `Renamed to ${conversation.title}`, details: { by } }, { authorId: by });
    else this.emitConversation(id);
    return conversation;
  }

  setMembers(id: string, change: { add?: string[]; remove?: string[]; lead?: string }, by: string): Member[] {
    const conversation = this.require(id);
    const leadBefore = this.convs.members(id).find(m => m.role === 'lead')?.memberId;
    const lines = changeMembers({ db: this.s.db, convs: this.convs, org: this.s.org, nameOf: (memberId) => this.nameOf(memberId) }, conversation, change, by, this.s.clock.now());
    const lead = this.convs.members(id).find(m => m.role === 'lead')?.memberId;
    if (change.lead && lead === change.lead && lead !== leadBefore) lines.push({ type: 'lead_changed', text: `${this.nameOf(lead)} leads this chat now`, details: { memberId: lead, by } });
    for (const line of lines) this.status(id, line, { authorId: by });
    if (!lines.length) this.emitConversation(id);
    return this.convs.members(id);
  }

  archive(id: string): void { archiveConversation(this.core(), this.require(id)); }

  unarchive(id: string): void { unarchiveConversation(this.core(), this.require(id)); }

  /** MM6: the chat's files are queued while its rows exist; the clean-up batch runs after this call. */
  remove(id: string): void {
    const conversation = this.require(id);
    for (const childId of childrenOf(this.s, id)) { // B-078: no thread or sub-chat is left under a chat that is gone
      const child = this.convs.get(childId);
      if (child?.settings.anchorId) this.remove(childId);
      else if (child) this.update(childId, { settings: { parentId: undefined } }, SYSTEM_ID);
    }
    if (canReclaim(this.s.files)) queueReclaim(this.s.files, chatFileIds(this.s.db, conversation, this.convs.draft(id)?.attachments));
    removeConversation(this.core(), conversation.id);
  }

  // ------------------------------------------------------------- messages

  send(input: SendInput): Message {
    const conversation = this.require(input.conversationId);
    if (input.clientId) {
      const existing = this.msgs.byClientId(conversation.id, input.clientId);
      if (existing) return existing; // double-send guard: same result, no new events
    }
    const now = this.s.clock.now();
    const authorKind = input.authorKind ?? (input.authorId === HUMAN_ID ? 'human' : input.authorId === SYSTEM_ID ? 'system' : 'agent');
    const members = this.convs.members(conversation.id);
    if (authorKind === 'agent' && !members.some(m => m.memberId === input.authorId)) {
      throw new WorkforceError('forbidden', 'Only members can post in this chat.', { details: { conversationId: conversation.id } });
    }
    const candidates = mentionCandidates(members, input.authorId, (id) => this.nameOf(id), this.s.settings);
    const memberIds = new Set(members.map(m => m.memberId));
    const named = [...new Set([...(input.mentions ?? []).filter(id => memberIds.has(id)), ...findMentions(input.body, candidates)])];
    const quoted = input.replyTo ? this.msgs.get(input.replyTo) : undefined;
    const replyTo = quoted?.conversationId === conversation.id ? quoted : undefined; // never another chat's message
    // K4: a quiet reply mentions nobody by itself (silent wakes only explicit @mentions; chat/quiet-pickup.ts hands it to that agent later).
    const repliedAgent = authorKind === 'human' && !input.silent && (input.kind ?? 'text') === 'text' && replyTo?.authorKind === 'agent' && members.some(m => m.memberId === replyTo.authorId && m.kind === 'agent');
    const mentions = !named.length && repliedAgent ? [replyTo!.authorId] : named; // a receipt (kind 'answer') quotes its ask, mentions no one
    const message: Message = {
      id: newId('msg', now),
      conversationId: conversation.id,
      seq: 0,
      authorId: input.authorId,
      authorKind,
      kind: input.kind ?? 'text',
      body: input.body,
      attachments: input.attachments ?? [],
      mentions,
      priority: input.priority ?? 'normal',
      state: 'final',
      silent: input.silent ?? input.kind === 'status',
      // SM8: a dictated/spoken human message carries the recognizer's uncertainty (validated, capped).
      meta: authorKind === 'human' ? withSpeech(input.meta ?? {}, input.speech) : input.meta ?? {},
      createdAt: now,
    };
    if (replyTo) message.replyTo = replyTo.id;
    if (input.taskId) message.taskId = input.taskId;
    if (input.runId) message.runId = input.runId;
    this.s.db.tx(() => {
      // Human posting into a room without them joins it (owner override, never hidden from the owner);
      // F-52: a person of the organisation never joins a chat by posting (people/rpc-chats.ts checks membership).
      if (authorKind === 'human' && !memberIds.has(input.authorId) && isPersonId(input.authorId)) {
        throw new WorkforceError('forbidden', 'Only members can post in this chat.', { details: { conversationId: conversation.id } });
      }
      // B-078 D7: a 1:1 stays two – the owner's line in two agents' 1:1 is posted without joining it.
      if (authorKind === 'human' && !memberIds.has(input.authorId) && !conversation.settings.direct) {
        this.convs.upsertMember({ conversationId: conversation.id, memberId: input.authorId, kind: 'human', role: 'member', readSeq: conversation.lastSeq, joinedAt: now });
      }
      const chose = authorKind === 'human' && applyStickyModel(conversation, message, input, members); // a person's choice only
      if (authorKind === 'human' && message.kind === 'text') { // K6: the addressed agent's choice as the message's tag (Auto: none)
        const { modelHint: _sent, ...meta } = message.meta;
        const tag = modelTag(conversation.settings, addressedAgents(message, members)[0]);
        message.meta = tag ? { ...meta, modelHint: tag } : meta;
      }
      message.seq = this.convs.nextSeq(conversation.id, now);
      this.msgs.insert(message, input.clientId);
      // A human who writes has read the chat; an agent has only "seen" its own line when it
      // was caught up before (its cursor is otherwise advanced by the turn integration).
      if (authorKind === 'human') this.convs.advanceRead(conversation.id, input.authorId, message.seq);
      else this.convs.advanceReadIfCaughtUp(conversation.id, input.authorId, message.seq);
      if (chose) this.convs.update(conversation);
      if (!conversation.titleNamed && !conversation.settings.direct && authorKind === 'human' && message.kind === 'text' && !this.hadHumanText(conversation.id, message.seq)) {
        const title = deriveTitle(message.body);
        if (title) { conversation.title = title; conversation.updatedAt = now; this.convs.update(conversation); }
      }
    });
    publish(this.core(), message, 'message.created', { deliver: true });
    return message;
  }

  status(conversationId: string, line: StatusLine, options: { authorId?: string; taskId?: string; runId?: string; fromRun?: string } = {}): Message {
    const authorId = options.authorId && options.authorId !== HUMAN_ID ? options.authorId : SYSTEM_ID;
    const members = this.convs.members(conversationId);
    const authorKind = members.some(m => m.memberId === authorId && m.kind === 'agent') ? 'agent' : 'system';
    return this.send({
      conversationId, body: line.text, kind: 'status', silent: true, taskId: options.taskId, runId: options.runId,
      authorId: authorKind === 'agent' ? authorId : SYSTEM_ID, authorKind, meta: { status: line, ...(options.fromRun ? { fromRun: options.fromRun } : {}) },
    });
  }

  /** B-075: `silent` – the row only shows the run's work (chat/live-row.ts); its finish decides what it becomes. */
  beginAgentMessage(conversationId: string, agentId: string, runId: string, meta: MessageMeta = {}, options: { silent?: boolean } = {}): Message {
    const conversation = this.require(conversationId);
    const now = this.s.clock.now();
    const message: Message = {
      id: newId('msg', now), conversationId, seq: 0, authorId: agentId, authorKind: 'agent', kind: 'text', body: '',
      attachments: [], mentions: [], priority: 'normal', runId, state: 'streaming', silent: options.silent === true, meta, createdAt: now,
    };
    this.s.db.tx(() => {
      message.seq = this.convs.nextSeq(conversation.id, now, { quiet: message.silent }); // a silent row moves no chat up the list
      this.msgs.insert(message);
    });
    this.streams.begin(message);
    this.s.bus.emit('message.created', message);
    this.emitConversation(conversationId);
    return message;
  }

  appendDelta(messageId: string, text: string): void {
    this.streams.append(messageId, text);
  }

  /**
   * `files` (EngineTurnResult.files) are stored and attached before the message is announced; `silent`
   * and `priority` set its level (chat/publish-message.ts: quiet unless it @mentions the person; moved
   * to the end when no longer the chat's last message).
   */
  finishAgentMessage(messageId: string, final: AnswerFinal & { state: Message['state'] }): Message {
    const message = this.requireMessage(messageId);
    return finishAgentMessage(this.core(), message, final, this.mentionsOf(message.conversationId, message.authorId, final.body));
  }

  postAgentMessage(conversationId: string, agentId: string, runId: string, final: AnswerFinal): Message {
    this.require(conversationId);
    return postAgentMessage(this.core(), conversationId, agentId, runId, final, this.mentionsOf(conversationId, agentId, final.body));
  }

  mentionsOf(conversationId: string, authorId: string, body: string): string[] {
    const candidates = mentionCandidates(this.convs.members(conversationId), authorId, (id) => this.nameOf(id), this.s.settings);
    return findMentions(body, candidates);
  }

  /** C6: the person edits only their own text messages, an agent only its own (chat/message-edits.ts). */
  edit(messageId: string, body: string, by: string): Message {
    return editMessage(this.core(), this.requireMessage(messageId), body, by);
  }

  demote(messageId: string): void {
    const message = this.msgs.get(messageId);
    if (message) demoteMessage(this.core(), message);
  }

  removeMessage(messageId: string, by: string): void {
    const message = this.requireMessage(messageId);
    deleteMessage(this.core(), message, by);
    queueReclaim(this.s.files, messageFileIds(message)); // MM6
    keepThreadOf({ db: this.s.db, chats: this }, message);
  }

  message(id: string): Message | undefined {
    return this.msgs.get(id);
  }

  messages(conversationId: string, options: { afterSeq?: number; beforeSeq?: number; limit?: number } = {}): Message[] {
    return this.msgs.page(conversationId, options);
  }

  markRead(conversationId: string, memberId: string, seq: number): void {
    const moved = this.convs.advanceRead(conversationId, memberId, seq);
    if (moved && (memberId === HUMAN_ID || isPersonId(memberId))) this.emitConversation(conversationId); // F-52: a person's unread too
  }

  search(text: string, options: { conversationId?: string; memberId?: string; limit?: number; excludeConversations?: readonly string[] } = {}): Array<{ message: Message; snippet: string }> {
    return this.msgs.search(text, options).map(message => ({ message, snippet: snippet(message.body, text) }));
  }

  draft(conversationId: string): { text: string; attachments: unknown[] } | undefined {
    return this.convs.draft(conversationId);
  }

  /** No clean-up from here (MM6, see the header): the draft is a use while it holds a file, nothing more. */
  saveDraft(conversationId: string, text: string, attachments: unknown[] = [], secrets: string[] = []): void {
    this.require(conversationId);
    this.convs.saveDraft(conversationId, text, attachments, this.s.clock.now(), secrets);
  }

  /** Start-up: streaming messages left by a crash, then the blob clean-up's orphan reconcile (MM6). */
  reconcileStreaming(): number {
    const stopped = reconcileStreaming(this.core());
    reclaimerOf(this.s.files)?.reconcileOrphans();
    return stopped;
  }

  dispose(): void {
    this.unwatch();
    this.unfeed();
    this.streams.dispose();
  }

  // ------------------------------------------------------------- internals

  private repos() {
    return { conversations: this.convs, messages: this.msgs };
  }

  private core(): ChatCore {
    return {
      s: this.s, convs: this.convs, msgs: this.msgs, streams: this.streams, emitConversation: (id) => this.emitConversation(id), deliver: (message) => this.deliver(message),
      status: (id, line) => { this.status(id, line); }, nameOf: (id) => this.nameOf(id),
    };
  }

  private require(id: string): Conversation {
    const conversation = this.convs.get(id);
    if (!conversation) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId: id } });
    return conversation;
  }

  private requireMessage(id: string): Message {
    const message = this.msgs.get(id);
    if (!message) throw new WorkforceError('not_found', 'Message not found.', { details: { messageId: id } });
    return message;
  }

  private nameOf(memberId: string): string {
    if (memberId === HUMAN_ID) return 'You';
    if (memberId.startsWith('ext:')) return memberId.split(':').pop() || memberId; // C8: 'Added Research-Bot', '@Research-Bot'
    if (isPersonId(memberId)) return this.s.people?.nameOf(memberId) ?? 'Former colleague'; // F-52: people of the organisation
    return this.s.org?.get(memberId)?.name ?? memberId;
  }

  private hadHumanText(conversationId: string, beforeSeq: number): boolean {
    return Boolean(this.s.db.get(
      `SELECT 1 FROM messages WHERE conversation_id = ? AND seq < ? AND author_kind = 'human' AND kind = 'text' LIMIT 1`,
      [conversationId, beforeSeq],
    ));
  }

  private deliver(message: Message): void {
    try {
      this.s.delivery?.onMessage(message);
    } catch (error) {
      this.s.log?.error('delivery failed', { messageId: message.id, error: String(error) });
    }
  }

  private emitConversation(id: string): void {
    const conversation = this.convs.get(id);
    if (conversation) this.s.bus.emit('conversation.upserted', buildSummaries([conversation], this.repos())[0]);
  }
}
