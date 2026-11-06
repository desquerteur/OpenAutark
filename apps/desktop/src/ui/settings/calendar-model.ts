// Settings › Calendar wording and checks (B-041 track G): a connected calendar's line (what it is – a read-only link,
// Google two-way or read-only on this PC – and its sync state: syncing, last sync, the runtime's error sentence, an
// expired Google sign-in), what the Google row says (no client ID yet, ready, waiting for the browser, the last
// failure), the answer of calendar.google read defensively (an older runtime answers fewer fields), and the input
// checks of the forms (a calendar link, working hours, a client ID) – the runtime checks again.
// Owns: these pure texts and checks. Never: RPC, signals or the DOM.

import type { CalendarSource } from '../../shared/model/calendar.ts';
import { clockMinutes } from '../../shared/model/day-settings.ts';
import { listTime } from '../lib/format.ts';

/** calendar.google as the section reads it. */
export interface GoogleView { configured: boolean; connected: boolean; sourceId?: string; waiting: boolean; error?: string }

/** The answer of calendar.google (unknown shape: an older runtime or a fake). */
export function googleView(value: unknown): GoogleView {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    configured: raw.configured === true, connected: raw.connected === true, waiting: raw.waiting === true,
    ...(typeof raw.sourceId === 'string' ? { sourceId: raw.sourceId } : {}), ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
  };
}

/** What the source is: "Link · read only", "Google · two-way", "Google · read only on this PC". */
export function sourceKind(source: Pick<CalendarSource, 'kind' | 'writable'>): string {
  if (source.kind === 'ics') return 'Link · read only';
  return source.writable ? 'Google · two-way' : 'Google · read only on this PC';
}

/** The sync state: "Syncing…", "Synced 14:02", "Not synced yet", or the error (with the last good sync). */
export function syncLine(source: Pick<CalendarSource, 'status' | 'error' | 'lastSyncAt'>, now = Date.now()): { text: string; problem: boolean } {
  if (source.status === 'syncing') return { text: 'Syncing…', problem: false };
  if (source.status === 'reconnect') return { text: source.error || 'Sign-in expired. Connect again.', problem: true };
  const last = source.lastSyncAt ? `Synced ${listTime(source.lastSyncAt, now)}` : 'Not synced yet';
  if (source.status === 'error') return { text: `${source.error || 'The last sync failed'}${source.lastSyncAt ? ` · Last synced ${listTime(source.lastSyncAt, now)}` : ''}`, problem: true };
  return { text: last, problem: false };
}

/** The hint of "Connect Google Calendar". */
export function googleHint(view: GoogleView): string {
  if (!view.configured) return 'Needs a Google client ID – add one under “Use your own Google app”';
  if (view.waiting) return 'Finish signing in in your browser';
  if (view.error) return view.error;
  return 'Reads your main calendar and writes to-do blocks to an “Autark” calendar';
}

/** A calendar link the runtime will try: http(s) or webcal, no user or password in it. */
export function linkValid(value: string): boolean {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return false; }
  return ['https:', 'http:', 'webcal:', 'webcals:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
}

/** Working hours: both clock times, the end after the start (undefined = fine, else the sentence to show). */
export function hoursProblem(start: string, end: string): string | undefined {
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (from === undefined || to === undefined) return 'Use a time like 08:00.';
  return from < to ? undefined : 'Work has to end after it starts.';
}

/** The end of every OAuth client ID Google issues. */
export const GOOGLE_CLIENT_SUFFIX = '.apps.googleusercontent.com';

/** A Google OAuth client ID as Google issues them ("1234-abc.apps.googleusercontent.com"; round 3: the suffix is required). */
export function clientIdValid(value: string): boolean {
  const id = value.trim();
  return /^[A-Za-z0-9._-]{1,200}$/.test(id) && id.endsWith(GOOGLE_CLIENT_SUFFIX) && id.length > GOOGLE_CLIENT_SUFFIX.length;
}
