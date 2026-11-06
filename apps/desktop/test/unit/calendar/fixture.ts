// Test fixture for the calendar runtime (B-041 track A1): the chat/task harness (in-memory SQLite, manual clock, fake
// org, real tasks and scheduler) with settings in the Europe/Vienna zone, the CalendarService started on it, local
// wall times, the person's own to-dos and rows written straight into calendar_events / calendar_sources.
// Owns: fixtures only. Never imported by src/.

import { HUMAN_ID } from '../../../src/shared/ids.ts';
import type { CalendarEvent } from '../../../src/shared/model/calendar.ts';
import { DEFAULT_DAY_SETTINGS, type DaySettings } from '../../../src/shared/model/day-settings.ts';
import type { CreateTaskInput } from '../../../src/shared/model/tasks.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import '../../../src/runtime/contracts/calendar.ts';
import { CalendarServiceImpl } from '../../../src/runtime/calendar/service.ts';
import { zonedTime } from '../../../src/runtime/calendar/when.ts';
import { agent, harness, tick } from '../chat/harness.ts';

export { agent, tick };

export const TZ = 'Europe/Vienna';
/** Tuesday after the switch to winter time (CET, UTC+1). */
export const DAY = '2026-10-27';
export const MIN = 60_000;
/** A person id the people rules accept. */
export const ANNA = 'per_anna00000000';

/** Epoch ms of `hhmm` on `date` in the fixture zone. */
export function at(hhmm: string, date = DAY): number {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedTime(date, h * 60 + m, TZ);
}

export function world(options: { day?: Partial<DaySettings>; now?: string; start?: boolean } = {}) {
  const h = harness();
  const s = h.services as RuntimeServices;
  const settings = { profile: { timezone: TZ, name: 'Robin' }, day: { ...DEFAULT_DAY_SETTINGS, ...options.day } };
  s.settings = { get: () => settings } as unknown as RuntimeServices['settings'];
  h.clock.set(at(options.now ?? '08:00'));
  h.org.add(agent('ag_mara', 'Mara', { template: 'secretary', mode: 'secretary' }));
  const calendar = new CalendarServiceImpl(s);
  s.calendar = calendar;
  if (options.start !== false) calendar.start();
  const changes: Array<CalendarEvent | { removed: string }> = [];
  calendar.onLocalChange((change) => changes.push(change));

  /** The person's own to-do (chat-free, B-054). */
  const todo = (title: string, extra: Partial<CreateTaskInput> = {}) =>
    h.tasks.create({ title, assigneeKind: 'human', createdBy: HUMAN_ID, ...extra });
  /** A row written straight into the table (no events). */
  const row = (fields: Partial<CalendarEvent> & Pick<CalendarEvent, 'startAt' | 'endAt'>): CalendarEvent => {
    const event: CalendarEvent = {
      id: `cev_${Math.random().toString(36).slice(2, 12)}`, ownerId: HUMAN_ID, kind: 'event', sourceId: 'local', setBy: 'person', state: 'planned',
      createdBy: HUMAN_ID, rev: 0, createdAt: h.clock.now(), updatedAt: h.clock.now(), ...fields,
    };
    calendar.repo.insert(event);
    return event;
  };
  /** A connected calendar (visible unless told otherwise; last synced `syncedAt`). */
  const source = (id: string, fields: { visible?: boolean; syncedAt?: number; createdAt?: number } = {}) => h.db.run(
    `INSERT INTO calendar_sources (id, owner_id, kind, label, visible, writable, status, last_sync_at, created_at) VALUES (?, 'human', 'ics', ?, ?, 0, 'ok', ?, ?)`,
    [id, `Calendar ${id}`, fields.visible === false ? 0 : 1, fields.syncedAt ?? null, fields.createdAt ?? h.clock.now()]);
  /** A chat of the owner with Mara. */
  const chat = () => h.chats.create({ agentIds: ['ag_mara'], createdBy: HUMAN_ID });
  /** Puts a person into a chat (it is then bounded: colleagues read along). */
  const addPerson = (conversationId: string, personId = ANNA) => h.db.run(
    `INSERT INTO members (conversation_id, member_id, kind, joined_at) VALUES (?, ?, 'human', 1)`, [conversationId, personId]);
  const removedEvents = () => h.of('calendar.removed');
  const upserted = () => h.of('calendar.upserted');
  return { ...h, s, settings, calendar, changes, todo, row, source, chat, addPerson, removedEvents, upserted };
}
