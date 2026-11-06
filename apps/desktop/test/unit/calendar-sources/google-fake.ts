// A fake Google (B-041 track G tests): the OAuth token endpoint (code + PKCE verifier → tokens, refresh, revoke,
// invalid_grant on demand) and Calendar API v3 – the person's primary calendar with paging, sync tokens (each change
// gets a sequence number; a token reads the changes after it; `expireTokens` answers 410), secondary calendars the
// app creates, and their events (PUT by id: 404 unless it exists; POST with an id: 409 when it exists; DELETE: 410
// when gone; privateExtendedProperty and time filters on list). Every call is recorded; the bearer must be current.
// Owns: fixtures only. Never imported by src/.

import type { FetchFn } from '../../../src/runtime/calendar/sources/http.ts';
import type { GoogleEvent } from '../../../src/runtime/calendar/sources/google-events.ts';
import { answer, type FetchCall } from './fixture.ts';

const json = (status: number, body: unknown) => answer(status, body === undefined ? '' : JSON.stringify(body), { 'content-type': 'application/json' });

export const BOTH_SCOPES = 'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.events.readonly';

export class FakeGoogle {
  calls: FetchCall[] = [];
  tokenForms: URLSearchParams[] = [];
  /** The person's main calendar: current events and the change log. */
  primary = new Map<string, GoogleEvent>();
  private log: Array<{ seq: number; id: string }> = [];
  private seq = 0;
  calendars = new Map<string, Map<string, GoogleEvent>>();
  pageSize = 2;
  private calendarSeq = 0;
  expireTokens = false;
  /** The Calendar API answers 503 (the token endpoint still works). */
  down = false;
  refreshError?: string;
  grantedScope = BOTH_SCOPES;
  summary = 'robin@example.com';
  private access = 0;
  validAccess = new Set<string>();
  revoked: string[] = [];

  /** Adds or changes an event of the main calendar (a new change in the log). */
  put(event: GoogleEvent): void {
    this.primary.set(event.id, { etag: `"e${++this.seq}"`, status: 'confirmed', ...event });
    this.log.push({ seq: this.seq, id: event.id });
  }

  /** Cancels an event – a series' instances with it (the change log names the series only, as a sync may). */
  cancel(id: string): void {
    const event = this.primary.get(id);
    this.primary.set(id, { ...(event ?? { id }), status: 'cancelled' });
    for (const [key, instance] of this.primary) if (instance.recurringEventId === id) this.primary.set(key, { ...instance, status: 'cancelled' });
    this.log.push({ seq: ++this.seq, id });
  }

  /** The events of the app's calendars that are not deleted. */
  mirrors(): GoogleEvent[] {
    return [...this.calendars.values()].flatMap((events) => [...events.values()]).filter((event) => event.status !== 'cancelled');
  }

  /** API calls with their method and path only (no hosts, no queries). */
  apiCalls(): string[] {
    return this.calls.filter((call) => call.url.startsWith('https://www.googleapis.com/')).map((call) => `${call.method} ${new URL(call.url).pathname.replace('/calendar/v3', '')}`);
  }

  fetch: FetchFn = async (url, init) => {
    this.calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const target = new URL(url);
    if (target.host === 'oauth2.googleapis.com') return this.oauth(target.pathname, new URLSearchParams(init.body ?? ''));
    if (target.host !== 'www.googleapis.com') return json(404, {});
    if (this.down) return json(503, { error: { errors: [{ reason: 'backendError' }] } });
    if (!this.validAccess.has((init.headers.authorization ?? '').replace(/^Bearer /, ''))) return json(401, { error: { status: 'UNAUTHENTICATED' } });
    const path = target.pathname.replace('/calendar/v3', '').split('/').map(decodeURIComponent);
    const body = init.body ? JSON.parse(init.body) as GoogleEvent : undefined;
    if (path[1] === 'calendars' && path.length === 2 && init.method === 'POST') {
      const id = `wf-cal-${++this.calendarSeq}@group.calendar.google.com`;
      this.calendars.set(id, new Map());
      return json(200, { id, summary: (body as unknown as { summary: string }).summary });
    }
    const calendarId = path[2];
    if (path[3] !== 'events') return json(404, {});
    if (calendarId === 'primary') return this.listPrimary(target.searchParams);
    const events = this.calendars.get(calendarId);
    if (!events) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
    const eventId = path[4];
    if (init.method === 'GET') {
      const pc = target.searchParams.get('privateExtendedProperty')?.split('=')[1];
      const from = Date.parse(target.searchParams.get('timeMin') ?? '1970-01-01T00:00:00Z');
      const to = Date.parse(target.searchParams.get('timeMax') ?? '2100-01-01T00:00:00Z');
      const items = [...events.values()].filter((event) => event.status !== 'cancelled' && (!pc || event.extendedProperties?.private?.pcId === pc)
        && Date.parse(event.end!.dateTime ?? `${event.end!.date}T00:00:00Z`) > from && Date.parse(event.start!.dateTime ?? `${event.start!.date}T00:00:00Z`) < to);
      return json(200, { items });
    }
    if (init.method === 'PUT') {
      if (!events.has(eventId)) return json(404, { error: { errors: [{ reason: 'notFound' }] } });
      events.set(eventId, { ...body!, id: eventId });
      return json(200, events.get(eventId));
    }
    if (init.method === 'POST') {
      if (events.has(body!.id)) return json(409, { error: { errors: [{ reason: 'duplicate' }] } });
      events.set(body!.id, { ...body!, status: 'confirmed' });
      return json(200, events.get(body!.id));
    }
    if (init.method === 'DELETE') {
      const event = events.get(eventId);
      if (!event || event.status === 'cancelled') return json(410, { error: { errors: [{ reason: 'deleted' }] } });
      events.set(eventId, { ...event, status: 'cancelled' });
      return answer(204, '');
    }
    return json(405, {});
  };

  private grant(): string {
    const token = `at-${++this.access}`;
    this.validAccess = new Set([token]);
    return token;
  }

  private oauth(path: string, form: URLSearchParams) {
    this.tokenForms.push(form);
    if (path === '/revoke') { this.revoked.push(form.get('token') ?? ''); return json(200, {}); }
    if (form.get('grant_type') === 'authorization_code') {
      if (form.get('code') !== 'code-1' || !form.get('code_verifier')) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: this.grant(), expires_in: 3599, refresh_token: 'rt-1', scope: this.grantedScope, token_type: 'Bearer' });
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (this.refreshError) return json(400, { error: this.refreshError, error_description: 'Token has been expired or revoked.' });
      if (form.get('refresh_token') !== 'rt-1') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: this.grant(), expires_in: 3599, scope: this.grantedScope });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  private listPrimary(query: URLSearchParams) {
    const offset = Number(query.get('pageToken') ?? 0);
    const token = query.get('syncToken');
    let items: GoogleEvent[];
    if (token) {
      if (this.expireTokens) return json(410, { error: { errors: [{ reason: 'fullSyncRequired' }] } });
      const after = Number(token.replace('st-', ''));
      const ids = [...new Set(this.log.filter((entry) => entry.seq > after).map((entry) => entry.id))];
      items = ids.map((id) => this.primary.get(id)!);
    } else {
      const from = Date.parse(query.get('timeMin') ?? '1970-01-01T00:00:00Z');
      items = [...this.primary.values()].filter((event) => event.status !== 'cancelled' && Date.parse(event.end!.dateTime ?? `${event.end!.date}T00:00:00Z`) > from);
    }
    const page = items.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < items.length;
    return json(200, { summary: this.summary, items: page, ...(more ? { nextPageToken: String(offset + this.pageSize) } : { nextSyncToken: `st-${this.seq}` }) });
  }
}
