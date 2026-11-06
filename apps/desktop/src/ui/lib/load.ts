// The snapshot loader behind store.loadAll(): asks the runtime for everything the shell shows
// on a (re)connect, after store.loadAll() has asked session.info (lib/session.ts) what this
// connection may call. Three kinds of snapshot:
//  - base (settings, agents, To-dos, drafts): every paired client may read them, even a
//    To-do-only link; any failure fails the load.
//  - scoped (chats, activity: 'chat'; open tasks: 'tasks'): behind a device capability. Not asked
//    for when `scoped` says the session may not call it (a To-do-only link boots without a single
//    refused call); a refusal anyway (no session answer yet) is an empty list, any other failure
//    still fails the load.
//  - optional (accounts, usage): asked for only when `optional` allows it – can(): accounts.list
//    is owner-only, usage.list needs 'chat' – and settled, never awaited as a whole: a refusal is
//    empty, another failure keeps what is shown.
// So a paired phone boots with its My day list whatever its access tier. The to-dos come with the
// largest page todos.list gives (TODO_LIMIT; the default of 50 silently cut longer lists).
// Chats are loaded with includeHidden (archived ones never come): one list holds the main chats,
// the agent-only "Team activity" rooms and the app-owned system chats, which the views sort with
// shared/text/chat-sections.ts – so team rooms survive a reload and Home links to them.
// Owns: which snapshots exist, their kind, and how a refused, skipped or failed one is treated.
// Never: writes store signals (store.loadAll applies the result), retries, or reaches the
// transport itself – `call` is injected (rpc.call in the app, a fake in unit tests).

import type { MethodName, ParamsOf, ResultOf } from '../../shared/api/methods.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { Account, UsageSummary } from '../../shared/model/providers.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import type { Settings } from '../../shared/model/system.ts';
import type { TaskView } from '../../shared/model/tasks.ts';

/** Same shape as rpc.call. */
export type LoadCall = <M extends MethodName>(method: M, params?: ParamsOf<M>) => Promise<ResultOf<M>>;

/**
 * Snapshots a client asks for only when `LoadOptions.optional` allows it (session.ts can():
 * accounts.list is owner-only; usage.list is device-readable with 'chat').
 */
export type OptionalSnapshot = 'accounts.list' | 'usage.list';

/** Snapshots behind a device capability: skipped or refused → an empty list, not a failed load. */
export const SCOPED_SNAPSHOTS = ['chats.list', 'agents.activity', 'tasks.list'] as const;
export type ScopedSnapshot = typeof SCOPED_SNAPSHOTS[number];

/** The chat snapshot: every section (main, team, system) in one list. */
export const CHAT_LIST = { includeHidden: true } as const;

/** The to-dos asked for: todos.list's largest page (My day's week and the badge need them all). */
export const TODO_LIMIT = 200;

/** Task statuses the shell keeps live (open work). */
export const OPEN_STATUSES: TaskView['status'][] = ['open', 'working', 'waiting', 'needs_you', 'blocked'];

export interface Snapshots {
  settings: Settings;
  /** [] when this device may not read it (refused). */
  chats: ConversationSummary[];
  agents: Agent[];
  /** Archived agents (agents.list leaves them out unless asked): their old chats still show their name and picture. */
  archivedAgents: Agent[];
  /** [] when this device may not read it (refused). */
  activity: AgentActivity[];
  todos: TaskView[];
  /** [] when this device may not read it (refused). */
  tasks: TaskView[];
  drafts: Record<string, string>;
  secretDrafts?: Record<string, string[]>;
  /** [] when not asked for or refused; undefined when it failed otherwise (keep what is shown). */
  accounts: Account[] | undefined;
  usage: UsageSummary[] | undefined;
}

export interface LoadOptions {
  call: LoadCall;
  /** May this client ask for an optional snapshot? (session.ts can(); false → empty, not asked) */
  optional(method: OptionalSnapshot): boolean;
  /**
   * May this client ask for a scoped snapshot? false → empty without a call. Omitted (or true
   * while the session is unknown) → asked, and a refusal is an empty list.
   */
  scoped?(method: ScopedSnapshot): boolean;
}

/** An RPC refusal (RpcError code 'forbidden'), checked by shape so this module stays pure. */
export function isRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'forbidden';
}

function ask<M extends OptionalSnapshot>(options: LoadOptions, method: M): Promise<ResultOf<M>> {
  return options.optional(method) ? options.call(method) : Promise.resolve([] as ResultOf<M>);
}

/** A scoped snapshot: skipped or refused → empty; any other failure rejects (and so fails the load). */
function scoped<M extends ScopedSnapshot>(options: LoadOptions, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
  if (options.scoped?.(method) === false) return Promise.resolve([] as ResultOf<M>);
  return options.call(method, params).catch((error: unknown) => {
    if (isRefusal(error)) return [] as ResultOf<M>;
    throw error;
  });
}

function listOf<T>(result: PromiseSettledResult<T[]>): T[] | undefined {
  if (result.status === 'fulfilled') return result.value;
  return isRefusal(result.reason) ? [] : undefined;
}

/**
 * Loads every snapshot at once. Rejects when a base snapshot fails or a scoped one fails with
 * anything but a refusal (the caller shows the error and keeps its data); optional ones never
 * make it reject.
 */
export async function loadSnapshots(options: LoadOptions): Promise<Snapshots> {
  const { call } = options;
  // Started together with the other calls; allSettled never rejects, so a refusal (or a failed
  // call that ends the load early) leaves no unhandled rejection behind.
  const optional = Promise.allSettled([ask(options, 'accounts.list'), ask(options, 'usage.list')]);
  const [settings, chats, listed, activity, todos, tasks, uiState] = await Promise.all([
    call('settings.get'),
    scoped(options, 'chats.list', CHAT_LIST),
    call('agents.list', { includeArchived: true }),
    scoped(options, 'agents.activity', undefined),
    call('todos.list', { limit: TODO_LIMIT }),
    scoped(options, 'tasks.list', { status: OPEN_STATUSES }),
    call('ui.state'),
  ]);
  const [accounts, usage] = await optional;
  const agents = listed.filter((agent) => agent.archivedAt === undefined);
  const archivedAgents = listed.filter((agent) => agent.archivedAt !== undefined);
  return { settings, chats, agents, archivedAgents, activity, todos, tasks, drafts: uiState.drafts,
    ...(uiState.secretDrafts ? { secretDrafts: uiState.secretDrafts } : {}), accounts: listOf(accounts), usage: listOf(usage) };
}
