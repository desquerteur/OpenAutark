// Google Calendar as a two-way source (B-041 track G, the My day concept §5): consent in the system
// browser via oauth-loopback.ts with narrow scopes – calendar.events.readonly (read the person's events; this build
// reads the main calendar) and calendar.app.created (an own "Workforce" calendar the app writes to-do blocks into;
// google-mirror.ts). calendar.events.owned would also allow writing events into the main calendar; it is not asked
// for in this build (GOOGLE_OPTIONAL_SCOPES). The refresh token goes to the vault (google-auth.ts), the access token
// stays in memory. Reading is incremental with the sync token; a full read (window −7 … +67 days, recurring events as
// single instances) replaces the rows when there is no token, Google answers 410 (expired) or the window moved past
// the stored horizon. The client: settings.calendar.googleClientId or WORKFORCE_GOOGLE_CLIENT_ID, its secret from
// the vault (settings.calendar.googleSecretId) or WORKFORCE_GOOGLE_CLIENT_SECRET.
// Owns: the Google client of the sources. Never: a token in a log, an error text or a prompt; writes from a second PC.

import { SYSTEM_ID, newId } from '../../../shared/ids.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import type { Timers } from '../../schedules/scheduler.ts';
import { SourceRows, type SourceOccurrence } from './apply.ts';
import { GoogleApi } from './google-api.ts';
import { exchangeCode, GOOGLE_TOKEN_HOST, GoogleTokens, revokeToken, storeRefreshToken, type GoogleClient } from './google-auth.ts';
import { occurrenceOf } from './google-events.ts';
import { HttpFailure, type FetchFn } from './http.ts';
import { startLoopback, type LoopbackConsent, type LoopbackServerFactory } from './oauth-loopback.ts';
import type { SourceRecord, SourcesRepo } from './repo.ts';
import type { SourcesDeps } from './index.ts';

export const SCOPE_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const SCOPE_APP_CALENDAR = 'https://www.googleapis.com/auth/calendar.app.created';
/** Asked for at connect. */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [SCOPE_APP_CALENDAR, SCOPE_READ];
/** Not asked for in this build: writing the person's own events into the main calendar (the "Workforce" calendar holds them instead). */
export const GOOGLE_OPTIONAL_SCOPES: readonly string[] = ['https://www.googleapis.com/auth/calendar.events.owned'];
/** Days past the read window a full read keeps (so a daily sync does not need a full read every day). */
const HORIZON_EXTRA_MS = 7 * 86_400_000;

export interface GoogleDeps {
  s: SourcesDeps;
  repo: SourcesRepo;
  rows: SourceRows;
  fetch: FetchFn;
  env: Readonly<Record<string, string | undefined>>;
  timers?: Timers;
  loopback?: LoopbackServerFactory;
  /** This PC's id (the one PC that writes). */
  selfPc(): string;
  /** A source changed (status, rows, a new one): tell the owner's views. */
  changed(): void;
  /** A consent finished: the new or renewed source syncs now. */
  connected(sourceId: string): void;
}

export interface SyncWindow { from: number; to: number }

export class GoogleCalendar {
  readonly d: GoogleDeps;
  readonly tokens: GoogleTokens;
  private consent?: LoopbackConsent;
  /** The last consent's failure (user-safe), until the next consent starts or succeeds. */
  lastError?: string;
  /** A consent is open in the browser. */
  waiting = false;

  constructor(d: GoogleDeps) {
    this.d = d;
    this.tokens = new GoogleTokens({ fetch: d.fetch, clock: d.s.clock, secrets: d.s.secrets, client: (sourceId) => this.client(this.d.repo.state(sourceId).clientId) });
  }

  /** The configured client id (settings first, then the environment). */
  clientId(): string | undefined {
    let fromSettings: string | undefined;
    try { fromSettings = this.d.s.settings.get().calendar?.googleClientId?.trim() || undefined; } catch { /* no settings: the environment only */ }
    return fromSettings ?? (this.d.env.WORKFORCE_GOOGLE_CLIENT_ID?.trim() || undefined);
  }

  /** The OAuth client: `clientId` (default: the configured one) and its secret, when one is known. */
  async client(clientId = this.clientId()): Promise<GoogleClient> {
    if (!clientId) throw new WorkforceError('unavailable', 'Google Calendar needs a client ID first.');
    let secretId: string | undefined;
    let configuredId: string | undefined;
    try { const calendar = this.d.s.settings.get().calendar; secretId = calendar?.googleSecretId; configuredId = calendar?.googleClientId; } catch { /* none */ }
    if (secretId && (!configuredId || configuredId === clientId)) {
      try { return { clientId, clientSecret: await this.d.s.secrets.use(secretId, SYSTEM_ID, GOOGLE_TOKEN_HOST) }; } catch { /* removed from the vault: try the environment */ }
    }
    const envSecret = this.d.env.WORKFORCE_GOOGLE_CLIENT_SECRET?.trim();
    return envSecret && (!this.d.env.WORKFORCE_GOOGLE_CLIENT_ID || this.d.env.WORKFORCE_GOOGLE_CLIENT_ID.trim() === clientId) ? { clientId, clientSecret: envSecret } : { clientId };
  }

  /** The API of a connected source (its access token from memory, renewed from the vault). */
  api(source: SourceRecord): GoogleApi {
    return new GoogleApi(this.d.fetch, (fresh) => this.tokens.access(source.id, source.secretId ?? '', fresh));
  }

  /** Whether Google granted the app calendar (to-do blocks) for this source. */
  canWriteScope(source: SourceRecord): boolean {
    const scopes = this.d.repo.state(source.id).scopes;
    return scopes === undefined || scopes.includes(SCOPE_APP_CALENDAR);
  }

  /** Opens the consent in the browser; the source appears (or is renewed) once the person agreed there. */
  async connect(ownerId: string, clientId?: string): Promise<{ authUrl: string }> {
    const id = clientId?.trim() || this.clientId();
    if (!id) throw new WorkforceError('unavailable', 'Google Calendar needs a client ID first.');
    this.consent?.close();
    this.lastError = undefined;
    const consent = await startLoopback({ clientId: id, scopes: GOOGLE_CALENDAR_SCOPES, timers: this.d.timers, server: this.d.loopback });
    this.consent = consent;
    this.waiting = true;
    void consent.code.then((answer) => this.complete(ownerId, id, answer))
      .catch((error: unknown) => {
        if (this.consent !== consent) return; // replaced by a newer consent
        this.lastError = error instanceof WorkforceError ? error.message : 'Google Calendar was not connected.'; // user-safe sentences only
        this.d.s.log?.info('google calendar consent ended without a connection', { reason: error instanceof WorkforceError ? error.code : 'error' });
      })
      .finally(() => {
        if (this.consent !== consent) return;
        this.consent = undefined;
        this.waiting = false;
        this.d.changed();
      });
    try { await this.d.s.host?.openExternal(consent.authUrl); } catch (error) {
      this.d.s.log?.warn('google calendar consent page did not open', { error: String(error).slice(0, 120) }); // the UI offers the link
    }
    return { authUrl: consent.authUrl };
  }

  private async complete(ownerId: string, clientId: string, answer: { code: string; verifier: string; redirectUri: string }): Promise<void> {
    const now = this.d.s.clock.now();
    const granted = await exchangeCode(this.d.fetch, await this.client(clientId), answer, now);
    const scopes = granted.scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes(SCOPE_READ) && !scopes.includes(SCOPE_APP_CALENDAR)) throw new WorkforceError('forbidden', 'Google Calendar access was not granted.');
    const existing = this.d.repo.list(ownerId).find((source) => source.kind === 'google');
    const secretId = await storeRefreshToken(this.d.s.secrets, granted.refreshToken, existing?.secretId);
    const pcDeviceId = this.d.selfPc();
    let id: string;
    if (existing) {
      id = existing.id;
      const sameClient = this.d.repo.state(id).clientId === clientId;
      this.d.repo.patch(id, { secretId, pcDeviceId, writable: true, status: 'ok', error: null, ...(sameClient ? {} : { syncToken: null, writeCalendarId: null }) });
    } else {
      id = newId('cal', now);
      this.d.repo.insert({ id, ownerId, kind: 'google', label: 'Google Calendar', visible: true, writable: true, secretId, pcDeviceId, status: 'ok', createdAt: now });
    }
    this.d.repo.setState(id, { ...(existing ? this.d.repo.state(id) : {}), clientId, scopes, horizon: undefined }, now);
    this.tokens.hold(id, granted.accessToken, granted.expiresAt);
    this.d.s.log?.info('google calendar connected', { sourceId: id, renewed: Boolean(existing) });
    this.d.connected(id);
  }

  /** Reads the person's main calendar into the source's rows (incremental when possible). */
  async read(source: SourceRecord, window: SyncWindow, zone: string): Promise<void> {
    const state = this.d.repo.state(source.id);
    if (state.scopes && !state.scopes.includes(SCOPE_READ)) return; // the person granted the to-do calendar only
    const api = this.api(source);
    if (source.syncToken && state.horizon !== undefined && state.horizon >= window.to) {
      try {
        const changes = await api.listEvents('primary', {}, source.syncToken);
        const upserts: SourceOccurrence[] = [];
        const removals: string[] = [];
        for (const event of changes.items) {
          const item = occurrenceOf(event, zone);
          if (item && item.endAt > window.from && item.startAt < state.horizon) upserts.push(item); else removals.push(event.id);
        }
        for (const row of this.d.rows.calendar.bySource(source.id)) if (row.endAt <= window.from && row.externalId) removals.push(row.externalId); // aged out
        this.d.rows.change(source, upserts, removals);
        if (changes.nextSyncToken) this.d.repo.patch(source.id, { syncToken: changes.nextSyncToken });
        return;
      } catch (error) {
        if (!(error instanceof HttpFailure) || error.status !== 410) throw error; // 410: the token expired – read everything again
      }
    }
    const horizon = window.to + HORIZON_EXTRA_MS;
    const all = await api.listEvents('primary', { timeMin: new Date(window.from).toISOString(), singleEvents: 'true' });
    const items = all.items.map((event) => occurrenceOf(event, zone)).filter((item): item is SourceOccurrence => Boolean(item && item.endAt > window.from && item.startAt < horizon));
    this.d.rows.replace(source, items);
    this.d.repo.patch(source.id, { syncToken: all.complete && all.nextSyncToken ? all.nextSyncToken : null, ...(all.summary && source.label === 'Google Calendar' ? { label: all.summary.slice(0, 80) } : {}) });
    this.d.repo.setState(source.id, { ...state, horizon }, this.d.s.clock.now());
  }

  /** Removing the connection: the token leaves memory and Google is told to drop the sign-in (best effort, not awaited). */
  async disconnect(source: SourceRecord): Promise<void> {
    this.tokens.forget(source.id);
    if (!source.secretId) return;
    let token: string | undefined;
    try { token = await this.d.s.secrets.use(source.secretId, SYSTEM_ID, GOOGLE_TOKEN_HOST); } catch { return; }
    void revokeToken(this.d.fetch, token);
  }

  stop(): void {
    this.consent?.close();
    this.consent = undefined;
    this.waiting = false;
  }
}
