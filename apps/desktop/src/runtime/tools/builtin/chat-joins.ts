// Who a chat tool names and who may join a chat by an agent (B-050 K3/K10). Members are named by id – an agent id,
// "human" (the owner), a colleague (per_…) – or by name: the owner's, a colleague's or an agent's, case ignored, or a
// first name only one of them has (an agent may know just the name, and people.list is not offered in every mode).
// Two rules keep an agent from opening more to people than they may see – the rules a person's own invitations
// follow (people/rpc-chats.ts):
//  - a colleague shares a room only with agents they may work with (their spaces, people/access.ts mayUseAgent),
//    checked for the pairs a change makes new, so a room the person put together stays as it is;
//  - colleagues join a chat by the agent that started it – so an agent never opens the owner's chats to a colleague.
//    A 1:1 stays two for everyone (B-078 D7, chat/members-change.ts DIRECT_STAYS_TWO; chat-members.ts checks it first).
// Owns: these lookups and rules. Never: changes members itself, or lets a name choose between two members.

import type { ToolContext } from '../types.ts';
import { HUMAN_ID, SYSTEM_ID } from '../../../shared/ids.ts';
import type { Conversation } from '../../../shared/model/chat.ts';
import { isPersonId, type Person } from '../../../shared/model/people.ts';
import { mayUseAgent } from '../../people/access.ts';
import { PeopleRepo } from '../../people/repo.ts';
import { authorName, memberRefusal } from './util.ts';

/** An id as the runtime makes them (ag_…, per_…) – taken as it is, never looked up as a name. */
const ID_LIKE = /^[a-z]{2,4}_\S+$/;

/** Everyone a name may stand for: the owner, colleagues who are not revoked, the org's agents. */
function directory(ctx: ToolContext): Array<{ id: string; name: string }> {
  let owner = '';
  try { owner = ctx.services.settings.get().profile.name?.trim() ?? ''; } catch { /* no profile */ }
  let people: Array<{ id: string; name: string }> = [];
  try { people = ctx.services.db.all<{ id: string; name: string }>(`SELECT id, name FROM people WHERE status <> 'revoked' AND id <> ?`, [HUMAN_ID]); } catch { /* no people table */ }
  return [...(owner ? [{ id: HUMAN_ID, name: owner }] : []), ...people, ...ctx.services.org.list().map((agent) => ({ id: agent.id, name: agent.name }))];
}

/** The member `raw` names (see the header), or why it names nobody or more than one. */
function named(ctx: ToolContext, raw: string): string | { refused: string } {
  const value = raw.trim();
  if (value === HUMAN_ID || ID_LIKE.test(value) || ctx.services.org.get(value)) return value;
  const wanted = value.toLowerCase();
  const all = directory(ctx);
  const exact = all.filter((entry) => entry.name.trim().toLowerCase() === wanted);
  const fits = exact.length ? exact : all.filter((entry) => entry.name.trim().toLowerCase().split(/\s+/)[0] === wanted);
  if (fits.length === 1) return fits[0].id;
  if (fits.length) return { refused: `"${value}" fits ${fits.slice(0, 5).map((entry) => `${entry.name} (${entry.id})`).join(', ')}: name one by id.` };
  return { refused: `Nobody is called "${value}": name members by id (an agent id, "human" or a colleague's per_… id) or by full name.` };
}

/** The member ids `raws` name, once each – every one a member an agent may add (util.ts memberRefusal) – or why not. */
export function namedMembers(ctx: ToolContext, raws: readonly string[]): string[] | string {
  const ids: string[] = [];
  for (const raw of raws) {
    const id = named(ctx, raw);
    if (typeof id !== 'string') return id.refused;
    const why = memberRefusal(ctx, id);
    if (why) return why;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

const isAgentId = (id: string): boolean => id !== HUMAN_ID && id !== SYSTEM_ID && !isPersonId(id) && !id.startsWith('ext:');

/**
 * Why the change would seat a colleague with an agent they may not work with (see the header); undefined when it
 * would not. `present`: the room's active members before it; `added`: who joins (the calling agent too when it opens the room).
 */
export function scopeRefusal(ctx: ToolContext, present: readonly string[], added: readonly string[]): string | undefined {
  const all = [...new Set([...present, ...added])];
  const agents = all.filter(isAgentId);
  if (!agents.length) return undefined;
  const repo = new PeopleRepo(ctx.services.db);
  for (const personId of all.filter((id) => isPersonId(id))) {
    let person: Person | undefined;
    try { person = repo.get(personId); } catch { person = undefined; }
    for (const agentId of agents) {
      if (!added.includes(personId) && !added.includes(agentId)) continue; // a pair the room already had
      if (!person || !mayUseAgent(person, ctx.services.org.get(agentId))) {
        return `${authorName(ctx, personId)} does not work with ${authorName(ctx, agentId)} (not in the spaces the person gave them).`;
      }
    }
  }
  return undefined;
}

/** Why colleagues may not join `chat` by this agent (see the header); undefined when they may or none joins. */
export function colleagueRefusal(ctx: ToolContext, chat: Conversation, added: readonly string[]): string | undefined {
  if (!added.some((id) => isPersonId(id))) return undefined;
  if (chat.createdBy !== ctx.agent.id) {
    return `${authorName(ctx, chat.createdBy)} started this chat and brings colleagues into it; I ask them, or I start a group with chat.create (members …).`;
  }
  return undefined;
}
