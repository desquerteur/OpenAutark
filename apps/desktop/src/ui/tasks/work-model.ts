// Pure rules of Work (#/tasks, B-078 D10) and the owner rules every task surface shares (moved out of
// tasks/model.ts, which re-exports all of it). Work shows two things, told apart by shape (owner 06.11.: "nicht von
// irgendwelchen Texten … sondern Formen und Farben"):
//   For you – the agents' work that needs the person now (waits on them, or an open human step asks them): forYou;
//   the report – a quiet prose block of the team's side work and facts (tasks.complete alsoHandled) and of work
//   nobody asked for, from the last REPORT_DAYS days, deduplicated, newest first, at most REPORT_MAX lines: report.
// Everything else the agents handle on their own; one agent's open work shows as slim rows when the sidebar's
// "People & agents" narrows Work to it (#/tasks?owner=, ownerWork). Also: the viewer's scope (a person's device
// keeps its own to-dos), stuckOf (the team view's stuck rule), the next moment the report changes by time alone,
// and the Work routes a click leads to.
// Owns: these rules (unit-tested in test/unit/work/*). Never: imports the store, rpc or the DOM, or reads a clock –
// callers pass data and the time in.

import type { Task, TaskStatus, TaskView } from '../../shared/model/tasks.ts';
import { isPaused } from '../../shared/model/task-pause.ts';
import { isHumanActor } from '../../shared/model/people.ts';
import { onForYouList } from '../../shared/model/todo-later.ts';
import { DAY_MS } from './todo-model.ts';

export function isFinished(status: TaskStatus): boolean { return status === 'done' || status === 'cancelled'; }

// ------------------------------------------------------------------ order and windows

type Sortable = Pick<Task, 'priority' | 'dueAt' | 'sort' | 'createdAt'>;

/** Board order (same as the runtime): priority ↓, due ↑ (none last), manual sort, age. */
export function compareTasks(a: Sortable, b: Sortable): number {
  return b.priority - a.priority
    || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)
    || a.sort - b.sort
    || a.createdAt - b.createdAt;
}

export function finishedAt(task: Pick<Task, 'completedAt' | 'updatedAt'>): number { return task.completedAt ?? task.updatedAt; }

/** Newest finished first. */
export function compareDone(a: Pick<Task, 'completedAt' | 'updatedAt'>, b: Pick<Task, 'completedAt' | 'updatedAt'>): number {
  return finishedAt(b) - finishedAt(a);
}

/** Top-level finished tasks inside the last `days` days, newest first. */
export function recentDone<T extends Task>(list: T[], now: number, days = 3, statuses: readonly TaskStatus[] = ['done']): T[] {
  const since = now - days * DAY_MS;
  return list.filter((task) => !task.parentId && statuses.includes(task.status) && finishedAt(task) >= since).sort(compareDone);
}

/** Case-insensitive search over title, notes and chat name. */
export function searchTasks<T extends TaskView>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((task) => task.title.toLowerCase().includes(q) || task.notes.toLowerCase().includes(q) || task.conversationTitle.toLowerCase().includes(q));
}

const WORK_RANK: Record<TaskStatus, number> = { working: 0, waiting: 1, blocked: 2, needs_you: 3, open: 4, done: 5, cancelled: 6 };

/** Work order: running turns first, then by status, then board order. */
export function compareWork(a: TaskView, b: TaskView): number {
  return Number(b.running) - Number(a.running) || WORK_RANK[a.status] - WORK_RANK[b.status] || compareTasks(a, b);
}

// ------------------------------------------------------------------ owners

/** F-52: 'person' – another human of the organisation (on a person's device the CEO is the person 'owner'). */
export type Owner = { kind: 'team' } | { kind: 'agent'; id: string } | { kind: 'human' } | { kind: 'person'; id: string };

export function ownerOf(task: Pick<Task, 'assigneeKind' | 'assigneeId'>): Owner {
  if (task.assigneeKind === 'human') return task.assigneeId && task.assigneeId !== 'human' ? { kind: 'person', id: task.assigneeId } : { kind: 'human' };
  if (task.assigneeKind === 'agent' && task.assigneeId) return { kind: 'agent', id: task.assigneeId };
  return { kind: 'team' };
}

/** The owner filter of Work and the agent page (#/tasks?owner=, O5): 'team' (no owner), an agent or person id, or anyone (undefined). */
export function ownedBy(task: Pick<Task, 'assigneeKind' | 'assigneeId'>, owner: string | undefined): boolean {
  return !owner || (owner === 'team' ? task.assigneeKind === 'team' : task.assigneeId === owner);
}

/** The removable chip of #/tasks?owner=: 'Unassigned' (the sidebar's word for no owner) or the agent's or person's name. */
export const ownerChipLabel = (owner: string, nameOf: (id: string) => string): string => (owner === 'team' ? 'Unassigned' : nameOf(owner));

/** No owner yet: team work the decision model or a lead still has to place. */
export function hasNoOwner(task: Pick<Task, 'parentId' | 'assigneeKind' | 'status'>): boolean {
  return !task.parentId && task.assigneeKind === 'team' && !isFinished(task.status);
}

// ------------------------------------------------------------------ what Work lists

/** `keepOwn`: also list the viewer's own to-dos – a person's device does (colleagues' My day comes later, B-041 §7). */
export interface WorkScope { keepOwn?: boolean }

type Listed = Pick<Task, 'parentId' | 'assigneeKind' | 'assigneeId' | 'status' | 'waitingOn'>;

/** On Work: top-level, and not one of the viewer's own to-dos – on their list when open (onForYouList), any finished one. */
export function onWork(task: Listed, scope: WorkScope = {}): boolean {
  if (task.parentId) return false;
  if (scope.keepOwn) return true;
  return isFinished(task.status) ? ownerOf(task).kind !== 'human' : !onForYouList(task);
}

/** Open work Work lists (everyone's – agents', colleagues', unassigned – but the viewer's own to-dos). */
export function isOpenWork(task: Listed, scope: WorkScope = {}): boolean { return !isFinished(task.status) && onWork(task, scope); }

// ------------------------------------------------------------------ For you

type Asking = Listed & Pick<TaskView, 'steps'>;

/** An open human step with a widget: the owner's question to the person (a mini-app step stays on My day). */
function asksThePerson(task: Pick<TaskView, 'steps'>): boolean {
  return (task.steps ?? []).some((step) => step.assigneeKind === 'human' && !isFinished(step.status) && Boolean(step.widget) && String(step.widget?.type) !== 'app');
}

/** Agent work that needs the person now: it waits on them (never their own pause) or one of its steps asks them. */
export function needsThePerson(task: Asking): boolean {
  if (isFinished(task.status) || isPaused(task) || ownerOf(task).kind === 'human') return false;
  return task.status === 'needs_you' || task.waitingOn?.kind === 'human' || asksThePerson(task);
}

/** The For-you cards: the open work that needs the person, the most urgent first, narrowed to the search. */
export function forYou<T extends TaskView>(open: readonly T[], query = '', scope: WorkScope = {}): T[] {
  return searchTasks(open.filter((task) => isOpenWork(task, scope) && needsThePerson(task)), query).sort(compareTasks);
}

/** One owner's open work as slim rows (the sidebar's People & agents), running first. */
export function ownerWork<T extends TaskView>(open: readonly T[], owner: string, query = '', scope: WorkScope = {}): T[] {
  return searchTasks(open.filter((task) => isOpenWork(task, scope) && ownedBy(task, owner)), query).sort(compareWork);
}

/** Open work that matches a search, as slim rows (the search finds every open task, not only For you). */
export function matchingWork<T extends TaskView>(open: readonly T[], query: string, scope: WorkScope = {}): T[] {
  return query.trim() ? searchTasks(open.filter((task) => isOpenWork(task, scope) && !needsThePerson(task)), query).sort(compareWork) : [];
}

// ------------------------------------------------------------------ the report

/** The report covers this many days. */
export const REPORT_DAYS = 3;
/** At most this many lines. */
export const REPORT_MAX = 8;
/** Kept for callers that load finished work: the report's window. */
export const DONE_DAYS = REPORT_DAYS;

export interface ReportLine<T> { key: string; text: string; at: number; task: T }

type Reported = Pick<TaskView, 'id' | 'parentId' | 'status' | 'completedAt' | 'updatedAt' | 'createdBy' | 'result' | 'title' | 'assigneeKind' | 'assigneeId' | 'waitingOn' | 'conversationId' | 'origin'>;

/** Sources no person starts: a schedule, a connected app, task news (shared/model/origin.ts). */
const UNASKED_SOURCE = /^(schedule:|app:|news$)/;

/**
 * Work nobody asked for: an agent or the app made it, outside any chat (a chat task is the answer to someone there),
 * from a schedule, an app or task news. An agent's task for a person's request in a chat is no report line.
 */
export function unaskedWork(task: Pick<Task, 'createdBy' | 'conversationId' | 'origin'>): boolean {
  return !isHumanActor(task.createdBy) && !task.conversationId && UNASKED_SOURCE.test(task.origin?.source ?? '');
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/**
 * The report: per finished task (done, top-level, on Work, the last `days` days, newest first) its alsoHandled
 * lines – the team's side work and facts – and, for work nobody asked for (unaskedWork: a schedule, an app or task
 * news started it, no person), its result in one line. Deduplicated by text, at most `max` lines.
 */
export function report<T extends Reported>(done: readonly T[], now: number, options: { days?: number; max?: number; scope?: WorkScope; query?: string } = {}): Array<ReportLine<T>> {
  const since = now - (options.days ?? REPORT_DAYS) * DAY_MS;
  const max = options.max ?? REPORT_MAX;
  const q = options.query?.trim().toLowerCase() ?? '';
  const seen = new Set<string>();
  const out: Array<ReportLine<T>> = [];
  const finished = done.filter((task) => task.status === 'done' && !task.parentId && finishedAt(task) >= since && onWork(task, options.scope))
    .sort(compareDone);
  for (const task of finished) {
    const lines = (task.result?.alsoHandled ?? []).map((line) => oneLine(line, 220)).filter(Boolean);
    if (unaskedWork(task) && task.result?.summary?.trim()) lines.push(oneLine(`${task.title}: ${task.result!.summary}`, 220));
    lines.forEach((text, index) => {
      const folded = text.toLowerCase();
      if (out.length >= max || seen.has(folded) || (q && !folded.includes(q) && !task.title.toLowerCase().includes(q))) return;
      seen.add(folded);
      out.push({ key: `${task.id}:${index}`, text, at: finishedAt(task), task });
    });
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------ the team view's stuck rule

/** A wait longer than this is stuck (T06). */
export const STUCK_WAIT_MS = 2 * DAY_MS;

type StuckTask = Pick<Task, 'parentId' | 'assigneeKind' | 'status' | 'waitingOn' | 'ledger' | 'createdAt' | 'updatedAt' | 'startedAt'>;
export interface Stuck { why: string; since: number }

/** A wait for a known time that is still ahead (a reminder, a snooze) is planned, not stuck. */
const timedWaitAhead = (wait: NonNullable<Task['waitingOn']>, now: number): boolean => wait.kind === 'schedule' && wait.until !== undefined && wait.until > now;

/**
 * Why unfinished work is stuck, and since when (null: it is not) – the team view's activity rule. An escalation
 * counts from the last progress (else the start), never from `updatedAt`, which every retry's ledger save moves.
 */
export function stuckOf(task: StuckTask, now: number): Stuck | null {
  if (isFinished(task.status)) return null;
  const wait = task.waitingOn;
  if (task.status === 'blocked') return { why: wait?.reason || 'Blocked', since: wait?.since ?? task.updatedAt };
  if (isPaused(task)) return { why: 'Paused by you', since: wait!.since };
  if (hasNoOwner(task)) return { why: 'No owner yet', since: task.createdAt };
  const stalled = task.ledger?.lastProgressAt ?? task.startedAt ?? task.createdAt;
  const level = task.ledger?.escalation;
  if (level === 'human') return { why: 'Needs your decision', since: (task.status === 'needs_you' && wait?.since) || stalled };
  if (level === 'manager') return { why: 'Escalated to the manager', since: stalled };
  if ((task.status === 'waiting' || task.status === 'needs_you') && wait && now - wait.since > STUCK_WAIT_MS && !timedWaitAhead(wait, now)) {
    return { why: wait.reason || (wait.kind === 'human' ? 'Waiting on you' : 'Waiting'), since: wait.since };
  }
  if (level === 'other_approach' || level === 'stronger_model') return { why: `No progress in ${task.ledger.stalls ?? 2} tries`, since: stalled };
  return null;
}

// ------------------------------------------------------------------ People & agents

export interface WorkOwner { id: string; kind: 'agent' | 'person'; count: number }

/** "People & agents": every agent and person with open work, most first (then by name), and how much work has no owner. */
export function workOwners(open: TaskView[], nameOf: (id: string) => string, scope: WorkScope = {}): { owners: WorkOwner[]; unassigned: number } {
  const byId = new Map<string, WorkOwner>();
  let unassigned = 0;
  for (const task of open) {
    if (!isOpenWork(task, scope)) continue;
    const owner = ownerOf(task);
    if (owner.kind === 'team') unassigned++;
    if (owner.kind !== 'agent' && owner.kind !== 'person') continue;
    const entry = byId.get(owner.id);
    if (entry) entry.count++; else byId.set(owner.id, { id: owner.id, kind: owner.kind, count: 1 });
  }
  const owners = [...byId.values()].sort((a, b) => b.count - a.count || nameOf(a.id).localeCompare(nameOf(b.id)));
  return { owners, unassigned };
}

// ------------------------------------------------------------------ the clock

/** The next moment after `now` the report changes by time alone (a finished task leaving its window); none: undefined. */
export function nextWorkChange(_open: readonly TaskView[], done: readonly TaskView[], now: number): number | undefined {
  let next: number | undefined;
  for (const task of done) {
    if (task.parentId) continue;
    const at = finishedAt(task) + REPORT_DAYS * DAY_MS + 1;
    if (at > now && (next === undefined || at < next)) next = at;
  }
  return next;
}

// ------------------------------------------------------------------ routes

export interface WorkRoute { view: 'tasks'; filter?: string; owner?: string; task?: string }

/** Where a Work click leads: Work, narrowed to `owner` or not, never a selected task (older #/tasks/<filter> links open the plain view). */
export function workRoute(owner?: string): WorkRoute {
  return { view: 'tasks', ...(owner ? { owner } : {}) };
}

/** The same Work route with `task` selected – or none (the detail closed). */
export function withTask(route: WorkRoute, task?: string): WorkRoute {
  const { task: _old, ...rest } = route;
  return task ? { ...rest, task } : rest;
}
