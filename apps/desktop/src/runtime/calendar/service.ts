// CalendarService (B-041 track A1, contract §4): the members' local calendar – events and the time blocks of tasks,
// slot clicks (calendar.add, runtime/calendar/add.ts), moves (rev-checked; the person's pin: setBy 'person', an agent's
// own move – tools/builtin/calendar-change.ts – stays setBy 'agent', rules.ts setByOf), the
// planner's and agents' blocks (upsertBlock: one block per task, never moving a person-set block, never over a timed
// event or a person-set block), removal, the busy spans the planner plans around, the window with the agents' runs
// (calendar/agent-runs.ts), the zone and the sources not synced for > 24 h, and check-off ↔ block (a bus listener,
// calendar/task-link.ts). Every change is sent as 'calendar.upserted' / 'calendar.removed' and handed to the
// sources' mirror hook (onLocalChange). A block that went with its task (ON DELETE CASCADE) is found by a sweep over
// the known task blocks and sent as removed too. Built by compose/calendar.ts with the late-bound services record.
// Owns: calendar rows and their events. Never: task text copies (a block has no title), moves a person-set block
// for the planner or an agent, writes a read-only source's row, or polls.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID, SYSTEM_ID, newId } from '../../shared/ids.ts';
import { LOCAL_SOURCE_ID, type CalendarAddInput, type CalendarEvent, type CalendarList, type CalendarSetBy } from '../../shared/model/calendar.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { CalendarService } from '../contracts/calendar.ts';
import { addFromSlot } from './add.ts';
import { agentRuns } from './agent-runs.ts';
import { CalendarRepo } from './repo.ts';
import { blockOwner, busySpans, conflicts, setByOf, type Span } from './rules.ts';
import { linkTasks } from './task-link.ts';

export type CalendarDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'settings' | 'tasks'>
  & Partial<Pick<RuntimeServices, 'log' | 'scheduler' | 'org' | 'chats' | 'estimates' | 'subconscious'>>;

export type LocalChange = CalendarEvent | { removed: string };

const STALE_MS = 24 * 60 * 60_000;

/** The profile zone all day math uses (the process zone when settings cannot be read). */
export function profileZone(s: Pick<RuntimeServices, 'settings'>): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try { return s.settings.get().profile.timezone || fallback; } catch { return fallback; }
}

export class CalendarServiceImpl implements CalendarService {
  readonly s: CalendarDeps;
  readonly repo: CalendarRepo;
  private readonly listeners = new Set<(change: LocalChange) => void>();
  /** Task blocks by row id: what a task's cascade can remove without telling us (filled when built). */
  private readonly known = new Map<string, { ownerId: string; taskId: string }>();
  /** The same by task id (most tasks have none: their changes cost no query). */
  private readonly blocked = new Map<string, Set<string>>();
  /** Events made from a slot click lately, by `<by>:<clientId>` (calendar/add.ts: a resend answers the same row). */
  readonly recentEvents = new Map<string, string>();
  private offs: Array<() => void> = [];

  constructor(s: CalendarDeps) {
    this.s = s;
    this.repo = new CalendarRepo(s.db);
    for (const block of this.repo.taskBlocks()) this.remember(block.id, block.ownerId, block.taskId);
  }

  /** Subscribes the check-off listeners (called once by compose/calendar.ts). */
  start(): void {
    if (!this.offs.length) this.offs = linkTasks(this);
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  list(ownerId: string, from: number, to: number, agentId?: string): CalendarList {
    const now = this.s.clock.now();
    return {
      events: agentId === undefined ? this.repo.inRange(ownerId, from, to) : [], // one agent's runs: the agent page needs no rows
      agentRuns: ownerId === HUMAN_ID ? agentRuns(this.s, from, to, agentId) : [], // the agents work for the owner
      tz: profileZone(this.s), staleSources: this.repo.staleSources(ownerId, now - STALE_MS),
    };
  }

  add(input: CalendarAddInput, by: string): Promise<{ event: CalendarEvent; task?: TaskView }> {
    try { return Promise.resolve(addFromSlot(this, input, by)); } catch (error) { return Promise.reject(error); }
  }

  /** `by` (optional, not in the contract yet): who placed it – an agent's id, else 'system' for the planner. */
  upsertBlock(taskId: string, startAt: number, endAt: number, setBy: CalendarSetBy, by?: string): CalendarEvent {
    if (!(endAt > startAt)) throw new WorkforceError('bad_request', 'A block ends after it starts.');
    const task = this.s.tasks.get(taskId);
    if (!task) throw new WorkforceError('not_found', 'Task not found.', { details: { taskId } });
    const ownerId = blockOwner(task);
    if (!ownerId) throw new WorkforceError('bad_request', 'Only to-dos get a time block.');
    if (task.status === 'done' || task.status === 'cancelled') throw new WorkforceError('conflict', 'This to-do is already finished.');
    const current = this.repo.byTask(taskId);
    if (current?.setBy === 'person' && setBy !== 'person') throw new WorkforceError('conflict', 'The person placed this to-do; it stays where they put it.', { details: { eventId: current.id } });
    if (setBy !== 'person') this.refuseFixed(ownerId, { startAt, endAt }, taskId);
    const now = this.s.clock.now();
    if (current) return this.save({ ...current, startAt, endAt, setBy, state: 'planned', rev: current.rev + 1, updatedAt: now }, current.rev);
    return this.insert({ ...this.fresh(ownerId, 'todo', setBy, by ?? (setBy === 'person' ? ownerId : SYSTEM_ID), startAt, endAt), taskId });
  }

  move(id: string, startAt: number, endAt: number, rev: number, by: string): CalendarEvent {
    if (!(endAt > startAt)) throw new WorkforceError('bad_request', 'An entry ends after it starts.');
    const row = this.writable(id);
    if (row.rev !== rev) throw new WorkforceError('conflict', 'This entry changed meanwhile. Reload and try again.', { details: { id, rev: row.rev } });
    const task = row.taskId ? this.s.tasks.get(row.taskId) : undefined;
    const open = task !== undefined && task.status !== 'done' && task.status !== 'cancelled';
    const state = row.state !== 'planned' && open ? 'planned' : row.state; // a moved block of an open to-do plans it again
    return this.save({ ...row, startAt, endAt, setBy: setByOf(by), state, rev: row.rev + 1, updatedAt: this.s.clock.now() }, rev);
  }

  remove(id: string, _by: string): void {
    this.drop(this.writable(id));
  }

  blocksFor(taskIds: string[]): Map<string, CalendarEvent> {
    const out = new Map<string, CalendarEvent>();
    for (const block of this.repo.byTasks([...new Set(taskIds)])) out.set(block.taskId!, block); // newest last wins
    return out;
  }

  busy(ownerId: string, from: number, to: number): Array<{ startAt: number; endAt: number }> {
    return busySpans(this.repo.inRange(ownerId, from, to));
  }

  onLocalChange(listener: (event: LocalChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ------------------------------------------------------------- shared by add.ts, task-link.ts and the agent tools

  /** The zone all day math uses. */
  zone(): string { return profileZone(this.s); }

  /** A new local row (not stored). */
  fresh(ownerId: string, kind: CalendarEvent['kind'], setBy: CalendarSetBy, createdBy: string, startAt: number, endAt: number): CalendarEvent {
    const now = this.s.clock.now();
    return {
      id: newId('cev', now), ownerId, kind, startAt, endAt, tz: this.zone(), sourceId: LOCAL_SOURCE_ID, setBy, state: 'planned', createdBy, rev: 0,
      createdAt: now, updatedAt: now,
    };
  }

  /** Refuses `span` when it covers a timed event or a block the person set ('conflict', with the first one's time). */
  refuseFixed(ownerId: string, span: Span, taskId?: string): void {
    const hit = conflicts(this.repo.inRange(ownerId, span.startAt, span.endAt), span, taskId)[0];
    if (hit) {
      throw new WorkforceError('conflict', hit.kind === 'event' ? 'That time is taken by an appointment in the calendar.' : 'That time is taken by a to-do the person placed.',
        { details: { eventId: hit.id, startAt: hit.startAt, endAt: hit.endAt } });
    }
  }

  insert(event: CalendarEvent): CalendarEvent {
    this.repo.insert(event);
    if (event.taskId) this.remember(event.id, event.ownerId, event.taskId);
    return this.changed(event);
  }

  save(event: CalendarEvent, rev: number): CalendarEvent {
    if (!this.repo.save(event, rev)) throw new WorkforceError('conflict', 'This entry changed meanwhile. Reload and try again.', { details: { id: event.id } });
    return this.changed(event);
  }

  drop(row: CalendarEvent): void {
    this.repo.delete(row.id);
    this.removed(row.id, row.ownerId, row.taskId);
  }

  /** Task blocks that went with their task (or its chat) without a word: sent as removed now. */
  sweep(): void {
    if (!this.known.size) return;
    const alive = this.repo.existing([...this.known.keys()]);
    for (const [id, block] of [...this.known]) if (!alive.has(id)) this.removed(id, block.ownerId, block.taskId);
  }

  /** The block of a task when it has one (no query for the many tasks without one). */
  blockOf(taskId: string): CalendarEvent | undefined {
    return this.blocked.has(taskId) ? this.repo.byTask(taskId) : undefined;
  }

  // ------------------------------------------------------------- internals

  /** A row the person may move or remove: it exists and is not from a read-only source. */
  private writable(id: string): CalendarEvent {
    const row = this.repo.get(id);
    if (!row) throw new WorkforceError('not_found', 'Calendar entry not found.', { details: { id } });
    if (row.readOnly) throw new WorkforceError('bad_request', 'This entry comes from a connected calendar that is read-only. Change it there.');
    return row;
  }

  private changed(event: CalendarEvent): CalendarEvent {
    this.s.bus.emit('calendar.upserted', event);
    this.tell(event);
    return event;
  }

  private remember(id: string, ownerId: string, taskId: string): void {
    this.known.set(id, { ownerId, taskId });
    const ids = this.blocked.get(taskId) ?? new Set<string>();
    this.blocked.set(taskId, ids.add(id));
  }

  private removed(id: string, ownerId: string, taskId?: string): void {
    this.known.delete(id);
    const ids = taskId ? this.blocked.get(taskId) : undefined;
    if (ids?.delete(id) && !ids.size) this.blocked.delete(taskId!);
    this.s.bus.emit('calendar.removed', taskId ? { id, ownerId, taskId } : { id, ownerId });
    this.tell({ removed: id });
  }

  private tell(change: LocalChange): void {
    for (const listener of [...this.listeners]) {
      try { listener(change); } catch (error) { this.s.log?.warn('calendar mirror listener failed', { error: String(error) }); }
    }
  }
}
