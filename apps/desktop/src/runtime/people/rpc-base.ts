// What a person's device may call (F-52), part 1: the shell's base – who am I (session.info with
// exactly the person methods; without the right to start chats no chats.create, so their app offers
// no "+ Chat" that would be refused), subscriptions (only topics people/events.ts serves them), the app
// settings a person's app reads (defaults with their name – never the owner's setup), drafts (none:
// a person's drafts stay in their browser), system facts without this PC's folder, the agents they
// see as colleagues (people/access.ts visibleAgents – never another space's agents beyond their
// chats and reporting lines), their live work (status lines only in the person's chats), their spaces, the people
// directory and the 1:1 chat with another human, and notifications on their device (pwa.push*: the subscription
// is bound to that device; pwa/person-push.ts sends a new message of their chats). Every call first checks that
// the person's token and access still hold (PeopleService.caller).
// Owns: these person variants (table.addPerson). Never: runs the owner's handler for a person.

import type { MethodName, SessionInfo } from '../../shared/api/methods.ts';
import type { Topic } from '../../shared/api/protocol.ts';
import { WorkforceError } from '../../shared/errors.ts';
import type { Person } from '../../shared/model/people.ts';
import { bad, id, input, onlyKeys, optBool, optText } from '../rpc/params.ts';
import { isTopic } from '../rpc/scopes.ts';
import { allowedScope, type HandlerContext, type HandlerTable } from '../rpc/table.ts';
import { maySeeSpace, mayUseAgent, visibleAgents } from './access.ts';
import { directChat } from './direct-chat.ts';
import { personActivity, personMaySubscribe } from './events.ts';
import { personSettings, personSystemInfo, realId, viewAgent, viewPerson } from './perspective.ts';

export const MAX_PERSON_TOPICS = 40;

/** The calling person while their token and access still hold. */
export function caller(ctx: HandlerContext): Person {
  const people = ctx.services.people;
  if (!people || ctx.scope.kind !== 'person') throw new WorkforceError('forbidden', 'Only people of the organisation use this.');
  return people.caller(ctx.scope);
}

/** `{endpoint?}` of pwa.pushConfig / pwa.pushUnsubscribe: a browser's https push endpoint. */
function pushEndpoint(params: unknown): string | undefined {
  const o = input(params);
  onlyKeys(o, ['endpoint']);
  const endpoint = optText(o, 'endpoint', { max: 2000 });
  if (endpoint !== undefined && !/^https:\/\//.test(endpoint)) bad('endpoint', 'an https push endpoint');
  return endpoint;
}

function topicsOf(params: unknown): Topic[] {
  const value = input(params).topics;
  if (!Array.isArray(value) || value.length > MAX_PERSON_TOPICS || !value.every(isTopic)) bad('topics', `a list of at most ${MAX_PERSON_TOPICS} topics`);
  return value as Topic[];
}

export function registerPersonBase(table: HandlerTable): void {
  table.addPerson('session.info', (_params, ctx) => {
    const person = caller(ctx);
    const allowedMethods = table.methods().filter((method) => {
      const entry = table.get(method);
      return entry !== undefined && allowedScope(entry.scope, ctx.scope) && (method !== 'chats.create' || person.scopes.startChats);
    }) as MethodName[];
    const info: SessionInfo = {
      kind: 'person', capabilities: ['todo', 'chat', 'tasks'], secure: ctx.scope.kind === 'person' && ctx.scope.secure === true, allowedMethods,
      person: { id: person.id, name: person.name, title: person.title, scopes: person.scopes },
    };
    return info;
  });
  table.addPerson('events.subscribe', (params, ctx) => {
    caller(ctx);
    if (ctx.scope.kind !== 'person') return { ok: true };
    for (const topic of topicsOf(params)) if (personMaySubscribe(ctx.services, ctx.scope, topic)) ctx.topics.add(topic);
    return { ok: true };
  });
  table.addPerson('events.unsubscribe', (params, ctx) => {
    for (const topic of topicsOf(params)) ctx.topics.delete(topic);
    return { ok: true };
  });
  table.addPerson('settings.get', (_params, ctx) => personSettings(ctx.services.settings.get(), caller(ctx)));
  table.addPerson('pwa.pushConfig', (params, ctx) => { caller(ctx); return ctx.extras.pwa.pushConfig(ctx.scope, pushEndpoint(params)); });
  table.addPerson('pwa.pushSubscribe', (params, ctx) => {
    caller(ctx);
    const o = input(params);
    onlyKeys(o, ['subscription']);
    const subscription = o.subscription as { endpoint?: unknown } | null | undefined;
    if (!subscription || typeof subscription !== 'object' || typeof subscription.endpoint !== 'string' || !/^https:\/\//.test(subscription.endpoint)) {
      bad('subscription', 'a PushSubscription (JSON) with an https endpoint');
    }
    if (JSON.stringify(subscription).length > 4096) bad('subscription', 'at most 4 KB');
    ctx.extras.pwa.pushSubscribe(subscription, ctx.scope);
    return { ok: true };
  });
  table.addPerson('pwa.pushUnsubscribe', (params, ctx) => { caller(ctx); return { ok: true, removed: ctx.extras.pwa.pushUnsubscribe(ctx.scope, pushEndpoint(params)) }; });
  table.addPerson('ui.state', (_params, ctx) => { caller(ctx); return { drafts: {} }; });
  table.addPerson('system.info', async (_params, ctx) => { caller(ctx); return personSystemInfo(await ctx.extras.system.info()); });
  table.addPerson('agents.list', (params, ctx) => {
    const person = caller(ctx);
    const archived = optBool(input(params), 'includeArchived') ?? false;
    const sees = visibleAgents(ctx.services.db, person); // their spaces' agents, those of their chats, their manager and reports
    return ctx.services.org.list({ includeArchived: archived }).filter((agent) => sees({ ...agent, archivedAt: undefined })).map((agent) => viewAgent(person.id, agent));
  });
  table.addPerson('agents.activity', (_params, ctx) => personActivity(ctx.services, caller(ctx).id, ctx.services.dispatcher.activity()));
  table.addPerson('spaces.list', (_params, ctx) => {
    const person = caller(ctx);
    return ctx.services.org.spaces().filter((space) => maySeeSpace(person, space.id));
  });
  table.addPerson('people.list', (_params, ctx) => {
    const person = caller(ctx);
    return (ctx.services.people?.list() ?? []).filter((entry) => entry.status !== 'revoked').map((entry) => viewPerson(person.id, entry));
  });
  table.addPerson('people.directChat', (params, ctx) => {
    const person = caller(ctx);
    const other = realId(person.id, id(input(params)));
    if (other === person.id) bad('id', 'someone else');
    if (!person.scopes.startChats && !ctx.services.db.get('SELECT 1 FROM members a JOIN members b ON a.conversation_id = b.conversation_id WHERE a.member_id = ? AND b.member_id = ? AND a.left_at IS NULL AND b.left_at IS NULL LIMIT 1', [person.id, other])) {
      throw new WorkforceError('forbidden', 'You may not start chats here. Ask the owner of the organisation.');
    }
    const conversationId = directChat(ctx.services, person.id, other);
    if (ctx.services.chats.get(conversationId)?.archivedAt !== undefined) ctx.services.chats.unarchive(conversationId); // B-050 K1: they could not write in it otherwise
    return { conversationId };
  });
}

/** Agents a person may add to chats and give tasks to (their spaces' active agents). */
export function usableAgent(ctx: HandlerContext, person: Person, agentId: string): boolean {
  return mayUseAgent(person, ctx.services.org.get(agentId));
}

