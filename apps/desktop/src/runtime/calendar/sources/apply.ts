// A connected calendar's rows in My day (B-041 track G): the occurrences a sync read become calendar_events rows of
// that source (kind 'event', setBy 'sync', readOnly, owned by the source's member, keyed by the unique
// (source_id, external_id)) – inserted, changed only when something differs, removed when they vanished – in one
// transaction, then announced as 'calendar.upserted' / 'calendar.removed' (only for a shown source: a hidden one's
// rows stay out of every view). Showing or hiding a source announces its rows coming or going. Rows are written
// with calendar/repo.ts (track A1); these changes never reach the sources' mirror hook (they are not local).
// Owns: applying occurrences to rows. Never: touches a local row (source 'local') or a to-do block.

import { SYSTEM_ID, newId } from '../../../shared/ids.ts';
import type { CalendarEvent } from '../../../shared/model/calendar.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { CalendarRepo } from '../repo.ts';
import type { IcsOccurrence } from './ics.ts';
import type { SourceRecord, SourcesRepo } from './repo.ts';

/** An occurrence as a source reads it (Google adds its etag). */
export type SourceOccurrence = IcsOccurrence & { etag?: string };
export interface ApplyResult { added: number; changed: number; removed: number }

const FIELDS = ['title', 'notes', 'startAt', 'endAt', 'tz', 'etag'] as const;

function differs(row: CalendarEvent, item: SourceOccurrence): boolean {
  return Boolean(row.allDay) !== Boolean(item.allDay) || FIELDS.some((key) => row[key] !== item[key]);
}

type Announce = { kind: 'up'; event: CalendarEvent } | { kind: 'gone'; id: string; ownerId: string };

export class SourceRows {
  readonly s: Pick<RuntimeServices, 'db' | 'bus' | 'clock'>;
  readonly sources: SourcesRepo;
  readonly calendar: CalendarRepo;

  constructor(s: Pick<RuntimeServices, 'db' | 'bus' | 'clock'>, sources: SourcesRepo) {
    this.s = s;
    this.sources = sources;
    this.calendar = new CalendarRepo(s.db);
  }

  /** The source's rows become exactly `items` (a full read). */
  replace(source: SourceRecord, items: readonly SourceOccurrence[]): ApplyResult {
    const wanted = new Map(items.map((item) => [item.externalId, item]));
    return this.write(source, (out, result) => {
      const seen = new Set<string>();
      for (const row of this.calendar.bySource(source.id)) {
        const item = row.externalId === undefined ? undefined : wanted.get(row.externalId);
        if (!item || seen.has(row.externalId!)) { this.drop(row, out, result); continue; }
        seen.add(row.externalId!);
        this.update(row, item, out, result);
      }
      for (const item of wanted.values()) if (!seen.has(item.externalId)) this.add(source, item, out, result);
    });
  }

  /** An incremental read: `upserts` are added or changed, `removals` (with their series' instances) go. */
  change(source: SourceRecord, upserts: readonly SourceOccurrence[], removals: readonly string[]): ApplyResult {
    return this.write(source, (out, result) => {
      for (const externalId of removals) for (const row of this.calendar.bySeries(source.id, externalId)) this.drop(row, out, result);
      for (const item of upserts) {
        const row = this.calendar.byExternal(source.id, item.externalId);
        if (row) this.update(row, item, out, result); else this.add(source, item, out, result);
      }
    });
  }

  /** Removes every row of the source (it is being removed). */
  clear(source: SourceRecord): number {
    return this.write(source, (out, result) => { for (const row of this.calendar.bySource(source.id)) this.drop(row, out, result); }).removed;
  }

  /** The source was shown or hidden: its rows come into the views or leave them (the rows stay). */
  announce(source: SourceRecord, visible: boolean): void {
    for (const row of this.calendar.bySource(source.id)) {
      if (visible) this.s.bus.emit('calendar.upserted', row);
      else this.s.bus.emit('calendar.removed', { id: row.id, ownerId: row.ownerId });
    }
  }

  private write(source: SourceRecord, run: (out: Announce[], result: ApplyResult) => void): ApplyResult {
    const out: Announce[] = [];
    const result: ApplyResult = { added: 0, changed: 0, removed: 0 };
    this.s.db.tx(() => { if (this.sources.get(source.id)) run(out, result); }); // a source removed meanwhile gets no rows
    if (!out.length) return result;
    if (source.visible) {
      for (const item of out) {
        if (item.kind === 'up') this.s.bus.emit('calendar.upserted', item.event);
        else this.s.bus.emit('calendar.removed', { id: item.id, ownerId: item.ownerId });
      }
    }
    return result;
  }

  private add(source: SourceRecord, item: SourceOccurrence, out: Announce[], result: ApplyResult): void {
    const now = this.s.clock.now();
    const event: CalendarEvent = {
      id: newId('cev', now), ownerId: source.ownerId, kind: 'event', ...strip(item), sourceId: source.id, setBy: 'sync', state: 'planned', readOnly: true,
      createdBy: SYSTEM_ID, rev: 0, createdAt: now, updatedAt: now,
    };
    this.calendar.insert(event);
    out.push({ kind: 'up', event });
    result.added++;
  }

  private update(row: CalendarEvent, item: SourceOccurrence, out: Announce[], result: ApplyResult): void {
    if (!differs(row, item)) return;
    const next: CalendarEvent = { ...without(row), ...strip(item), rev: row.rev + 1, updatedAt: this.s.clock.now() };
    if (!this.calendar.save(next, row.rev)) return; // changed meanwhile: the next sync looks again
    out.push({ kind: 'up', event: next });
    result.changed++;
  }

  private drop(row: CalendarEvent, out: Announce[], result: ApplyResult): void {
    if (!this.calendar.delete(row.id)) return;
    out.push({ kind: 'gone', id: row.id, ownerId: row.ownerId });
    result.removed++;
  }
}

/** The occurrence's row fields (no undefined keys). */
function strip(item: SourceOccurrence): Partial<CalendarEvent> & Pick<CalendarEvent, 'startAt' | 'endAt'> {
  const out: Partial<CalendarEvent> & Pick<CalendarEvent, 'startAt' | 'endAt'> = { startAt: item.startAt, endAt: item.endAt, externalId: item.externalId };
  if (item.title !== undefined) out.title = item.title;
  if (item.notes !== undefined) out.notes = item.notes;
  if (item.allDay) out.allDay = true;
  if (item.tz !== undefined) out.tz = item.tz;
  if (item.etag !== undefined) out.etag = item.etag;
  return out;
}

/** A row without the fields an occurrence may leave out (so a dropped title or notes really go). */
function without(row: CalendarEvent): CalendarEvent {
  const { title: _title, notes: _notes, allDay: _allDay, tz: _tz, etag: _etag, ...rest } = row;
  return rest;
}
