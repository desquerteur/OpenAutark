// A linked PC answers for its person's calendar (B-078 D20, mesh method 'calendar.ask', like files.path asks a PC):
// ops 'busy' (busy and fixed spans), 'list' (the entries) and 'add' (one appointment), always for that PC's own
// 'human'. The person's zone, working hours and buffer come with every answer. Who asks decides what comes back:
// one of my own PCs ('ceo' link) or the company PC of this employee's PC ('employer' link – the CEO sees the
// employees' calendars) gets the entries, a to-do block of an "Only me" to-do as "Busy"; an employee's PC asking the
// company ('employee' link) gets busy spans only. An 'add' goes through this PC's own calendar rules (never over an
// appointment or a block the person set) and names the asking PC in its notes; it is never retried. Asking an
// offline PC answers "<name> is offline" at once; an older PC without the method answers that it cannot yet.
// Owns: the peer method and the client call. Never: passes a request on to a third PC, sends a source's address
// or a connected calendar's notes, or logs titles.

import { WorkforceError } from '../../shared/errors.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/calendar.ts';
import { DevicesRepo } from '../devices/repo.ts';
import { linkOf } from '../devices/sync/home.ts';
import { localAvailability, type MemberServices } from './members.ts';
import type { Span } from './rules.ts';

export const ASK_METHOD = 'calendar.ask';
const DAY = 24 * 60 * 60_000;
const MAX_WINDOW = 31 * DAY;
const MAX_ENTRIES = 300;

export type AskOp = 'busy' | 'list' | 'add';
export interface AskParams { op: AskOp; from?: number; to?: number; title?: string; startAt?: number; endAt?: number }
/** One entry as a linked PC sends it (titles already masked there). */
export interface PeerEntry { title: string; startAt: number; endAt: number; allDay?: true; kind: 'event' | 'to-do' }
export interface AskAnswer {
  tz: string;
  hours?: { start: string; end: string };
  bufferMin: number;
  busy: Span[];
  fixed: Span[];
  entries?: PeerEntry[];
  /** op 'add': the appointment made there. */
  event?: { id: string; startAt: number; endAt: number };
}

type Obj = Record<string, unknown>;
const plain = (value: unknown): value is Obj => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const spans = (value: unknown): Span[] => (Array.isArray(value) ? value.filter((span): span is Span => plain(span) && time(span.startAt) && time(span.endAt) && span.endAt > span.startAt).slice(0, 2000) : []);

export type AskServices = MemberServices & Pick<RuntimeServices, 'tasks'>;

/** 'calendar.ask' from linked PC `from` (see the header). */
export async function serveAsk(s: AskServices, params: unknown, from: string): Promise<AskAnswer> {
  const record = new DevicesRepo(s.db).get(from);
  const link = linkOf(record);
  if (!link || !record) throw new WorkforceError('forbidden', 'Calendar requests come only from linked PCs.');
  const p = plain(params) ? params : {};
  const calendar = s.calendar;
  if (!calendar) throw new WorkforceError('unavailable', 'The calendar is not available on this PC yet.');
  if (p.op === 'add') {
    if (typeof p.title !== 'string' || !p.title.trim() || !time(p.startAt) || !time(p.endAt) || p.endAt <= p.startAt || p.endAt - p.startAt > 14 * DAY) {
      throw new WorkforceError('bad_request', 'An appointment needs a title, startAt and endAt (at most 14 days).');
    }
    const text = `${excerpt(p.title.trim().split(/\r?\n/)[0], 120)}\nBooked from ${record.name}`;
    const { event } = await calendar.add({ text, startAt: p.startAt, endAt: p.endAt, kind: 'event' }, `device:${from}`);
    return { ...facts(s, event.startAt, event.endAt), event: { id: event.id, startAt: event.startAt, endAt: event.endAt } };
  }
  if (p.op !== 'busy' && p.op !== 'list') throw new WorkforceError('bad_request', 'Unknown calendar request.');
  if (!time(p.from) || !time(p.to) || p.to <= p.from || p.to - p.from > MAX_WINDOW) throw new WorkforceError('bad_request', 'Give from and to (at most 31 days).');
  const local = localAvailability(s, HUMAN_ID, p.from, p.to);
  const answer = facts(s, p.from, p.to, local);
  if (p.op === 'busy' || link.kind === 'employee') return answer; // an employee's PC sees the company's free/busy only
  const entries: PeerEntry[] = (local.rows ?? []).slice(0, MAX_ENTRIES).map((row) => {
    let title = row.title ?? '';
    if (row.kind === 'todo') {
      let task;
      try { task = row.taskId ? s.tasks.get(row.taskId) : undefined; } catch { task = undefined; }
      title = task && !task.private ? task.title : 'Busy';
    }
    return { title: excerpt(title || 'Busy', 120), startAt: row.startAt, endAt: row.endAt, kind: row.kind === 'todo' ? 'to-do' : 'event', ...(row.allDay ? { allDay: true as const } : {}) };
  });
  return { ...answer, entries };
}

/** The facts every answer carries (zone, hours, buffer, busy, fixed). */
function facts(s: AskServices, from: number, to: number, local = localAvailability(s, HUMAN_ID, from, to)): AskAnswer {
  return { tz: local.tz, ...(local.hours ? { hours: local.hours } : {}), bufferMin: local.bufferMin, busy: local.busy, fixed: local.fixed };
}

/** Asks linked PC `deviceId` (named `who.name` / `who.pc` in the answers); offline or older: a clear 'unavailable'. */
export async function askPeer(s: Pick<RuntimeServices, 'devices'>, deviceId: string, params: AskParams, who: { name: string; pc: string }, signal?: AbortSignal): Promise<AskAnswer> {
  let online = false;
  try { online = s.devices.online(deviceId); } catch { online = false; }
  if (!online) throw new WorkforceError('unavailable', `${who.name} is offline (${who.pc}).`, { details: { deviceId, reachable: false } });
  let answer: unknown;
  try {
    answer = await s.devices.call(deviceId, ASK_METHOD, params, signal);
  } catch (error) {
    if (error instanceof WorkforceError && error.code === 'not_found' && /peer method/i.test(error.message)) {
      throw new WorkforceError('unavailable', `${who.pc} runs an older Autark that does not answer calendar requests yet.`, { details: { deviceId } });
    }
    throw error;
  }
  if (!plain(answer)) throw new WorkforceError('unavailable', `${who.pc} sent no calendar answer.`);
  const hours = plain(answer.hours) && typeof answer.hours.start === 'string' && typeof answer.hours.end === 'string' ? { start: answer.hours.start, end: answer.hours.end } : undefined;
  const entries = Array.isArray(answer.entries)
    ? answer.entries.filter((entry): entry is PeerEntry => plain(entry) && typeof entry.title === 'string' && time(entry.startAt) && time(entry.endAt)).slice(0, MAX_ENTRIES)
      .map((entry) => ({ title: excerpt(entry.title, 120), startAt: entry.startAt, endAt: entry.endAt, kind: entry.kind === 'to-do' ? 'to-do' as const : 'event' as const, ...(entry.allDay === true ? { allDay: true as const } : {}) }))
    : undefined;
  const event = plain(answer.event) && typeof answer.event.id === 'string' && time(answer.event.startAt) && time(answer.event.endAt)
    ? { id: answer.event.id, startAt: answer.event.startAt, endAt: answer.event.endAt } : undefined;
  return {
    tz: typeof answer.tz === 'string' && answer.tz ? answer.tz : 'UTC', ...(hours ? { hours } : {}),
    bufferMin: typeof answer.bufferMin === 'number' && answer.bufferMin >= 0 && answer.bufferMin <= 120 ? answer.bufferMin : 0,
    busy: spans(answer.busy), fixed: spans(answer.fixed), ...(entries ? { entries } : {}), ...(event ? { event } : {}),
  };
}

/** Opens 'calendar.ask' to every link kind on the mesh's extension point (a fake without one: nothing). */
export function registerCalendarAsk(s: AskServices, kinds: readonly string[]): void {
  const mesh = s.devices as unknown as { register?: (method: string, handler: (params: unknown, from: string) => Promise<unknown>, kinds?: readonly string[]) => void } | undefined;
  if (typeof mesh?.register !== 'function') return;
  mesh.register(ASK_METHOD, (params, from) => serveAsk(s, params, from), kinds);
}
