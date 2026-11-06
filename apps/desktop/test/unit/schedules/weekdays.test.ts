// Weekday filter of a schedule (ScheduleSpec.days, src/runtime/schedules/spec.ts): validation,
// local weekdays in the spec's zone, a skipped weekday skipped as a whole local day (also on
// 23/25-hour DST days and where DST skips midnight, America/Santiago and Havana), unanchored
// intervals staying on their grid, a day-long gap of minute steps without exhausting the search,
// the next-three-times preview (previewTimes and schedules.preview over RPC) and the scheduler
// arming and re-arming around the excluded day (and naming the days in the agents' list). Every
// result is checked against a brute-force walk over the interval grid with an independent Intl
// weekday.
// Owns: these assertions only. Never: real timers, the real clock or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent, harness } from '../chat/harness.ts';
import { OWNER, TestClient, rpcFixture } from '../rpc/s1-helpers.ts';
import { firesBetween, localParts, nextFire, nextLocalDay, validateSpec } from '../../../src/runtime/schedules/spec.ts';
import { previewTimes } from '../../../src/runtime/schedules/preview.ts';
import { scheduleTools } from '../../../src/runtime/tools/builtin/schedule.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import type { ScheduleSpec } from '../../../src/shared/model/tasks.ts';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const TZ = 'Europe/Berlin';
const AT = Date.UTC(2026, 9, 21, 7, 37); // Wed 21 Oct 2026, 09:37 in Berlin (CEST)
const NOT_FRIDAY = [0, 1, 2, 3, 4, 6];
const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const weekdayIn = (tz: string) => {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  return (ms: number) => NAMES.indexOf(format.format(ms));
};
const local = (ms: number, tz = TZ) => {
  const parts = localParts(ms, tz);
  return `${parts.date} ${String(Math.floor(parts.minutes / 60)).padStart(2, '0')}:${String(parts.minutes % 60).padStart(2, '0')}`;
};

type Interval = { at: number; everyMs: number; tz: string; days: number[] };

/** Reference: the grid points at + k·everyMs in (from, to] on an allowed local weekday. */
function brute(spec: Interval, from: number, to: number): number[] {
  const day = weekdayIn(spec.tz);
  const out: number[] = [];
  const first = from < spec.at ? spec.at : spec.at + (Math.floor((from - spec.at) / spec.everyMs) + 1) * spec.everyMs;
  for (let at = first; at <= to; at += spec.everyMs) if (spec.days.includes(day(at))) out.push(at);
  return out;
}

test('validateSpec: days are 0 (Sunday) to 6 (Saturday), at least one', () => {
  for (const days of [[], [7], [-1], [1.5], ['mon']]) {
    assert.match(validateSpec({ everyMs: H, days } as unknown as ScheduleSpec)!, /"days" must list weekdays/, JSON.stringify(days));
  }
  assert.match(validateSpec({ everyMs: H, days: 'weekdays' } as unknown as ScheduleSpec)!, /"days"/);
  assert.equal(validateSpec({ everyMs: H, days: NOT_FRIDAY, tz: TZ }), undefined);
  assert.equal(validateSpec({ cron: '0 9 * * *', days: [1, 2, 3, 4, 5, 6, 0] }), undefined);
});

test('every 53 minutes except Friday: nothing on the local Friday, the grid goes on on Saturday', () => {
  const spec: Interval = { everyMs: 53 * MIN, at: AT, tz: TZ, days: NOT_FRIDAY };
  const from = Date.UTC(2026, 9, 22, 19, 0); // Thu 21:00 Berlin
  const to = Date.UTC(2026, 9, 24, 1, 0); // Sat 03:00 Berlin
  const fires = firesBetween(spec, from, to, 500);
  assert.deepEqual(fires, brute(spec, from, to));
  assert.ok(fires.every((at) => weekdayIn(TZ)(at) !== 5), 'never on Friday');
  assert.equal(local(nextFire(spec, Date.UTC(2026, 9, 22, 21, 40))!), '2026-10-24 00:20', 'Thu 23:40 → the first grid point on Saturday');
  // 00:30 Berlin on Saturday is still Friday in UTC: the spec's zone decides.
  const utcFriday = { ...spec, tz: 'UTC' };
  assert.ok(firesBetween(utcFriday, from, to, 500).every((at) => new Date(at).getUTCDay() !== 5));
});

test('an unanchored interval keeps its grid across a skipped day', () => {
  const after = Date.UTC(2026, 9, 22, 21, 50, 17); // Thu 23:50:17 Berlin
  const next = nextFire({ everyMs: 20 * MIN, tz: TZ, days: NOT_FRIDAY }, after)!;
  assert.equal((next - after) % (20 * MIN), 0, 'still after + k·everyMs');
  assert.equal(weekdayIn(TZ)(next), 6);
  assert.ok(next - 20 * MIN < Date.UTC(2026, 9, 23, 22, 0), 'the first grid point of Saturday');
});

test('a day-long gap of minute steps is skipped in one go (no exhausted search)', () => {
  const mondays = { everyMs: MIN, at: Date.UTC(2026, 9, 19, 0, 0), tz: 'UTC', days: [1] };
  assert.equal(nextFire(mondays, Date.UTC(2026, 9, 20, 0, 0)), Date.UTC(2026, 9, 26, 0, 0), 'Tue → next Monday 00:00');
  const started = Date.now();
  assert.equal(firesBetween(mondays, Date.UTC(2026, 9, 19, 23, 58), Date.UTC(2026, 10, 2, 0, 1), 10).length, 10);
  assert.ok(Date.now() - started < 2000);
  // Excluded dates skip their whole day the same way.
  const skipDays = { everyMs: MIN, at: Date.UTC(2026, 9, 19, 0, 0), tz: 'UTC', except: ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'] };
  assert.equal(nextFire(skipDays, Date.UTC(2026, 9, 19, 23, 59)), Date.UTC(2026, 9, 24, 0, 0));
});

test('DST: the 25-hour and 23-hour Sundays in Berlin are skipped or kept as whole local days', () => {
  // Autumn: Sunday 25 Oct 2026 runs 22:00Z (Sat) to 23:00Z; Monday starts at 23:00Z.
  const noSunday: Interval = { everyMs: 53 * MIN, at: AT, tz: TZ, days: [1, 2, 3, 4, 5, 6] };
  const autumn = firesBetween(noSunday, Date.UTC(2026, 9, 24, 20, 0), Date.UTC(2026, 9, 26, 6, 0), 500);
  assert.deepEqual(autumn, brute(noSunday, Date.UTC(2026, 9, 24, 20, 0), Date.UTC(2026, 9, 26, 6, 0)));
  assert.ok(autumn.every((at) => at < Date.UTC(2026, 9, 24, 22, 0) || at >= Date.UTC(2026, 9, 25, 23, 0)), 'nothing in the 25 local hours');
  assert.equal(local(autumn.find((at) => at >= Date.UTC(2026, 9, 25, 23, 0))!), '2026-10-26 00:48', 'first run of Monday (CET)');
  // Spring: Sunday 29 Mar 2026 runs 23:00Z (Sat) to 22:00Z – 23 hours.
  const sundays: Interval = { everyMs: 37 * MIN, at: Date.UTC(2026, 2, 1, 0, 0), tz: TZ, days: [0] };
  const spring = firesBetween(sundays, Date.UTC(2026, 2, 28, 12, 0), Date.UTC(2026, 2, 30, 12, 0), 500);
  assert.deepEqual(spring, brute(sundays, Date.UTC(2026, 2, 28, 12, 0), Date.UTC(2026, 2, 30, 12, 0)));
  assert.ok(spring[0] >= Date.UTC(2026, 2, 28, 23, 0) && spring[0] < Date.UTC(2026, 2, 28, 23, 37), 'from local midnight');
  assert.ok(spring.at(-1)! < Date.UTC(2026, 2, 29, 22, 0) && spring.at(-1)! >= Date.UTC(2026, 2, 29, 21, 23), 'until the next local midnight');
});

test('DST at midnight: a day that starts at 01:00 (Santiago, Havana) and a repeated 23:00 hour', () => {
  const santiago: Interval = { everyMs: 7 * MIN, at: Date.UTC(2026, 8, 1, 0, 0), tz: 'America/Santiago', days: [0] };
  const from = Date.UTC(2026, 8, 5, 16, 0); // Sat 12:00 local
  const first = nextFire(santiago, from)!;
  assert.deepEqual([first], brute(santiago, from, first));
  assert.ok(first >= Date.UTC(2026, 8, 6, 4, 0) && first < Date.UTC(2026, 8, 6, 4, 7), `Sunday starts at 01:00 local: ${local(first, santiago.tz)}`);
  // nextLocalDay is the exact start of the next local day: later date, one minute before it the old one.
  const cases: Array<[string, number, string]> = [
    ['America/Santiago', Date.UTC(2026, 8, 5, 12), '2026-09-06T04:00:00.000Z'], // 00:00 → 01:00
    ['America/Santiago', Date.UTC(2026, 3, 4, 12), '2026-04-05T04:00:00.000Z'], // 24:00 → 23:00 again
    ['America/Havana', Date.UTC(2026, 2, 7, 12), '2026-03-08T05:00:00.000Z'], // 00:00 → 01:00
    [TZ, Date.UTC(2026, 9, 24, 12), '2026-10-24T22:00:00.000Z'],
    [TZ, Date.UTC(2026, 9, 25, 12), '2026-10-25T23:00:00.000Z'],
    [TZ, Date.UTC(2026, 2, 29, 12), '2026-03-29T22:00:00.000Z'],
    ['Pacific/Auckland', Date.UTC(2026, 8, 27, 0), '2026-09-27T11:00:00.000Z'], // after the 23-hour 27 Sep (NZDT)
    ['Australia/Lord_Howe', Date.UTC(2026, 3, 5, 3), '2026-04-05T13:30:00.000Z'], // after a 30-minute change
  ];
  for (const [tz, at, start] of cases) {
    const next = nextLocalDay(at, tz);
    assert.equal(new Date(next).toISOString(), start, `${tz} after ${new Date(at).toISOString()}`);
    assert.notEqual(localParts(next, tz).date, localParts(at, tz).date);
    assert.equal(localParts(next - MIN, tz).date, localParts(at, tz).date);
  }
});

test('preview: the next three times step over the excluded day', (t) => {
  const spec: ScheduleSpec = { everyMs: 53 * MIN, at: AT, tz: TZ, days: NOT_FRIDAY, catchUp: 'once' };
  const now = Date.UTC(2026, 9, 22, 20, 30); // Thu 22:30 Berlin
  assert.deepEqual(previewTimes(spec, now).map((at) => local(at)), ['2026-10-22 22:43', '2026-10-22 23:36', '2026-10-24 00:20']);
  assert.deepEqual(previewTimes({ ...spec, maxRuns: 5 }, now, { runs: 4 }).map((at) => local(at)), ['2026-10-22 22:43']);
  assert.deepEqual(previewTimes({ ...spec, until: Date.UTC(2026, 9, 23, 21, 59) }, now).map((at) => local(at)), ['2026-10-22 22:43', '2026-10-22 23:36'], 'until Friday ends it there');
  assert.throws(() => previewTimes({ ...spec, days: [] }, now), /"days"/);

  const f = rpcFixture();
  t.after(f.cleanup);
  const owner = new TestClient(f.server, OWNER);
  const at = f.clock.now() + H;
  const day = weekdayIn('UTC')(at);
  return owner.call<{ times: number[] }>('schedules.preview', { spec: { everyMs: 6 * H, at, tz: 'UTC', days: [day] }, count: 6 }).then(({ times }) => {
    assert.equal(times.length, 6);
    assert.ok(times.every((time) => new Date(time).getUTCDay() === day), 'schedules.preview keeps the weekday filter');
    assert.ok(times.at(-1)! - times[0] > 6 * D, 'the next week is reached');
  });
});

test('the scheduler arms the first run after the excluded day and re-arms past it after firing', async () => {
  const h = harness();
  h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: ['ag_tom'], createdBy: 'human' });
  h.scheduler.start();
  const start = h.clock.now(); // Sat 17 Oct 2026 09:00Z
  const spec: Interval = { everyMs: 53 * MIN, at: start, tz: 'UTC', days: [1, 2, 3, 4, 5, 6] };
  const schedule = h.scheduler.create({ ownerId: 'ag_tom', conversationId: chat.id, kind: 'message', title: 'Ping', spec, payload: { body: 'Ping' } });
  assert.equal(schedule.nextAt, start + 53 * MIN);
  const monday = Date.UTC(2026, 9, 19, 0, 0);
  const lastSaturday = brute(spec, start, monday).at(-1)!;
  h.clock.set(lastSaturday);
  h.scheduler.tick();
  const armed = h.scheduler.get(schedule.id)!;
  assert.equal(armed.nextAt, brute(spec, lastSaturday, monday + H)[0], 'Sunday is skipped');
  assert.ok(armed.nextAt! >= monday);
  assert.equal(h.timers.only().ms, armed.nextAt! - lastSaturday);
  h.clock.set(armed.nextAt!);
  h.timers.fire();
  assert.equal(h.chats.messages(chat.id).filter((m) => m.kind === 'text' && m.meta.via === 'schedule').length, 2);
  assert.equal(h.scheduler.get(schedule.id)!.nextAt, armed.nextAt! + 53 * MIN);
  const ctx = { agent: h.org.get('ag_tom'), runId: 'run_1', conversationId: chat.id, mode: 'general', services: h.services, signal: new AbortController().signal, status() {} } as unknown as ToolContext;
  const listed = await scheduleTools.find((tool) => tool.name === 'schedules.list')!.run({ mine: true }, ctx);
  assert.match(String((listed.content[0] as { text: string }).text), /Ping · every 53m on Mon, Tue, Wed, Thu, Fri, Sat · next \d{4}-\d{2}-\d{2}T/, 'agents see the weekdays');
  h.scheduler.stop();
});
