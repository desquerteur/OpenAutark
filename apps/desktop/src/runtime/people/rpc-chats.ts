// What a person's device may call (F-52), part 2: chats. A person lists, opens, reads and writes
// only chats they are an active member of – messages from their join on unless the chat shares
// its whole history ('full') –, posts as themselves (author kind 'human', never the owner, never an
// approval of anything), starts chats and groups with people and the agents of their spaces when
// their scopes allow it (the owner joins only when named), and changes members of the chats they
// started – or of a chat whose starter left it or lost access (anyone may leave) –, and edits or
// deletes only their own text messages. Attachments: files of their chats, or (wave 2) files they
// uploaded into this very chat, under the name they gave them (people/uploads.ts). Ids are seen from
// the person's perspective (people/perspective.ts). B-050 K4: they post at a level too – normal,
// important or silent (never important and silent). B-050 K1: chats.direct opens their default 1:1
// with an agent, a colleague or the owner (runtime/chat/direct.ts), as the owner's does.
// Owns: these person variants. Never: the owner's handlers, drafts, chat settings or files a person may not read.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import type { ConversationSummary, Message, SendMessageInput } from '../../shared/model/chat.ts';
import { isPersonId, type Person } from '../../shared/model/people.ts';
import type { RuntimeServices } from '../contracts.ts';
import { findDirect, findOrCreateDirect } from '../chat/direct.ts';
import { attachmentsOf, levelOf } from '../rpc/handlers/chats.ts';
import { bad, id, ids, input, num, onlyKeys, optBool, optId, optIds, optMemberIds, optNum, optText, text } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { activePerson } from './repo.ts';
import { mayReadFile, membership, personUnreadCounts, uploadedBy, visibleFrom } from './access.ts';
import { realId, viewMember, viewMessage, viewSummary } from './perspective.ts';
import { caller, usableAgent } from './rpc-base.ts';
import { uploadNameIn } from './uploads.ts';

const MAX_BODY = 100_000;

/** Display names for re-worded member lines (people and agents). */
const names = (ctx: HandlerContext) => (id: string) => ctx.services.people?.nameOf(id) ?? ctx.services.org.get(id)?.name;

/** The chat and the person's membership; 'not_found' for chats the person is not in (no hint that it exists). */
function ownChat(s: RuntimeServices, person: Person, conversationId: string) {
  const chat = s.chats.get(conversationId);
  const member = chat ? membership(s.db, person.id, conversationId) : undefined;
  if (!chat || !member) throw new WorkforceError('not_found', 'Chat not found.', { details: { conversationId } });
  return { chat, member, from: visibleFrom(chat, member.joinedAt) };
}

export function personSummary(s: RuntimeServices, person: Person, summary: ConversationSummary): ConversationSummary {
  const member = membership(s.db, person.id, summary.id);
  const from = member ? visibleFrom(summary, member.joinedAt) : 0;
  return viewSummary(person.id, summary, { ...(member ? personUnreadCounts(s.db, person.id, summary.id, member.readSeq, from) : { unread: 0 }), from });
}

/** Members a person adds: agents of their spaces, active people, the owner ('owner' in their view). */
function addable(ctx: HandlerContext, person: Person, viewIds: readonly string[]): { agents: string[]; people: string[]; owner: boolean } {
  const out = { agents: [] as string[], people: [] as string[], owner: false };
  for (const viewIdOf of viewIds) {
    const memberId = realId(person.id, viewIdOf);
    if (memberId === person.id) continue;
    if (memberId === HUMAN_ID) { out.owner = true; continue; }
    if (isPersonId(memberId)) {
      if (!activePerson(ctx.services.db, memberId)) throw new WorkforceError('not_found', 'This person is not in the organisation.', { details: { personId: viewIdOf } });
      out.people.push(memberId);
      continue;
    }
    if (!usableAgent(ctx, person, memberId)) throw new WorkforceError('forbidden', 'You may not work with this agent.', { details: { agentId: memberId } });
    out.agents.push(memberId);
  }
  return out;
}

export function registerPersonChats(table: HandlerTable): void {
  table.addPerson('chats.list', (_params, ctx) => {
    const person = caller(ctx);
    return ctx.services.chats.list({ forMember: person.id, includeHidden: true })
      .filter((chat) => !chat.settings.system)
      .map((chat) => personSummary(ctx.services, person, chat));
  });
  table.addPerson('chats.get', (params, ctx) => {
    const person = caller(ctx);
    const { chat } = ownChat(ctx.services, person, id(input(params)));
    return personSummary(ctx.services, person, ctx.services.chats.summary(chat.id));
  });
  table.addPerson('chats.create', (params, ctx) => {
    const person = caller(ctx);
    if (!person.scopes.startChats) throw new WorkforceError('forbidden', 'You may not start chats here. Ask the owner of the organisation.');
    const o = input(params);
    onlyKeys(o, ['title', 'agentIds', 'spaceId', 'firstMessage', 'people']);
    const members = addable(ctx, person, [...ids(o, 'agentIds', 50), ...(optIds(o, 'people', 50) ?? [])]);
    if (!members.agents.length && !members.people.length && !members.owner) bad('agentIds', 'at least one agent or person');
    const chat = ctx.services.chats.create({
      title: optText(o, 'title', { max: 120, allowEmpty: true }), agentIds: members.agents, humans: members.owner,
      people: [person.id, ...members.people], createdBy: person.id, spaceId: undefined,
    });
    const first = optText(o, 'firstMessage', { max: MAX_BODY, allowEmpty: true, multiline: true });
    if (first?.trim()) ctx.services.chats.send({ conversationId: chat.id, body: first, authorId: person.id, authorKind: 'human' });
    return { ...(ctx.services.chats.get(chat.id) ?? chat), createdBy: HUMAN_ID, settings: {} };
  });
  // B-050 K1/K9: "Message" on an agent, a colleague or the owner opens the person's default 1:1 with them – an existing
  // one always (an archived one comes back), a new one (or an older chat of the two adopted) only with the right to
  // start chats, and with an agent only of their spaces.
  table.addPerson('chats.direct', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['memberId']);
    const other = realId(person.id, id(o, 'memberId'));
    if (other === person.id) bad('memberId', 'someone other than you');
    if (!findDirect(ctx.services, person.id, other)) {
      if (!person.scopes.startChats) throw new WorkforceError('forbidden', 'You may not start chats here. Ask the owner of the organisation.');
      if (other !== HUMAN_ID && !isPersonId(other) && !usableAgent(ctx, person, other)) throw new WorkforceError('forbidden', 'You may not work with this agent.', { details: { agentId: other } });
    }
    const conversationId = findOrCreateDirect(ctx.services, person.id, other, { createdBy: person.id });
    if (ctx.services.chats.get(conversationId)?.archivedAt !== undefined) ctx.services.chats.unarchive(conversationId); // they could not write in it otherwise
    return personSummary(ctx.services, person, ctx.services.chats.summary(conversationId));
  });
  table.addPerson('chats.members', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['id', 'add', 'remove', 'lead']);
    const { chat } = ownChat(ctx.services, person, id(o));
    const add = optIds(o, 'add', 50) ?? [];
    const remove = (optMemberIds(o, 'remove', 50) ?? []).map((memberId) => realId(person.id, memberId));
    const leaving = remove.length === 1 && remove[0] === person.id && !add.length && o.lead === undefined;
    // The one who started it changes its members; once they left it (or lost access) every member still in it may.
    const starterIn = chat.createdBy === HUMAN_ID || isPersonId(chat.createdBy)
      ? ctx.services.chats.members(chat.id).some((member) => member.memberId === chat.createdBy) : true;
    if (!leaving && chat.createdBy !== person.id && starterIn) throw new WorkforceError('forbidden', 'Only the one who started this chat changes its members. You can leave it.');
    const members = addable(ctx, person, add);
    const lead = optId(o, 'lead');
    if (lead !== undefined && !usableAgent(ctx, person, lead)) throw new WorkforceError('forbidden', 'You may not work with this agent.');
    const result = ctx.services.chats.setMembers(chat.id, {
      add: [...members.agents, ...members.people, ...(members.owner ? [HUMAN_ID] : [])], remove, ...(lead ? { lead } : {}),
    }, person.id);
    return result.map((member) => viewMember(person.id, member));
  });
  table.addPerson('chats.markRead', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    const { chat } = ownChat(ctx.services, person, id(o));
    ctx.services.chats.markRead(chat.id, person.id, num(o, 'seq', { min: 0 }));
    return { ok: true };
  });
  table.addPerson('messages.list', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    const { chat, from } = ownChat(ctx.services, person, id(o, 'conversationId'));
    return ctx.services.chats.messages(chat.id, { beforeSeq: optNum(o, 'beforeSeq', { min: 0 }), limit: optNum(o, 'limit', { min: 1, max: 200 }) ?? 60 })
      .filter((message) => message.createdAt >= from)
      .map((message) => viewMessage(person.id, message, names(ctx)));
  });
  table.addPerson('messages.send', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['conversationId', 'body', 'attachments', 'mentions', 'priority', 'silent', 'replyTo', 'clientId', 'speech', 'ultra']);
    const { chat } = ownChat(ctx.services, person, id(o, 'conversationId'));
    if (chat.archivedAt !== undefined) throw new WorkforceError('conflict', 'This chat is archived.');
    const body = text(o, 'body', { max: MAX_BODY, allowEmpty: true, multiline: true });
    const attachments = attachmentsOf(ctx.services, o.attachments);
    // Files of their chats, or files they uploaded into this very chat – under the name they gave them.
    const named = Array.isArray(o.attachments) ? o.attachments.map((entry) => typeof (entry as { name?: unknown } | null)?.name === 'string') : [];
    attachments.forEach((file, index) => {
      const own = uploadedBy(ctx.services.db, person.id, file.fileId, chat.id);
      if (!own && !mayReadFile(ctx.services.db, person.id, file.fileId, { ownUploads: false })) bad('attachments', 'files of your own chats');
      if (own && !named[index]) file.name = uploadNameIn(ctx.services.db, person.id, file.fileId, chat.id) ?? file.name;
    });
    if (!body.trim() && !attachments.length) bad('body', 'text or an attachment');
    const replyTo = optId(o, 'replyTo');
    const quoted: Message | undefined = replyTo ? ctx.services.chats.message(replyTo) : undefined;
    const message = ctx.services.chats.send({
      conversationId: chat.id, body, attachments,
      mentions: (optMemberIds(o, 'mentions', 50) ?? []).map((memberId) => realId(person.id, memberId)),
      ...levelOf(o), replyTo: quoted && quoted.createdAt >= visibleFrom(chat, membership(ctx.services.db, person.id, chat.id)!.joinedAt) ? replyTo : undefined,
      clientId: optText(o, 'clientId', { max: 100 }), authorId: person.id, authorKind: 'human',
      speech: o.speech as SendMessageInput['speech'], // validated and capped by the chat service
      ...(optBool(o, 'ultra') ? { meta: { ultra: true as const } } : {}), // B-057: Ultra suggested for this message (a hint)
    });
    return viewMessage(person.id, message, names(ctx));
  });
  /** Their own text messages only, in a chat they are still in (the chat service checks the author). */
  const ownMessage = (ctx: HandlerContext, person: Person, messageId: string): Message => {
    const message = ctx.services.chats.message(messageId);
    if (!message || !membership(ctx.services.db, person.id, message.conversationId)) throw new WorkforceError('not_found', 'Message not found.', { details: { messageId } });
    if (message.authorId !== person.id || message.kind !== 'text') throw new WorkforceError('forbidden', 'Only your own messages can be changed.', { details: { messageId } });
    return message;
  };
  table.addPerson('messages.edit', (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    const message = ownMessage(ctx, person, id(o));
    return viewMessage(person.id, ctx.services.chats.edit(message.id, text(o, 'body', { max: MAX_BODY, multiline: true }), person.id), names(ctx));
  });
  table.addPerson('messages.delete', (params, ctx) => {
    const person = caller(ctx);
    ctx.services.chats.removeMessage(ownMessage(ctx, person, id(input(params))).id, person.id);
    return { ok: true };
  });
}
