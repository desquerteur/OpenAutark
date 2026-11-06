// My day's own rows mirrored into Google (B-041 track G, contract §5.6 "Sources mirror via onLocalChange"): the
// to-do blocks and events made in the app go into the person's "Workforce" calendar (created on first use, again
// when the person deleted it). Every local change (CalendarService.onLocalChange) queues its row id; one worker
// writes the row as it is then (gone or no longer a local row → its mirror is deleted), one call at a time. A sync
// reconciles the window (−7 … +60 days): missing or changed mirrors are written, mirrors of rows that went are
// deleted – so a write that failed offline is repaired at the next sync, never by a timer. Only the PC set as
// pc_device_id writes (a second PC connected to the same account reads only), and only with the app-calendar scope.
// Owns: the write side of Google. Never: writes into the person's main calendar, or text of an "Only me" to-do.

import { HUMAN_ID } from '../../../shared/ids.ts';
import type { CalendarEvent } from '../../../shared/model/calendar.ts';
import type { RuntimeServices } from '../../contracts.ts';
import { CalendarRepo } from '../repo.ts';
import type { GoogleApi } from './google-api.ts';
import { ReconnectNeeded } from './google-auth.ts';
import { mirrorBody, mirrored, mirrorId, sameMirror, WORKFORCE_CALENDAR, type GoogleEvent, type GoogleEventBody } from './google-events.ts';
import type { GoogleCalendar, SyncWindow } from './google.ts';
import { HttpFailure } from './http.ts';
import type { SourceRecord, SourcesRepo } from './repo.ts';

export interface MirrorDeps {
  s: Pick<RuntimeServices, 'db' | 'clock'> & Partial<Pick<RuntimeServices, 'log' | 'tasks'>>;
  repo: SourcesRepo;
  google: GoogleCalendar;
  selfPc(): string;
  zone(): string;
  /** A write found the sign-in gone. */
  reconnect(source: SourceRecord): void;
}

export class GoogleMirror {
  readonly d: MirrorDeps;
  private readonly calendar: CalendarRepo;
  private readonly queue = new Set<string>();
  private running = false;
  private stopped = false;

  constructor(d: MirrorDeps) {
    this.d = d;
    this.calendar = new CalendarRepo(d.s.db);
  }

  /** The owner's Google source this PC writes to (undefined: none, another PC writes, or no app-calendar scope). */
  writer(ownerId = HUMAN_ID): SourceRecord | undefined {
    return this.d.repo.list(ownerId).find((source) => this.writes(source));
  }

  /** Whether this PC writes to-do blocks into `source`. */
  writes(source: SourceRecord): boolean {
    return source.kind === 'google' && source.status !== 'reconnect' && Boolean(source.secretId) && source.pcDeviceId === this.d.selfPc() && this.d.google.canWriteScope(source);
  }

  /** onLocalChange: queues the row (its mirror is written as the row is when its turn comes). */
  changed(change: CalendarEvent | { removed: string }): void {
    if (this.stopped) return;
    if ('removed' in change) this.queue.add(change.removed);
    else if (mirrored(change) && change.ownerId === HUMAN_ID) this.queue.add(change.id);
    else return;
    if (!this.writer()) { this.queue.clear(); return; } // nothing to write to: the next connect reconciles
    void this.drain();
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    this.queue.clear();
  }

  /** Writes the window's mirrors (called by the source's sync after reading). */
  async reconcile(source: SourceRecord, api: GoogleApi, window: SyncWindow, again = true): Promise<void> {
    if (!this.writes(source)) return;
    const pc = this.d.selfPc();
    const calendarId = await this.calendarOf(source, api);
    let remote: GoogleEvent[];
    try {
      remote = (await api.listEvents(calendarId, {
        timeMin: new Date(window.from).toISOString(), timeMax: new Date(window.to).toISOString(), singleEvents: 'true', privateExtendedProperty: `pcId=${pc}`,
      })).items;
    } catch (error) {
      if (!(error instanceof HttpFailure && error.status === 404) || !again) throw error;
      this.d.repo.patch(source.id, { writeCalendarId: null }); // the person deleted the calendar: it is made again
      return this.reconcile({ ...source, writeCalendarId: undefined }, api, window, false);
    }
    const byRow = new Map<string, GoogleEvent>();
    for (const event of remote) { const rowId = event.extendedProperties?.private?.eventId; if (rowId && event.status !== 'cancelled') byRow.set(rowId, event); }
    for (const row of this.calendar.inRange(source.ownerId, window.from, window.to)) {
      if (!mirrored(row)) continue;
      const body = this.bodyOf(row);
      const current = byRow.get(row.id);
      byRow.delete(row.id);
      if (!current || !sameMirror(current, body)) await api.putEvent(calendarId, mirrorId(pc, row.id), body);
    }
    for (const event of byRow.values()) await api.deleteEvent(calendarId, event.id);
  }

  private bodyOf(row: CalendarEvent): GoogleEventBody {
    const task = row.taskId ? this.d.s.tasks?.get(row.taskId) : undefined;
    return mirrorBody(row, { title: task?.title, privateTodo: task?.private === true, pcId: this.d.selfPc(), zone: this.d.zone() });
  }

  /** The "Workforce" calendar's id (created when the source has none yet). */
  private async calendarOf(source: SourceRecord, api: GoogleApi): Promise<string> {
    const known = this.d.repo.get(source.id)?.writeCalendarId;
    if (known) return known;
    const id = await api.createCalendar(WORKFORCE_CALENDAR, this.d.zone());
    this.d.repo.patch(source.id, { writeCalendarId: id });
    return id;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size && !this.stopped) {
        const id = this.queue.values().next().value as string;
        this.queue.delete(id);
        const source = this.writer();
        if (!source) { this.queue.clear(); break; }
        try { await this.write(source, id); } catch (error) {
          if (error instanceof ReconnectNeeded) { this.d.reconnect(source); this.queue.clear(); break; }
          this.d.s.log?.warn('google calendar: a to-do block was not written (the next sync repairs it)', { error: error instanceof Error ? error.message.slice(0, 120) : 'error' });
        }
      }
    } finally { this.running = false; }
  }

  private async write(source: SourceRecord, rowId: string): Promise<void> {
    const api = this.d.google.api(source);
    const calendarId = await this.calendarOf(source, api);
    const row = this.calendar.get(rowId);
    const eventId = mirrorId(this.d.selfPc(), rowId);
    if (!row || !mirrored(row) || row.ownerId !== source.ownerId) { await api.deleteEvent(calendarId, eventId); return; }
    try {
      await api.putEvent(calendarId, eventId, this.bodyOf(row));
    } catch (error) {
      if (!(error instanceof HttpFailure && error.status === 404)) throw error;
      this.d.repo.patch(source.id, { writeCalendarId: null }); // the calendar is gone: made again on the next write
      const fresh = await this.calendarOf({ ...source, writeCalendarId: undefined }, api);
      await api.putEvent(fresh, eventId, this.bodyOf(row));
    }
  }
}
