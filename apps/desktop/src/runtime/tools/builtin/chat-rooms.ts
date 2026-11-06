// Making chats (B-050 K1/K3): every member counts the same – agent ids, "human" (the owner) and people of the
// organisation (per_…, checked like chat/members-change.ts does: active, not revoked), named by id or by name
// (chat-joins.ts). A colleague is seated only with agents they may work with (chat-joins.ts scopeRefusal).
//  - chat.create: a chat (work group) of the calling agent and its members; the agent leads it. `agentIds` and
//    `includeHuman` stay as older names for members. `hidden` keeps the room out of the person's list from its
//    creation on. One member without a title (and not hidden) opens the pair's default 1:1 instead, as chat.direct
//    and the person's New chat do (K1: no second chat of the pair); no other member, but a title: a work room of the
//    agent alone, which others join later. B-078: `parent` places the new chat under one of my chats (chat/children.ts).
//  - chat.direct: the agent's 1:1 with one member – without a topic the one default 1:1 of the pair
//    (chat/direct.ts findOrCreateDirect: found, adopted or made now), with a topic a new chat of just the two named
//    after it. Both answer the chat id and the title the agent sees (shared/text/chat-names.ts displayTitle).
// Owns: these tool definitions. Never: adds a member the org or the people register does not know, or finds the
// default 1:1 itself (direct.ts is the one place).

import type { ToolDef } from '../types.ts';
import { failure, json } from '../types.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import { findDirect, findOrCreateDirect } from '../../chat/direct.ts';
import { setParent } from '../../chat/children.ts';
import { namedMembers, scopeRefusal } from './chat-joins.ts';
import { defineTool, internal, memberIds, viewTitle } from './util.ts';
import type { ToolContext } from '../types.ts';

export const MEMBERS = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 30 };

/** The chat's id with the title the agent sees. */
function answer(ctx: ToolContext, chatId: string): ReturnType<typeof json> {
  return json({ ok: true, chatId, title: viewTitle(ctx, ctx.services.chats.get(chatId)!, ctx.services.chats.members(chatId)) });
}

/** The agent's default 1:1 with `other`: an existing one as it is (nothing new is opened), else checked and made (findOrCreateDirect). */
function openDirect(ctx: ToolContext, other: string): ReturnType<typeof json> | ReturnType<typeof failure> {
  const found = findDirect(ctx.services, ctx.agent.id, other);
  if (found) return answer(ctx, found); // already shared: nothing new is opened
  const why = scopeRefusal(ctx, [], [ctx.agent.id, other]);
  if (why) return failure(`Nothing was opened. ${why}`);
  return answer(ctx, findOrCreateDirect(ctx.services, ctx.agent.id, other, { createdBy: ctx.agent.id }));
}

/** ChatService.create's member fields for the caller plus `ids` (already checked). */
function membersOf(ctx: ToolContext, ids: string[]) {
  return {
    agentIds: [ctx.agent.id, ...ids.filter((id) => id !== HUMAN_ID && !isPersonId(id))],
    humans: ids.includes(HUMAN_ID),
    people: ids.filter((id) => isPersonId(id)),
  };
}

const createChat = defineTool<{ title?: string; members?: string[]; agentIds?: string[]; includeHuman?: boolean; hidden?: boolean; parent?: string }>({
  name: 'chat.create',
  description: 'I open a group I lead. members (ids or names): agents, "human" (the person) and colleagues (per_…), all equal. With "human" it is a group with the person – the place for a discussion they take part in; without, it is an internal room of us agents that the person can look into but gets nothing from. parent: a chat of mine to put it under (a special chat of that topic). For two people I use chat.direct.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 120 }, members: MEMBERS, agentIds: MEMBERS, includeHuman: { type: 'boolean' }, hidden: { type: 'boolean' }, parent: { type: 'string', minLength: 1, maxLength: 64 },
    },
    additionalProperties: false,
  },
  category: 'think',
  describe: (args) => internal(`Create chat ${args.title ?? ''}`.trim()),
  async run(args, ctx) {
    const named = namedMembers(ctx, memberIds(args));
    if (typeof named === 'string') return failure(named);
    const ids = named.filter((id) => id !== ctx.agent.id);
    // A work room of the agent alone (others join later, chat.add_members) needs a title – as before B-050.
    if (!ids.length && !args.title?.trim()) return failure('Nothing was created: name at least one member besides myself, or a title for a room of my own.');
    if (ids.length === 1 && !args.title?.trim() && !args.hidden && !args.parent) return openDirect(ctx, ids[0]); // K1: one member, no topic – the pair's default 1:1, as the UI's new chat
    const why = scopeRefusal(ctx, [], [ctx.agent.id, ...ids]);
    if (why) return failure(`Nothing was created. ${why}`);
    const conversation = ctx.services.chats.create({
      title: args.title, ...membersOf(ctx, ids), createdBy: ctx.agent.id, lead: ctx.agent.id, settings: args.hidden ? { hiddenFromList: true } : undefined,
    });
    if (args.parent) {
      try { setParent(ctx.services, conversation.id, args.parent, ctx.agent.id); } catch (error) {
        return json({ ok: true, chatId: conversation.id, note: `The chat is open on top: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return answer(ctx, conversation.id);
  },
});

const directChat = defineTool<{ with: string; topic?: string }>({
  name: 'chat.direct',
  description: 'My 1:1 with one member: an agent id, "human" (the person), a colleague\'s per_… id or a name. My 1:1 with the person is where I tell them what they need from me; my 1:1 with a colleague is where we two work things out. It stays two. Without topic: my default 1:1 with them; with topic: a new chat of just us two about it.',
  inputSchema: { type: 'object', properties: { with: { type: 'string', minLength: 1, maxLength: 200 }, topic: { type: 'string', minLength: 1, maxLength: 120 } }, required: ['with'], additionalProperties: false },
  category: 'think',
  describe: (args) => internal(`1:1 chat with ${args.with}${args.topic ? ` about "${args.topic}"` : ''}`),
  async run(args, ctx) {
    const named = namedMembers(ctx, [args.with]);
    if (typeof named === 'string') return failure(named);
    const [other] = named;
    if (!other || other === ctx.agent.id) return failure('Choose someone else: a 1:1 is with another member.');
    const topic = args.topic?.trim();
    if (!topic) return openDirect(ctx, other);
    const why = scopeRefusal(ctx, [], [ctx.agent.id, other]);
    if (why) return failure(`Nothing was opened. ${why}`);
    const conversation = ctx.services.chats.create({ title: topic, ...membersOf(ctx, [other]), createdBy: ctx.agent.id, lead: ctx.agent.id });
    return answer(ctx, conversation.id);
  },
});

export const chatRoomTools: ToolDef[] = [createChat, directChat];
