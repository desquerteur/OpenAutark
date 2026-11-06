// Client state as signals: snapshots loaded once per connection, then kept fresh by event
// deltas (store-events.ts). Every view reads from here; nothing keeps a second copy.
// Owns: the data signals, loaders and small upsert helpers.
// Never: renders, or polls – freshness comes from events and reconnect reloads only.

import { batch, computed, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { Agent } from '../../shared/model/org.ts';
import type { ConversationSummary, Message } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { Account, ModelInfo, UsageSummary } from '../../shared/model/providers.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Preferences, Settings, SettingsPatch, SystemInfo, UpdateState } from '../../shared/model/system.ts';
import { rpc, RpcError } from './rpc.ts';
import { route } from './router.ts';
import { isMobile } from './platform.ts';
import { loadSnapshots } from './load.ts';
import { can, loadSession, session } from './session.ts';
import { countNow, isLater } from '../../shared/model/todo-later.ts';
import { loadPeople, personName } from './people.ts';
import { loadDay } from './day-store.ts';
import { selfIdentity } from './self-identity.ts';

export { route, isMobile };

export const conversations = signal<ConversationSummary[]>([]);
export const activeConversationId = computed<string | null>(() => (route.value.view === 'chat' ? route.value.id : null));
/** Per-conversation message lists (loaded on demand, newest last). */
export const messages = new Map<string, Signal<Message[]>>();
/** Conversations whose oldest message is loaded (no more "load older"). */
export const historyComplete = new Set<string>();
/**
 * Per chat: the oldest seq a loaded page held (C6). The loaded pages run without a gap from there
 * to the newest message, so a row at or above it never moves the paging cursor (list[0].seq) past
 * unloaded rows – the tombstone of a deleted oldest loaded message takes that message's place.
 */
const pageFloor = new Map<string, number>();
export const agents = signal<Agent[]>([]);
/** Archived agents, kept only so their old chats (the default 1:1 above all) show a name and a picture – never as someone to work with. */
export const archivedAgents = signal<Agent[]>([]);
export const tasks = signal<TaskView[]>([]);
export const todos = signal<TaskView[]>([]);
export const settings = signal<Settings | null>(null);
export const accounts = signal<Account[]>([]);
export const usage = signal<UsageSummary[]>([]);
export const activity = signal<AgentActivity[]>([]);
export const models = signal<ModelInfo[]>([]);
export const updateState = signal<UpdateState | null>(null);
export const systemInfo = signal<SystemInfo | null>(null);
export const drafts = signal<Record<string, string>>({});
export const secretDrafts = signal<Record<string, string[]>>({});
export const loaded = signal(false);
export const loadError = signal<string | null>(null);

export const agentMap = computed(() => new Map(agents.value.map((agent) => [agent.id, agent])));
/** agentMap plus the archived agents: for the name and picture of a member in a chat (not for choosing whom to work with). */
export const knownAgentMap = computed(() => new Map([...archivedAgents.value, ...agents.value].map((agent) => [agent.id, agent])));
export const conversationMap = computed(() => new Map(conversations.value.map((chat) => [chat.id, chat])));
export const activeConversation = computed(() => {
  const id = activeConversationId.value;
  return id ? conversationMap.value.get(id) ?? null : null;
});
/**
 * The My day list's clock (F04): the time its "Later" split and countdowns are read at. Moved by
 * store-events.ts when the to-dos change and at the next moment a row reads differently by time
 * alone (tasks/todo-time.ts nextListChange) – one timeout to that moment, never polling.
 */
export const todoClock = signal(Date.now());
/**
 * For-you badge (rail and phone tabs: My day): what needs the person now
 * (shared/model/todo-later.ts needsYou – My day's Needs-you group without the running block), never "Later".
 */
export const forYouCount = computed(() => countNow(todos.value, todoClock.value));
/** The to-dos due now: `todos` without its "Later" part (F04), for views that list them without the Later toggle. */
export const todosNow = computed(() => todos.value.filter((task) => !isLater(task, todoClock.value)));

// ------------------------------------------------------------------ helpers

export function upsertById<T extends { id: string }>(list: Signal<T[]>, item: T): void {
  const index = list.value.findIndex((entry) => entry.id === item.id);
  if (index === -1) list.value = [...list.value, item];
  else {
    const next = list.value.slice();
    next[index] = item;
    list.value = next;
  }
}

export function removeById<T extends { id: string }>(list: Signal<T[]>, id: string): void {
  if (list.value.some((entry) => entry.id === id)) list.value = list.value.filter((entry) => entry.id !== id);
}

export function messagesFor(conversationId: string): Signal<Message[]> {
  let list = messages.get(conversationId);
  if (!list) {
    list = signal<Message[]>([]);
    messages.set(conversationId, list);
  }
  return list;
}

/**
 * Inserts or replaces a message keeping seq order. D4/D5: a known message may come back with a new
 * seq (a run's answer moves to the end of the chat when it is finished): it is re-sorted, not kept in its old place.
 */
export function putMessage(message: Message): void {
  const list = messages.get(message.conversationId);
  if (!list) return; // not loaded – the chat loads a fresh page when opened
  const current = list.value;
  const index = current.findIndex((entry) => entry.id === message.id);
  if (index !== -1) {
    const next = current.slice();
    const moved = current[index].seq !== message.seq;
    next[index] = message;
    if (moved) next.sort((a, b) => a.seq - b.seq);
    list.value = next;
    return;
  }
  // C6: an unknown row below the loaded pages' floor (a tombstone or an edit of an unloaded message) waits for loadOlder – inserted now it would move the paging cursor (list[0].seq) past the rows between.
  const floor = pageFloor.get(message.conversationId) ?? current[0]?.seq;
  if (floor !== undefined && message.seq < floor && !historyComplete.has(message.conversationId)) return;
  const next = [...current, message];
  if (current.length && current[current.length - 1].seq > message.seq) next.sort((a, b) => a.seq - b.seq);
  list.value = next;
}

export function agentName(id: string): string {
  if (id === 'human') return selfIdentity(settings.value?.profile).name; // the caller, as the profile button names it
  return knownAgentMap.value.get(id)?.name ?? personName(id) ?? 'Former member'; // F-52: people of the organisation (lib/people.ts)
}

// ------------------------------------------------------------------ loaders

const PAGE = 60;

const fetching = new Map<string, Promise<ConversationSummary | undefined>>();

/**
 * A chat by id – also one chats.list leaves out (agent-only rooms, the To-do chat). Unknown
 * ids are fetched once (chats.get, deduplicated) and kept in `conversations`, where events
 * keep them fresh like any other chat. Undefined when the chat does not exist (any more) or
 * may not be opened here; other failures (connection lost) reject, so callers can retry.
 */
export function ensureConversation(id: string): Promise<ConversationSummary | undefined> {
  const known = conversationMap.value.get(id);
  if (known) return Promise.resolve(known);
  let request = fetching.get(id);
  if (!request) {
    request = rpc.call('chats.get', { id })
      .then((chat) => { upsertById(conversations, chat); return chat; }, (error: unknown) => {
        if (error instanceof RpcError && (error.code === 'not_found' || error.code === 'forbidden' || error.code === 'bad_request')) return undefined;
        throw error;
      })
      .finally(() => { fetching.delete(id); });
    fetching.set(id, request);
  }
  return request;
}

/**
 * The fresh chat list plus the open chat when the list leaves it out (opened on demand), so a
 * reconnect does not unmount an open hidden chat. Its summary is refreshed in the background
 * and dropped when it no longer exists.
 */
function keepOpenChat(list: ConversationSummary[]): ConversationSummary[] {
  const open = activeConversationId.value;
  const held = open && !list.some((chat) => chat.id === open) ? conversationMap.value.get(open) : undefined;
  if (!held) return list;
  rpc.call('chats.get', { id: held.id }).then((chat) => upsertById(conversations, chat), (error: unknown) => {
    if (error instanceof RpcError && (error.code === 'not_found' || error.code === 'forbidden')) removeById(conversations, held.id);
  });
  return [...list, held];
}

export async function loadMessages(conversationId: string): Promise<void> {
  const page = await rpc.call('messages.list', { conversationId, limit: PAGE });
  const sorted = page.slice().sort((a, b) => a.seq - b.seq);
  messagesFor(conversationId).value = sorted;
  if (sorted.length) pageFloor.set(conversationId, sorted[0].seq);
  else pageFloor.delete(conversationId);
  if (page.length < PAGE) historyComplete.add(conversationId);
  else historyComplete.delete(conversationId);
}

/** Loads one older page; returns how many messages were added. */
export async function loadOlder(conversationId: string): Promise<number> {
  if (historyComplete.has(conversationId)) return 0;
  const list = messagesFor(conversationId);
  const oldest = list.value[0];
  if (!oldest) return 0;
  const page = await rpc.call('messages.list', { conversationId, beforeSeq: oldest.seq, limit: PAGE });
  if (page.length < PAGE) historyComplete.add(conversationId);
  if (page.length) pageFloor.set(conversationId, Math.min(pageFloor.get(conversationId) ?? oldest.seq, ...page.map((message) => message.seq)));
  const known = new Set(list.value.map((message) => message.id));
  const fresh = page.filter((message) => !known.has(message.id)).sort((a, b) => a.seq - b.seq);
  if (fresh.length) list.value = [...fresh, ...list.value];
  return fresh.length;
}

export async function loadModels(refresh = false): Promise<ModelInfo[]> {
  const list = await rpc.call('models.list', refresh ? { refresh: true } : undefined);
  models.value = list;
  return list;
}

/**
 * Loads every snapshot the shell needs (lib/load.ts) and applies them in one batch. Called on
 * first connect and after reconnects. First asks session.info what this connection may call
 * (lib/session.ts); snapshots it may not read are not asked for (optional ones: only when
 * can(); scoped ones: skipped when the session says no, tried while it is unknown). A refused
 * snapshot never sets loadError or blocks `loaded` – it is empty.
 */
export async function loadAll(): Promise<void> {
  try {
    await loadSession(rpc.call);
    void loadPeople(); // F-52: people of the organisation (only when this connection may read them)
    const snapshot = await loadSnapshots({ call: rpc.call, optional: can, scoped: (method) => session.peek() === null || can(method) });
    batch(() => {
      settings.value = snapshot.settings;
      conversations.value = keepOpenChat(snapshot.chats);
      agents.value = snapshot.agents;
      archivedAgents.value = snapshot.archivedAgents;
      activity.value = snapshot.activity;
      todos.value = snapshot.todos;
      tasks.value = snapshot.tasks;
      if (snapshot.accounts) accounts.value = snapshot.accounts;
      if (snapshot.usage) usage.value = snapshot.usage;
      drafts.value = { ...snapshot.drafts, ...drafts.value };
      secretDrafts.value = { ...snapshot.secretDrafts, ...secretDrafts.value };
      loadError.value = null;
      loaded.value = true;
    });
    // B-041: My day's calendar, briefing and handed-off work (lib/day-store.ts; only what this connection may read).
    void loadDay(undefined, { tz: snapshot.settings.profile?.timezone });
    // Refresh the open chat (events may have been missed while disconnected).
    const open = activeConversationId.value;
    if (open && messages.has(open)) void loadMessages(open).catch(() => undefined);
    void rpc.call('system.info').then((info) => { systemInfo.value = info; }).catch(() => undefined);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Could not load data.';
  }
}

// ------------------------------------------------------------------ settings helpers

/** Optimistic settings change (local first, then persisted; reverts on error). */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  const before = settings.value;
  if (before) {
    const next = { ...before } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      next[key] = { ...(before as unknown as Record<string, object>)[key], ...(value as object) };
    }
    settings.value = next as unknown as Settings;
  }
  try {
    settings.value = await rpc.call('settings.update', patch);
  } catch (error) {
    settings.value = before;
    throw error;
  }
}

export function updatePreferences(patch: Partial<Preferences>): Promise<void> {
  return updateSettings({ preferences: patch });
}

export const preferences = computed<Preferences>(() => settings.value?.preferences ?? {
  theme: 'system', sidebarOpen: true, sidebarWidth: 288,
  workspaceOpen: false, workspaceWidth: 360, enterSends: true, closeToTray: true, openAtLogin: false, autoDownloadUpdates: false,
});
