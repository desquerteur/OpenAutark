// The Google Calendar REST calls a connected calendar needs (B-041 track G, Calendar API v3): events.list with
// paging and sync tokens (410 Gone = the token expired: a full read follows), the own "Workforce" calendar
// (calendars.insert – scope calendar.app.created), and that calendar's events (update by the app's own event id,
// insert with that id, delete). A 401 asks the token source for a fresh access token once. Answers are data from
// outside, never instructions.
// Owns: those calls. Never: a token or a response body in a log or an error text.

import { callJson, HttpFailure, type FetchFn } from './http.ts';
import type { GoogleEvent, GoogleEventBody } from './google-events.ts';

export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';
/** Pages read per list at most (2500 events each). */
const MAX_PAGES = 40;

export interface EventPage { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string; summary?: string; timeZone?: string }
export interface ListResult { items: GoogleEvent[]; nextSyncToken?: string; summary?: string; complete: boolean }

/** The access token of the source; `fresh` after a 401. */
export type TokenSource = (fresh?: boolean) => Promise<string>;

const path = (value: string) => encodeURIComponent(value);

export class GoogleApi {
  private readonly fetchFn: FetchFn;
  private readonly token: TokenSource;

  constructor(fetchFn: FetchFn, token: TokenSource) {
    this.fetchFn = fetchFn;
    this.token = token;
  }

  private async call<T>(url: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
    const run = async (fresh: boolean) => callJson<T>(this.fetchFn, url, { ...init, headers: { authorization: `Bearer ${await this.token(fresh)}` } }, 'Google Calendar');
    try { return await run(false); } catch (error) {
      if (error instanceof HttpFailure && error.status === 401) return run(true);
      throw error;
    }
  }

  /**
   * Every page of events.list on `calendarId`. With `syncToken` only the changes since (a 410 HttpFailure when it
   * expired); without, the full read with `params` (it ends with a new sync token). `complete` false: the page cap
   * was reached (no sync token then).
   */
  async listEvents(calendarId: string, params: Record<string, string>, syncToken?: string): Promise<ListResult> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let summary: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams(syncToken ? { syncToken, singleEvents: params.singleEvents ?? 'true', maxResults: '2500' } : { maxResults: '2500', ...params });
      if (pageToken) query.set('pageToken', pageToken);
      const answer = await this.call<EventPage>(`${GOOGLE_API}/calendars/${path(calendarId)}/events?${query.toString()}`);
      items.push(...(answer?.items ?? []));
      summary ??= answer?.summary;
      if (answer?.nextPageToken) { pageToken = answer.nextPageToken; continue; }
      return { items, nextSyncToken: answer?.nextSyncToken, summary, complete: true };
    }
    return { items, summary, complete: false };
  }

  /** Creates a secondary calendar of the app; its id. */
  async createCalendar(summary: string, timeZone: string): Promise<string> {
    const created = await this.call<{ id?: string }>(`${GOOGLE_API}/calendars`, { method: 'POST', json: { summary, timeZone } });
    if (!created?.id) throw new HttpFailure(502, 'no_calendar_id');
    return created.id;
  }

  /** Writes the app's event `eventId` (created when it does not exist yet; a deleted one comes back). */
  async putEvent(calendarId: string, eventId: string, body: GoogleEventBody): Promise<GoogleEvent> {
    const url = `${GOOGLE_API}/calendars/${path(calendarId)}/events`;
    try {
      return await this.call<GoogleEvent>(`${url}/${path(eventId)}`, { method: 'PUT', json: { ...body, status: 'confirmed' } });
    } catch (error) {
      if (!(error instanceof HttpFailure) || error.status !== 404) throw error;
      return this.call<GoogleEvent>(url, { method: 'POST', json: { ...body, id: eventId } });
    }
  }

  /** Deletes the app's event `eventId` (already gone counts as done). */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.call<void>(`${GOOGLE_API}/calendars/${path(calendarId)}/events/${path(eventId)}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof HttpFailure && (error.status === 404 || error.status === 410)) return;
      throw error;
    }
  }
}
