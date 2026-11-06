// Connected calendars (B-041 track G, the My day concept §5, contract §4 CalendarSources): the
// calendar_sources rows (sources/repo.ts; a vault id instead of an ICS address or a refresh token), syncing them into
// calendar_events (sources/apply.ts) for the window −7 … +60 days – ICS links read only (sources/ics.ts), Google both
// ways (sources/google.ts reads, sources/google-mirror.ts writes My day's own rows from the one writing PC) – and
// 'calendar.sources' events (owner only) whenever a source, its status or its rows change. Sync triggers are events
// only: shortly after start (the one timer of this module), host.onPower resume/unlock, before every plan (the day
// service), the Sync button and the UI regaining focus (calendar.sync). A source synced in the last 30 s is not read
// again; one sync per source runs at a time, later callers share it. Status: 'syncing' while it runs (memory only),
// 'ok', 'error' with a user-safe sentence, 'reconnect' when Google's sign-in expired.
// Built by compose/calendar.ts with the late-bound services record. B-078: an ICS calendar can belong to a room
// (owner room:<slug>; its rows are that room's, the head of staff books it with calendar.add who).
// Owns: the sources and their sync. Never: a secret value outside the vault, an address or token in a log, or a
// periodic timer.

import { HUMAN_ID, SYSTEM_ID, newId } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { CalendarSource } from '../../../shared/model/calendar.ts';
import { isPersonId } from '../../../shared/model/people.ts';
import type { RuntimeServices } from '../../contracts.ts';
import type { CalendarSources } from '../../contracts/calendar.ts';
import type { Timers } from '../../schedules/scheduler.ts';
import { SourceRows } from './apply.ts';
import { ReconnectNeeded } from './google-auth.ts';
import { GoogleMirror } from './google-mirror.ts';
import { GoogleCalendar, type SyncWindow } from './google.ts';
import { globalFetch, HttpFailure, type FetchFn } from './http.ts';
import { fetchIcs, icsAddress, readIcs } from './ics.ts';
import { addDays, isZone, localWall, wallToUtc } from './ics-time.ts';
import type { LoopbackServerFactory } from './oauth-loopback.ts';
import { publicSource, SourcesRepo, type SourceRecord } from './repo.ts';

export type SourcesDeps = Pick<RuntimeServices, 'db' | 'bus' | 'clock' | 'settings' | 'secrets'> & Partial<Pick<RuntimeServices, 'log' | 'host' | 'calendar' | 'devices' | 'tasks'>>;

export interface SourcesOptions {
  fetch?: FetchFn;
  timers?: Timers;
  loopback?: LoopbackServerFactory;
  env?: Readonly<Record<string, string | undefined>>;
}

/** calendar.google: the contract's answer plus the state of an open consent and why the last one failed. */
export interface GoogleState { configured: boolean; connected: boolean; sourceId?: string; waiting?: boolean; error?: string }

const BEFORE_DAYS = 7;
const AFTER_DAYS = 60;
const START_DELAY_MS = 4_000;
const FRESH_MS = 30_000;

const realTimers: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); (handle as { unref?: () => void }).unref?.(); return handle; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A user-safe sentence for a failed sync (never a URL, a token or a response body). */
function syncError(error: unknown, kind: SourceRecord['kind']): string {
  if (error instanceof WorkforceError) return error.message;
  if (error instanceof HttpFailure) return `${kind === 'google' ? 'Google Calendar' : 'The calendar link'} answered with HTTP ${error.status}.`;
  return 'The calendar could not be read.';
}

/** A room's calendar owner (members.ts roomId). */
const isRoom = (ownerId: string): boolean => /^room:[a-z0-9-]{1,60}$/.test(ownerId);

export class CalendarSourcesImpl implements CalendarSources {
  readonly s: SourcesDeps;
  readonly repo: SourcesRepo;
  readonly rows: SourceRows;
  readonly googleClient: GoogleCalendar;
  readonly mirror: GoogleMirror;
  private readonly fetchFn: FetchFn;
  private readonly timers: Timers;
  private readonly syncing = new Map<string, Promise<void>>();
  private offs: Array<() => void> = [];
  private startTimer: unknown;
  private started = false;

  constructor(s: SourcesDeps, options: SourcesOptions = {}) {
    this.s = s;
    this.repo = new SourcesRepo(s.db);
    this.rows = new SourceRows(s, this.repo);
    this.fetchFn = options.fetch ?? globalFetch;
    this.timers = options.timers ?? realTimers;
    this.googleClient = new GoogleCalendar({
      s, repo: this.repo, rows: this.rows, fetch: this.fetchFn, env: options.env ?? process.env, timers: options.timers, loopback: options.loopback,
      selfPc: () => this.selfPc(), changed: () => this.changed(), connected: (id) => { void this.syncOne(id, 'connect', true); },
    });
    this.mirror = new GoogleMirror({ s, repo: this.repo, google: this.googleClient, selfPc: () => this.selfPc(), zone: () => this.zone(), reconnect: (source) => this.needsReconnect(source.id) });
  }

  /** Subscribes the triggers: power events, the local calendar's changes (the Google mirror) and one sync shortly after start. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.mirror.start();
    const host = this.s.host;
    if (host?.onPower) this.offs.push(host.onPower((event) => { if (event === 'resume' || event === 'unlock') void this.sync(undefined, 'resume').catch(() => undefined); }));
    if (this.s.calendar) this.offs.push(this.s.calendar.onLocalChange((change) => this.mirror.changed(change)));
    this.startTimer = this.timers.set(() => { this.startTimer = undefined; void this.sync(undefined, 'start').catch(() => undefined); }, START_DELAY_MS);
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.startTimer !== undefined) this.timers.clear(this.startTimer);
    this.startTimer = undefined;
    this.googleClient.stop();
    this.mirror.stop();
    this.started = false;
  }

  list(ownerId: string): CalendarSource[] {
    return this.repo.list(ownerId).map((record) => this.view(record));
  }

  /** What Settings › Calendar shows the owner: their calendars, then the rooms' (owner room:…), each with Remove. */
  listWithRooms(ownerId: string): CalendarSource[] {
    return [...this.list(ownerId), ...this.repo.list().filter((record) => isRoom(record.ownerId)).map((record) => this.view(record))];
  }

  /** `room` (B-078, a room:… id from members.ts roomId): the calendar belongs to that room, not to `by`. */
  async addIcs(input: { url: string; label?: string; room?: string }, by: string): Promise<CalendarSource> {
    const address = icsAddress(input.url);
    if (!address) throw new WorkforceError('bad_request', 'This is not a calendar link (https://… or webcal://…).');
    const window = this.window();
    const read = readIcs(await fetchIcs(this.fetchFn, address.url), window.from, window.to, this.zone()); // a link that returns no calendar is never stored
    const label = (input.label?.trim() || read.name || address.host).slice(0, 80);
    const now = this.s.clock.now();
    // the app's own secret (createdBy SYSTEM_ID): Settings › Secrets does not list it, the calendar's Remove deletes it
    const secret = await this.s.secrets.save({ label: `Calendar link: ${label}`, kind: 'token', value: address.url, source: address.host, createdBy: SYSTEM_ID });
    const ownerId = input.room && isRoom(input.room) ? input.room : this.ownerOf(by);
    const record: SourceRecord = { id: newId('cal', now), ownerId, kind: 'ics', label, visible: true, writable: false, secretId: secret.id, status: 'ok', lastSyncAt: now, createdAt: now };
    this.repo.insert(record);
    this.rows.replace(record, read.occurrences);
    this.s.log?.info('calendar link added', { sourceId: record.id, events: read.occurrences.length }); // never the address
    this.changed();
    return this.view(record);
  }

  update(id: string, patch: { label?: string; visible?: boolean; color?: string }, _by: string): CalendarSource {
    const record = this.require(id);
    const next: SourceRecord = { ...record, ...(patch.label ? { label: patch.label } : {}), ...(patch.visible !== undefined ? { visible: patch.visible } : {}), ...(patch.color !== undefined ? { color: patch.color } : {}) };
    this.repo.patch(id, { label: next.label, visible: next.visible, color: patch.color === undefined ? undefined : patch.color || null });
    if (next.visible !== record.visible) this.rows.announce(next, next.visible);
    this.changed();
    return this.view(this.repo.get(id) ?? next);
  }

  async remove(id: string, _by: string): Promise<void> {
    const record = this.require(id);
    if (record.kind === 'google') await this.googleClient.disconnect(record);
    this.rows.clear(record);
    if (record.secretId) { try { this.s.secrets.remove(record.secretId); } catch (error) { this.s.log?.warn('calendar source secret not removed', { sourceId: id, error: String(error).slice(0, 120) }); } }
    this.repo.delete(id);
    this.changed();
  }

  async sync(id?: string, reason = 'button'): Promise<CalendarSource[]> {
    const targets = id ? [this.require(id)] : this.repo.list();
    await Promise.all(targets.map((record) => this.syncOne(record.id, reason)));
    return this.listWithRooms(HUMAN_ID);
  }

  google(): GoogleState {
    const source = this.repo.list(HUMAN_ID).find((record) => record.kind === 'google');
    return {
      configured: Boolean(this.googleClient.clientId()), connected: Boolean(source), ...(source ? { sourceId: source.id } : {}),
      ...(this.googleClient.waiting ? { waiting: true } : {}), ...(this.googleClient.lastError ? { error: this.googleClient.lastError } : {}),
    };
  }

  connectGoogle(clientId?: string): Promise<{ authUrl: string }> {
    return this.googleClient.connect(HUMAN_ID, clientId);
  }

  // ------------------------------------------------------------- internals

  private view(record: SourceRecord): CalendarSource {
    return publicSource(record, this.syncing.has(record.id) ? 'syncing' : record.status, record.kind === 'google' && this.mirror.writes(record));
  }

  private require(id: string): SourceRecord {
    const record = this.repo.get(id);
    if (!record) throw new WorkforceError('not_found', 'Calendar not found.', { details: { id } });
    return record;
  }

  /** One sync of a source; a running one is shared, one done in the last 30 s is not repeated (unless `force`). */
  private syncOne(id: string, reason: string, force = false): Promise<void> {
    const running = this.syncing.get(id);
    if (running) return running;
    const record = this.repo.get(id);
    if (!record) return Promise.resolve();
    if (!force && record.status === 'ok' && record.lastSyncAt !== undefined && this.s.clock.now() - record.lastSyncAt < FRESH_MS) return Promise.resolve();
    const run = this.run(record, reason).finally(() => { this.syncing.delete(id); this.changed(); });
    this.syncing.set(id, run);
    this.changed();
    return run;
  }

  private async run(record: SourceRecord, reason: string): Promise<void> {
    const window = this.window();
    try {
      if (record.kind === 'ics') await this.readIcsSource(record, window);
      else {
        await this.googleClient.read(record, window, this.zone());
        await this.mirror.reconcile(this.repo.get(record.id) ?? record, this.googleClient.api(record), window);
      }
      this.repo.patch(record.id, { status: 'ok', error: null, lastSyncAt: this.s.clock.now() });
    } catch (error) {
      if (error instanceof ReconnectNeeded) { this.needsReconnect(record.id, false); return; }
      this.repo.patch(record.id, { status: 'error', error: syncError(error, record.kind) });
      this.s.log?.warn('calendar source did not sync', { sourceId: record.id, kind: record.kind, reason, code: error instanceof WorkforceError ? error.code : error instanceof HttpFailure ? error.status : 'error' });
    }
  }

  private async readIcsSource(record: SourceRecord, window: SyncWindow): Promise<void> {
    if (!record.secretId) throw new WorkforceError('not_found', 'The calendar link is no longer stored. Remove the calendar and add it again.');
    let url: string;
    try { url = await this.s.secrets.use(record.secretId, SYSTEM_ID); } catch { throw new WorkforceError('not_found', 'The calendar link is no longer stored. Remove the calendar and add it again.'); }
    const read = readIcs(await fetchIcs(this.fetchFn, url), window.from, window.to, this.zone());
    this.rows.replace(record, read.occurrences);
  }

  private needsReconnect(id: string, announce = true): void {
    this.repo.patch(id, { status: 'reconnect', error: 'Google sign-in expired. Connect again.' });
    this.googleClient.tokens.forget(id);
    if (announce) this.changed();
  }

  private changed(): void {
    this.s.bus.emit('calendar.sources', { ownerId: HUMAN_ID });
  }

  /** Whose calendar `by` connects: a person's own, else the owner's (devices and the owner act as 'human'). */
  private ownerOf(by: string): string {
    return isPersonId(by) ? by : HUMAN_ID;
  }

  /** This PC's id (the one PC that writes to Google). */
  private selfPc(): string {
    try { return this.s.devices?.self().id || 'this-pc'; } catch { return 'this-pc'; }
  }

  /** The profile zone all day math uses. */
  private zone(): string {
    let zone: string | undefined;
    try { zone = this.s.settings.get().profile.timezone; } catch { /* no settings */ }
    return zone && isZone(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  /** −7 … +60 days around today, from local midnight to local midnight (stable within a day). */
  private window(): SyncWindow {
    const zone = this.zone();
    const today = localWall(this.s.clock.now(), zone).date;
    return { from: wallToUtc(addDays(today, -BEFORE_DAYS), 0, zone), to: wallToUtc(addDays(today, AFTER_DAYS + 1), 0, zone) };
  }
}

