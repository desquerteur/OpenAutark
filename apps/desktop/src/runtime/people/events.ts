// Which pushed events reach a person's device (F-52), called by the RPC server (rpc/server.ts forward) for
// every event and connection of scope kind 'person': topics 'chats' (their chats' list rows; a chat they left
// becomes 'conversation.removed', ids only), 'chat:<id>' (messages of a chat they belong to, from their visible
// time on), 'tasks' (tasks they may read) and 'org' (the agents they see as colleagues, the people directory,
// activity of those agents, their spaces) – each payload seen from the person's perspective (perspective.ts).
// Also the rights key of a person's connection
// (personRights): changed rights close it (rpc/server.ts).
// The owner sees everything (nothing here filters the owner's events).
// Owns: the person's topic/event filter, payload projection and rights key. Never: method permissions.

import type { EventName } from '../../shared/api/events.ts';
import type { ClientScope, Topic } from '../../shared/api/protocol.ts';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import type { Agent, Space } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import { chatIdsOf, maySeeSpace, mayReadTask, membership, personUnreadCounts, visibleAgents, visibleFrom } from './access.ts';
import { viewAgent, viewMessage, viewPerson, viewSummary, viewTaskFor } from './perspective.ts';
import type { SplitGroupView } from '../../shared/model/splits.ts';
import type { SplitService } from '../contracts/splits.ts';

type PersonScope = Extract<ClientScope, { kind: 'person' }>;
type Services = Pick<RuntimeServices, 'db' | 'chats'> & Partial<Pick<RuntimeServices, 'people' | 'org' | 'runs' | 'splits'>>;
/** What judging a split's run or live work needs: the chats and (B-057) the split service. */
type ChatsAndSplits = Pick<Services, 'chats' | 'splits'>;
/** An event frame to send instead of the original one. */
export interface Replacement { event: EventName; data: unknown }

const CHAT_EVENTS: ReadonlySet<string> = new Set(['message.created', 'message.updated', 'message.removed', 'notes.updated']); // notes.updated (wave 3): the chat's shared notes moved on – ids and numbers only
const ORG_EVENTS: ReadonlySet<string> = new Set(['agent.upserted', 'agent.removed', 'agent.activity', 'space.upserted', 'person.upserted']);

/**
 * The rights a person's open app was loaded with (their scopes: spaces, starting chats, tasks for agents –
 * session.info's methods, their agents and spaces depend on them). When the owner changes them,
 * rpc/server.ts closes that person's connections so the app reconnects at once and reloads all of it –
 * no waiting for the next connect. Other changes (name, title, manager) reach the app as person.upserted.
 */
export function personRights(person: Pick<Person, 'scopes'> | undefined): string {
  if (!person) return '';
  const { spaces, startChats, assignAgents } = person.scopes;
  return JSON.stringify([spaces === 'all' ? 'all' : [...spaces].sort(), startChats, assignAgents]);
}

/** May a person's device hold a subscription to `topic`? ('chat:<id>' only for a chat they belong to.) */
export function personMaySubscribe(s: Services, scope: PersonScope, topic: Topic): boolean {
  if (topic === 'chats' || topic === 'tasks' || topic === 'org') return true;
  const match = /^chat:(.+)$/.exec(topic);
  return Boolean(match && membership(s.db, scope.personId, match[1]));
}

const personOf = (s: Services, personId: string): Person | undefined => s.people?.repo.get(personId);

/** May a person's device receive `event` (on `topic`)? */
export function personMayReceive(s: Services, scope: PersonScope, topic: Topic, event: EventName, data: unknown): boolean {
  const self = scope.personId;
  if (topic === 'chats') {
    if (event === 'conversation.removed') return true; // ids only
    if (event !== 'conversation.upserted') return false;
    return membership(s.db, self, (data as ConversationSummary).id) !== undefined;
  }
  if (topic.startsWith('chat:')) {
    if (!CHAT_EVENTS.has(event)) return false;
    const conversationId = topic.slice(5);
    const member = membership(s.db, self, conversationId);
    if (!member) return false;
    if (event === 'message.created' || event === 'message.updated') {
      const chat = s.chats.get(conversationId);
      return Boolean(chat) && (data as Message).createdAt >= visibleFrom(chat!, member.joinedAt);
    }
    return true;
  }
  if (topic === 'tasks') {
    if (event === 'task.removed') return true; // ids only
    if (event !== 'task.upserted') return false;
    return mayReadTask(s.db, self, data as TaskView);
  }
  if (topic === 'org') {
    if (!ORG_EVENTS.has(event)) return false;
    if (event !== 'agent.upserted' && event !== 'space.upserted') return true; // ids only, the directory, activity (filtered in personView)
    const person = personOf(s, self);
    if (!person) return false;
    return event === 'space.upserted' ? maySeeSpace(person, (data as Space).id) : visibleAgents(s.db, person)(data as Agent);
  }
  return false;
}

/** A chat a person may no longer see (they left or were removed): its list row becomes 'conversation.removed'. */
export function personRemoval(s: Services, scope: PersonScope, topic: Topic, event: EventName, data: unknown): Replacement | undefined {
  if (topic !== 'chats' || event !== 'conversation.upserted') return undefined;
  const id = (data as ConversationSummary).id;
  if (typeof id !== 'string') return undefined;
  const was = s.db.get('SELECT 1 FROM members WHERE conversation_id = ? AND member_id = ? AND left_at IS NOT NULL', [id, scope.personId]);
  if (!was) return undefined;
  return { event: 'conversation.removed', data: { id } };
}

/** The payload a person's device receives for an event it may see. */
export function personView(s: Services, scope: PersonScope, event: EventName, data: unknown): unknown {
  const self = scope.personId;
  switch (event) {
    case 'message.created':
    case 'message.updated':
      return viewMessage(self, data as Message, (id) => s.people?.nameOf(id) ?? s.org?.get(id)?.name);
    case 'conversation.upserted': {
      const summary = data as ConversationSummary;
      const member = membership(s.db, self, summary.id);
      const from = member ? visibleFrom(summary, member.joinedAt) : 0;
      return viewSummary(self, summary, { ...(member ? personUnreadCounts(s.db, self, summary.id, member.readSeq, from) : { unread: 0 }), from });
    }
    case 'task.upserted':
      return viewTaskFor(s, self, data as TaskView); // B-050 K2: its chat as the person sees it
    case 'agent.upserted':
      return viewAgent(self, data as Agent);
    case 'person.upserted':
      return viewPerson(self, data as Person);
    case 'agent.activity':
      return { active: personActivity(s, self, (data as { active?: AgentActivity[] }).active ?? []) };
    default:
      return data;
  }
}

/**
 * Agents' live work as a person sees it: only agents they see as colleagues; in their chats with the
 * status line, elsewhere only "working" (no chat, task or note). B-057: a split's live work only in their
 * chats (elsewhere it would read as one more turn of the agent).
 */
export function personActivity(s: Services, self: string, active: readonly AgentActivity[]): AgentActivity[] {
  const person = personOf(s, self);
  if (!person) return [];
  const chats = chatIdsOf(s.db, self);
  const sees = visibleAgents(s.db, person);
  return active.filter((entry) => sees(s.org?.get(entry.agentId))).flatMap((entry) => {
    const chat = activityChat(s, entry);
    if (chat && chats.has(chat)) return [{ ...entry }];
    return entry.split ? [] : [{ agentId: entry.agentId, runId: entry.runId, note: '', startedAt: entry.startedAt }];
  });
}

/** B-057: where a split worked – its group's parent run and that turn's chat and task (set when the group was made). */
export interface SplitPlace { parentRunId: string; conversationId?: string; taskId?: string }
const PLACES_MAX = 2_000;
/** Places per split service (they never change, and run items stream – one splits.get per split, not per event). */
const places = new WeakMap<SplitService, Map<string, SplitPlace>>();

/** Where split `splitId` worked; undefined when it is unknown or no split service runs (callers then hide it). */
export function splitPlace(s: Pick<Services, 'splits'>, splitId: string): SplitPlace | undefined {
  const service = s.splits;
  if (!service) return undefined;
  let known = places.get(service);
  if (!known) { known = new Map(); places.set(service, known); }
  const cached = known.get(splitId);
  if (cached) return cached;
  let group: SplitGroupView | undefined;
  try { group = service.get(splitId)?.group; } catch { group = undefined; }
  if (!group) return undefined;
  const place: SplitPlace = { parentRunId: group.parentRunId, ...(group.conversationId ? { conversationId: group.conversationId } : {}), ...(group.taskId ? { taskId: group.taskId } : {}) };
  if (known.size >= PLACES_MAX) known.delete(known.keys().next().value as string);
  known.set(splitId, place);
  return place;
}

/** The chat a split's group was split in (undefined: none; null: the split is unknown). */
function splitChat(s: ChatsAndSplits, splitId: string): string | undefined | null {
  const place = splitPlace(s, splitId);
  return place ? place.conversationId : null;
}

/** The chat a live entry works in – a split's entry carries its group's chat, else it is looked up (null: unknown). */
function activityChat(s: ChatsAndSplits, entry: AgentActivity): string | undefined | null {
  return entry.conversationId || !entry.split ? entry.conversationId : splitChat(s, entry.split.id);
}

/** The owner's own to-do (assigned to the human without a person id): the owner always sees it. */
export function ownersOwnTodo(task: Pick<TaskView, 'assigneeKind' | 'assigneeId'>): boolean {
  return task.assigneeKind === 'human' && (task.assigneeId === undefined || task.assigneeId === 'human');
}
