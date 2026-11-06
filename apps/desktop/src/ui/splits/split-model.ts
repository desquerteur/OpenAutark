// The split groups this window knows (B-057 S18): one signal of groups by id, filled by splits.list reads of the views
// that show splits (the team sidebar, a parent run's step line, Team › agent › Runs, a split's page, a chat's live
// blocks) and kept current by 'split.upserted' (topic runs:<agentId>, where this connection holds it) and – for every
// connection, chat-only phones too – by the live activity: when an agent's split runs start or end (not with each
// step), its newest groups are read again (one call per agent, coalesced). A reconnect reads every watched query again.
// Queries in flight are shared; the map keeps the newest MAX_GROUPS groups.
// The split rows name models from the catalog; ensureModelNames reads it once where nothing loaded it yet.
// Owns: the groups signal, the reads and their refresh rules, and the store-reading selectors.
// Never: polls, or shows a group this connection may not open (the runtime leaves those out of splits.list).

import { effect, signal } from '@preact/signals';
import '../../shared/api/methods-splits.ts'; // the splits.* method shapes (module augmentation)
import type { SplitGroupView, SplitView } from '../../shared/model/splits.ts';
import { rpc } from '../lib/rpc.ts';
import { activity, loadModels, models } from '../lib/store.ts';
import { changedAgents, chatGroups, runGroups, sidebarGroups, splitRunKeys } from './split-text.ts';

export interface SplitQuery { agentId?: string; parentRunId?: string; groupId?: string; conversationId?: string; active?: boolean; limit?: number }

/** Groups by id (newest MAX_GROUPS). */
export const splitGroups = signal<ReadonlyMap<string, SplitGroupView>>(new Map());
const MAX_GROUPS = 120;
/** Groups an agent's refresh reads (its newest). */
const AGENT_LIMIT = 12;
/** Split runs of one agent starting or ending together are read once. */
const COALESCE_MS = 250;

function keep(map: Map<string, SplitGroupView>): Map<string, SplitGroupView> {
  if (map.size <= MAX_GROUPS) return map;
  const newest = [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_GROUPS);
  return new Map(newest.map((group) => [group.id, group]));
}

/** A group from an event or a read: replaces the one known. */
export function applyGroup(group: SplitGroupView): void {
  applyGroups([group]);
}

export function applyGroups(list: readonly SplitGroupView[]): void {
  if (!list.length) return;
  const next = new Map(splitGroups.peek());
  for (const group of list) next.set(group.id, group);
  splitGroups.value = keep(next);
}

const inflight = new Map<string, Promise<SplitGroupView[]>>();

/** Reads groups (shared while the same query is in flight); [] on an error. */
export function loadSplits(query: SplitQuery): Promise<SplitGroupView[]> {
  const key = JSON.stringify(query);
  const running = inflight.get(key);
  if (running) return running;
  const call = rpc.call('splits.list', query)
    .then((list) => { applyGroups(list); return list; })
    .catch(() => [] as SplitGroupView[])
    .finally(() => { inflight.delete(key); });
  inflight.set(key, call);
  return call;
}

const watched = new Map<string, { query: SplitQuery; holders: number }>();

/** Reads `query` now and again after every reconnect while held; the returned release ends that. */
export function watchSplits(query: SplitQuery): () => void {
  const key = JSON.stringify(query);
  const entry = watched.get(key);
  if (entry) entry.holders++; else watched.set(key, { query, holders: 1 });
  void loadSplits(query);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = watched.get(key);
    if (!current) return;
    if (current.holders > 1) current.holders--; else watched.delete(key);
  };
}

let modelsLoading: Promise<unknown> | null = null;

/** The catalog's model names for the model · effort slots (lib/model-name.ts; the catalog loads lazily elsewhere): read once
 *  when nothing is loaded yet – every split row then names a model the same way. */
export function ensureModelNames(): void {
  if (modelsLoading || models.peek().length) return;
  modelsLoading = loadModels().catch(() => undefined).finally(() => { modelsLoading = null; });
}

/** One split with its group from the known groups. */
export function findSplit(splitId: string): { split: SplitView; group: SplitGroupView } | undefined {
  for (const group of splitGroups.value.values()) {
    const split = group.splits.find((entry) => entry.id === splitId);
    if (split) return { split, group };
  }
  return undefined;
}

/** The groups under an agent in the team sidebar (active and recently finished). */
export function agentGroups(agentId: string): SplitGroupView[] {
  return sidebarGroups(splitGroups.value.values(), agentId);
}

/** The groups a parent run made, in order. */
export function groupsOfRun(parentRunId: string): SplitGroupView[] {
  return runGroups(splitGroups.value.values(), parentRunId);
}

/** The running groups of a chat (one live block each), in start order. */
export function liveGroupsOf(conversationId: string): SplitGroupView[] {
  return chatGroups(splitGroups.value.values(), conversationId, activity.value);
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function refreshAgent(agentId: string): void {
  if (timers.has(agentId)) return;
  timers.set(agentId, setTimeout(() => {
    timers.delete(agentId);
    void loadSplits({ agentId, limit: AGENT_LIMIT });
  }, COALESCE_MS));
}

let wired = false;

/** Events, reconnects and the activity rule (called once from lib/store-events.ts). */
export function wireSplits(): void {
  if (wired) return;
  wired = true;
  rpc.on('split.upserted', applyGroup);
  rpc.onOpen(() => { for (const { query } of watched.values()) void loadSplits(query); });
  let last = new Map<string, string>();
  effect(() => {
    const next = splitRunKeys(activity.value);
    const changed = changedAgents(last, next);
    last = next;
    for (const agentId of changed) refreshAgent(agentId);
  });
}
