// RPC handlers: people of the organisation (F-52, runtime/people). The owner manages people
// (list, add/edit, invite, revoke, devices, audit, a person's chats as metadata; the owner's own phones
// may read the list to name people);
// a person's device joins with the tokenless people.join / people.awaitJoin (rpc/tokenless.ts) and
// then reaches only the person variants (runtime/people/rpc-*.ts, table.addPerson).
// Owns: param checks, scope rules and the registration of the person variants.
// Never: business logic (people/service.ts) or any person access the variants do not check.

import { WorkforceError } from '../../../shared/errors.ts';
import { HUMAN_ID } from '../../../shared/ids.ts';
import type { PersonChat, PersonScopes } from '../../../shared/model/people.ts';
import type { Avatar } from '../../../shared/model/org.ts';
import type { RuntimeServices } from '../../contracts.ts';
import '../../contracts/people.ts';
import { chatIdsOf } from '../../people/access.ts';
import { directChat } from '../../people/direct-chat.ts';
import { memberName } from '../../chat/titles.ts';
import { displayTitle } from '../../../shared/text/chat-names.ts';
import { registerPersonBase } from '../../people/rpc-base.ts';
import { registerPersonChats } from '../../people/rpc-chats.ts';
import { registerPersonTasks } from '../../people/rpc-tasks.ts';
import { registerPersonWork } from '../../people/rpc-work.ts'; // their files and "Make it mine"
import type { PeopleService } from '../../people/service.ts';
import { currentCaller } from '../caller.ts';
import { id, input, onlyKeys, optNum, optObj, optText } from '../params.ts';
import type { HandlerTable } from '../table.ts';

export function peopleOf(services: RuntimeServices): PeopleService {
  if (!services.people) throw new WorkforceError('unavailable', 'People are not available on this PC.');
  return services.people;
}

/** A person's chats as metadata (titles and member names): the current ones, and the ones they left that the owner is not in
 *  (marked `left` – the owner may take such a chat over by joining, PersonDetails.tsx). */
function chatsOf(services: RuntimeServices, personId: string): PersonChat[] {
  const people = peopleOf(services);
  const name = (memberId: string) => people.nameOf(memberId) ?? services.org.get(memberId)?.name ?? 'Former member';
  const current = chatIdsOf(services.db, personId);
  const withoutOwner = (chatId: string) => !services.chats.members(chatId).some((member) => member.memberId === HUMAN_ID && !member.leftAt);
  const former = services.db.all<{ conversation_id: string }>('SELECT conversation_id FROM members WHERE member_id = ? AND left_at IS NOT NULL', [personId])
    .map((row) => String(row.conversation_id)).filter((chatId) => !current.has(chatId) && withoutOwner(chatId));
  return [...current, ...former].map((chatId) => {
    const chat = services.chats.get(chatId);
    const members = services.chats.members(chatId);
    return chat && {
      // B-050 K2: its title, else (a default 1:1 or an untitled group stores none) named as the person sees it.
      id: chat.id, title: chat.title.trim() || displayTitle(chat, members.filter((member) => !member.leftAt), personId, (memberId) => memberName(services, memberId)), members: members.map((member) => name(member.memberId)), withOwner: members.some((member) => member.memberId === HUMAN_ID),
      ...(current.has(chatId) ? {} : { left: true }),
    };
  }).filter((entry): entry is PersonChat => Boolean(entry));
}

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- the owner (admin)
  table.add('people.list', (_params, ctx) => peopleOf(ctx.services).list(), { capability: 'todo' }); // the owner's own phones name people too
  table.add('people.save', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'name', 'title', 'avatar', 'managerId', 'scopes']);
    const managerId = o.managerId === null ? null : optText(o, 'managerId', { max: 128 });
    return peopleOf(ctx.services).save({
      id: optText(o, 'id', { max: 64 }), name: optText(o, 'name', { max: 80 }), title: optText(o, 'title', { max: 80, allowEmpty: true }),
      avatar: optObj(o, 'avatar') as Avatar | undefined, ...(o.managerId !== undefined ? { managerId } : {}),
      scopes: optObj(o, 'scopes') as PersonScopes | undefined, // cleaned by the service (people/repo.ts cleanScopes)
    });
  });
  table.add('people.invite', (params, ctx) => peopleOf(ctx.services).invite(id(input(params))));
  table.add('people.closeInvite', (params, ctx) => { peopleOf(ctx.services).closeInvite(id(input(params))); return { ok: true }; });
  table.add('people.revoke', (params, ctx) => peopleOf(ctx.services).revoke(id(input(params))));
  table.add('people.removeDevice', (params, ctx) => {
    const o = input(params);
    return peopleOf(ctx.services).removeDevice(id(o), id(o, 'deviceId'));
  });
  table.add('people.audit', (params, ctx) => {
    const o = input(params);
    return peopleOf(ctx.services).audit(id(o), optNum(o, 'limit', { min: 1, max: 500 }));
  });
  table.add('people.chats', (params, ctx) => { const personId = id(input(params)); peopleOf(ctx.services).require(personId); return chatsOf(ctx.services, personId); });
  table.add('people.directChat', (params, ctx) => {
    const conversationId = directChat(ctx.services, HUMAN_ID, id(input(params)));
    if (ctx.services.chats.get(conversationId)?.archivedAt !== undefined) ctx.services.chats.unarchive(conversationId); // B-050 K1: opened on purpose, as chats.direct
    return { conversationId };
  });

  // ---------------------------------------------------------------- tokenless joining (rpc/tokenless.ts serves these)
  table.add('people.join', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['ticket', 'code', 'name']);
    const ticket = optText(o, 'ticket', { max: 200 });
    const code = optText(o, 'code', { max: 12 });
    if (ticket === undefined && code === undefined) throw new WorkforceError('bad_request', 'Open the invite link, scan its QR code or enter its code.');
    return peopleOf(ctx.services).join({ ticket, code, name: optText(o, 'name', { max: 60, allowEmpty: true }), remote: currentCaller()?.remote });
  });
  table.add('people.awaitJoin', (params, ctx) => peopleOf(ctx.services).awaitJoin(optText(input(params), 'ticket', { max: 200 }) ?? '', ctx.signal));

  // ---------------------------------------------------------------- what a person's device may call
  registerPersonBase(table);
  registerPersonChats(table);
  registerPersonTasks(table);
  registerPersonWork(table);
}
