// Test fixture for connected calendars (B-041 track G): the chat/task harness (in-memory SQLite with migrations,
// manual clock, bus, fake timers) with settings in the Europe/Vienna zone, a real vault on a fake keychain, this PC
// as device 'dev_pc1', the real CalendarService (track A1) and CalendarSourcesImpl on a fake fetch, a fake loopback
// listener and an empty environment. `feeds` answers ICS addresses; FakeGoogle (google-fake.ts) answers Google.
// Owns: fixtures only. Never imported by src/.

import { HUMAN_ID } from '../../../src/shared/ids.ts';
import { DEFAULT_DAY_SETTINGS } from '../../../src/shared/model/day-settings.ts';
import type { CreateTaskInput } from '../../../src/shared/model/tasks.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import '../../../src/runtime/contracts/calendar.ts';
import { CalendarServiceImpl } from '../../../src/runtime/calendar/service.ts';
import { CalendarSourcesImpl } from '../../../src/runtime/calendar/sources/index.ts';
import type { FetchFn, FetchResponse } from '../../../src/runtime/calendar/sources/http.ts';
import type { LoopbackHandler, LoopbackServerFactory } from '../../../src/runtime/calendar/sources/oauth-loopback.ts';
import { SecretVault } from '../../../src/runtime/secrets/service.ts';
import { harness, tick } from '../chat/harness.ts';
import { vienna, VIENNA } from './ics-fixtures.ts';

export { tick };

export const PC = 'dev_pc1';
export const LOOPBACK_PORT = 50_123;

/** A fetch answer. */
export function answer(status: number, body: string, headers: Record<string, string> = {}): FetchResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => lower[name.toLowerCase()] ?? null }, text: async () => body };
}

export interface FetchCall { method: string; url: string; headers: Record<string, string>; body?: string }

/** A fake loopback listener: the test calls `hit` the way the browser would after Google's redirect. */
export function fakeLoopback() {
  let handler: LoopbackHandler | undefined;
  let open = false;
  const factory: LoopbackServerFactory = (h) => {
    handler = h;
    return { listen: async () => { open = true; return LOOPBACK_PORT; }, close: () => { open = false; } };
  };
  /** A GET of `path` on the listener; its status and page. */
  const hit = (path: string, host = `127.0.0.1:${LOOPBACK_PORT}`) => {
    let status = 0;
    let body = '';
    handler!({ method: 'GET', url: path, headers: { host } }, { writeHead: (code) => { status = code; }, end: (text) => { body = text ?? ''; } });
    return { status, body };
  };
  return { factory, hit, isOpen: () => open };
}

export function world(options: { now?: number; fetch?: FetchFn; env?: Record<string, string>; googleClientId?: string; start?: boolean } = {}) {
  const h = harness();
  const s = h.services as RuntimeServices;
  const settings = {
    profile: { timezone: VIENNA, name: 'Robin' }, day: { ...DEFAULT_DAY_SETTINGS },
    calendar: options.googleClientId ? { googleClientId: options.googleClientId } as { googleClientId?: string; googleSecretId?: string } : {} as { googleClientId?: string; googleSecretId?: string },
  };
  s.settings = { get: () => settings, update: () => settings } as unknown as RuntimeServices['settings'];
  h.clock.set(options.now ?? vienna('2026-10-24', '09:00'));
  const vault = new SecretVault({ db: h.db, clock: h.clock, host: {
    encrypt: async (plain: string) => Uint8Array.from(Buffer.from(plain, 'utf8'), (byte) => byte ^ 0x5a),
    decrypt: async (cipher: Uint8Array) => Buffer.from(Uint8Array.from(cipher, (byte) => byte ^ 0x5a)).toString('utf8'),
  } });
  s.secrets = vault;
  s.devices = { self: () => ({ id: PC, name: 'Laptop' }) } as unknown as RuntimeServices['devices'];
  const opened: string[] = [];
  (s.host as unknown as { openExternal: (url: string) => Promise<void> }).openExternal = async (url) => { opened.push(url); };
  const calendar = new CalendarServiceImpl(s);
  s.calendar = calendar;
  calendar.start();

  const calls: FetchCall[] = [];
  /** ICS address → its answer (a function gets the call count). */
  const feeds = new Map<string, FetchResponse | ((count: number) => FetchResponse)>();
  let feedCalls = 0;
  const icsFetch: FetchFn = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers, body: init.body });
    const feed = feeds.get(url);
    if (!feed) return answer(404, 'not found');
    return typeof feed === 'function' ? feed(++feedCalls) : feed;
  };
  const loopback = fakeLoopback();
  const sources = new CalendarSourcesImpl(s, { fetch: options.fetch ?? icsFetch, timers: h.timers, loopback: loopback.factory, env: options.env ?? {} });
  s.calendarSources = sources;
  if (options.start !== false) sources.start();

  /** The person's own to-do (chat-free, B-054). */
  const todo = (title: string, extra: Partial<CreateTaskInput> = {}) =>
    h.tasks.create({ title, assigneeKind: 'human', createdBy: HUMAN_ID, ...extra });
  const sourceRows = () => h.db.all<Record<string, unknown>>('SELECT * FROM calendar_sources');
  const eventRows = (sourceId: string) => h.db.all<Record<string, unknown>>('SELECT * FROM calendar_events WHERE source_id = ? ORDER BY start_at', [sourceId]);
  const secretRows = () => h.db.all<{ id: string; label: string; kind: string; agents: string; domains: string; source: string | null; cipher: Uint8Array | null }>('SELECT * FROM secrets');
  /** Every place a text could be stored in plain form (the whole database dump). */
  const dump = () => {
    const out: string[] = [];
    for (const { name } of h.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      for (const row of h.db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`)) out.push(JSON.stringify(row, (_key, value) => (value instanceof Uint8Array ? '<bytes>' : value)));
    }
    return out.join('\n');
  };
  return { ...h, s, settings, vault, calendar, sources, calls, feeds, loopback, opened, todo, sourceRows, eventRows, secretRows, dump };
}
