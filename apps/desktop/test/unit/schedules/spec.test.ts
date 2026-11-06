// Tests for the pure schedule math (src/runtime/schedules/spec.ts): validation, one-off `at`,
// anchored/unanchored intervals, cron with IANA zones across DST changes, `until`, excluded
// dates and daily windows. Owns: these assertions only. Never: timers, clock or I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firesBetween, localParts, nextFire, validateSpec } from '../../../src/runtime/schedules/spec.ts';

const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 17, 9, 0, 0); // Saturday 2026-10-17 09:00Z (11:00 in Berlin)
const iso = (values: number[]) => values.map(value => new Date(value).toISOString());

test('validateSpec: needs at/cron/everyMs, one recurrence kind, sane interval, zone, window and dates', () => {
  assert.match(validateSpec({})!, /needs "at", "cron", "everyMs" or "times"/);
  assert.match(validateSpec({ cron: '0 9 * * *', everyMs: 60_000 })!, /only one of "cron", "everyMs" and "times"/);
  assert.match(validateSpec({ times: ['09:00'], everyMs: 60_000 })!, /only one of/);
  assert.match(validateSpec({ everyMs: 59_999 })!, /at least 60000 ms/);
  assert.match(validateSpec({ everyMs: Number.NaN })!, /at least/);
  assert.equal(validateSpec({ everyMs: 1000 }, { minEveryMs: 1000 }), undefined, 'timers may tick every second');
  assert.match(validateSpec({ cron: 'every day at nine' })!, /Invalid cron/);
  assert.match(validateSpec({ cron: '0 9 * * *', tz: 'Mars/Olympus' })!, /Unknown time zone/);
  assert.match(validateSpec({ everyMs: H, window: { from: '9:00', to: '17:00' } })!, /HH:MM/);
  assert.match(validateSpec({ everyMs: H, window: { from: '09:00', to: '24:00' } })!, /HH:MM/);
  assert.match(validateSpec({ cron: '0 9 * * *', except: ['18.10.2026'] })!, /YYYY-MM-DD/);
  assert.equal(validateSpec({ at: T0 }), undefined);
  assert.equal(validateSpec({ at: T0, cron: '0 9 * * *', tz: 'Europe/Berlin', until: T0 + 7 * D, maxRuns: 3 }), undefined);
  assert.equal(validateSpec({ cron: '30 0 9 * * *' }), undefined, '6-field cron (seconds) is accepted');
});

test('one-off at: fires once strictly after `after`, never again', () => {
  assert.equal(nextFire({ at: T0 + H }, T0), T0 + H);
  assert.equal(nextFire({ at: T0 + H }, T0 + H), undefined, 'strictly after');
  assert.equal(nextFire({ at: T0 }, T0 + 1), undefined);
  assert.equal(nextFire({ at: T0 + H, until: T0 }, T0 - 1), undefined, 'until before at');
  assert.equal(nextFire({ at: T0 + H, except: ['2026-10-17'], tz: 'UTC' }, T0), undefined, 'an excluded one-off is dropped, not moved');
  assert.equal(nextFire({ at: T0 + H, window: { from: '12:00', to: '13:00' }, tz: 'UTC' }, T0), undefined);
});

test('everyMs without at: relative to `after`; with at: on the grid anchored at `at`', () => {
  assert.equal(nextFire({ everyMs: 15 * 60_000 }, T0), T0 + 15 * 60_000);
  const spec = { at: T0, everyMs: 10 * 60_000 };
  assert.equal(nextFire(spec, T0 - 5 * D), T0, 'before the anchor: the anchor itself');
  assert.equal(nextFire(spec, T0), T0 + 10 * 60_000, 'on a grid point: the next one');
  assert.equal(nextFire(spec, T0 + 10 * 60_000 + 1), T0 + 20 * 60_000);
  assert.equal(nextFire(spec, T0 + 3 * D + 7 * 60_000), T0 + 3 * D + 10 * 60_000, 'no drift after days');
});

test('cron in UTC and in a time zone; 6 fields add seconds; at = "not before"', () => {
  // Weekly Monday 18:00 (the tool example) from Saturday.
  assert.equal(new Date(nextFire({ cron: '0 18 * * 1', tz: 'UTC' }, T0)!).toISOString(), '2026-10-19T18:00:00.000Z');
  // Daily 09:00 Berlin: 11:00 local already passed → tomorrow 09:00 CEST = 07:00Z.
  assert.equal(new Date(nextFire({ cron: '0 9 * * *', tz: 'Europe/Berlin' }, T0)!).toISOString(), '2026-10-18T07:00:00.000Z');
  assert.equal(new Date(nextFire({ cron: '30 0 9 * * *', tz: 'UTC' }, T0)!).toISOString(), '2026-10-17T09:00:30.000Z');
  assert.equal(nextFire({ cron: '0 9 * * *', tz: 'UTC' }, T0), T0 + D, 'strictly after a matching instant');
  const notBefore = Date.UTC(2026, 9, 20, 0, 0, 0);
  assert.equal(new Date(nextFire({ cron: '0 9 * * *', tz: 'UTC', at: notBefore }, T0)!).toISOString(), '2026-10-20T09:00:00.000Z');
  assert.equal(nextFire({ cron: '0 9 * * *', tz: 'UTC', at: T0 + 3 * D }, T0), T0 + 3 * D, 'an `at` on a match fires at `at`');
});

test('DST: a daily local time fires exactly once per day, at the right local hour', () => {
  const tz = 'Europe/Berlin';
  // Autumn (2026-10-25: 03:00 CEST → 02:00 CET): 09:00 local moves from 07:00Z to 08:00Z.
  assert.deepEqual(iso(firesBetween({ cron: '0 9 * * *', tz }, Date.UTC(2026, 9, 23, 12), Date.UTC(2026, 9, 27, 12))), [
    '2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-10-27T08:00:00.000Z',
  ]);
  // 02:30 exists twice on 25 Oct: it fires once (the first one).
  assert.deepEqual(iso(firesBetween({ cron: '30 2 * * *', tz }, Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 26, 12))), [
    '2026-10-25T00:30:00.000Z', '2026-10-26T01:30:00.000Z',
  ]);
  // Spring (2026-03-29: 02:00 CET → 03:00 CEST): 02:30 does not exist; it fires once, an hour later.
  const spring = firesBetween({ cron: '30 2 * * *', tz }, Date.UTC(2026, 2, 28, 12), Date.UTC(2026, 2, 30, 12));
  assert.deepEqual(iso(spring), ['2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z']);
  assert.deepEqual(spring.map(t => localParts(t, tz).date), ['2026-03-29', '2026-03-30']);
  // New York (2026-11-01 fall back): 09:00 local moves from 13:00Z to 14:00Z.
  assert.deepEqual(iso(firesBetween({ cron: '0 9 * * *', tz: 'America/New_York' }, Date.UTC(2026, 9, 31, 0), Date.UTC(2026, 10, 2, 0))), [
    '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z',
  ]);
});

test('DST: an hourly local cron never fires twice for the repeated hour', () => {
  const fires = firesBetween({ cron: '0 * * * *', tz: 'Europe/Berlin' }, Date.UTC(2026, 9, 24, 23, 30), Date.UTC(2026, 9, 25, 3, 30));
  const local = fires.map(t => localParts(t, 'Europe/Berlin'));
  assert.equal(new Set(local.map(l => `${l.date} ${l.minutes}`)).size, fires.length, 'each local wall time at most once');
  assert.ok(fires.every((t, i) => i === 0 || t > fires[i - 1]));
});

test('everyMs is absolute time: DST does not stretch or shrink intervals', () => {
  const spec = { at: Date.UTC(2026, 9, 24, 22, 0), everyMs: H, tz: 'Europe/Berlin' };
  const fires = firesBetween(spec, Date.UTC(2026, 9, 24, 22, 0), Date.UTC(2026, 9, 25, 4, 0));
  assert.equal(fires.length, 6);
  assert.ok(fires.every((t, i) => i === 0 || t - fires[i - 1] === H));
});

test('until is inclusive and ends recurring schedules', () => {
  const spec = { at: T0, everyMs: H, until: T0 + 3 * H };
  assert.equal(nextFire(spec, T0 + 2 * H), T0 + 3 * H);
  assert.equal(nextFire(spec, T0 + 3 * H), undefined);
  assert.deepEqual(firesBetween(spec, T0 - 1, T0 + 10 * H), [T0, T0 + H, T0 + 2 * H, T0 + 3 * H]);
  assert.equal(nextFire({ cron: '0 9 * * *', tz: 'UTC', until: T0 + D - 1 }, T0), undefined);
});

test('except skips whole local dates (in the spec zone)', () => {
  assert.equal(new Date(nextFire({ cron: '0 9 * * *', tz: 'UTC', except: ['2026-10-18'] }, T0)!).toISOString(), '2026-10-19T09:00:00.000Z');
  // 00:30 Berlin on 2026-10-19 is 22:30Z on the 18th: the local date decides.
  const berlin = { cron: '30 0 * * *', tz: 'Europe/Berlin', except: ['2026-10-19'] };
  assert.deepEqual(iso(firesBetween(berlin, T0, T0 + 3 * D)), ['2026-10-17T22:30:00.000Z', '2026-10-19T22:30:00.000Z']);
});

test('window: only between from (inclusive) and to (exclusive), may wrap midnight, in the spec zone', () => {
  const day = { at: Date.UTC(2026, 9, 17, 0, 0), everyMs: H, tz: 'UTC', window: { from: '09:00', to: '17:00' } };
  assert.equal(nextFire(day, Date.UTC(2026, 9, 17, 15, 30)), Date.UTC(2026, 9, 17, 16, 0));
  assert.equal(nextFire(day, Date.UTC(2026, 9, 17, 16, 0)), Date.UTC(2026, 9, 18, 9, 0), '17:00 is outside; next morning');
  const night = { ...day, window: { from: '22:00', to: '06:00' } };
  assert.equal(nextFire(night, Date.UTC(2026, 9, 17, 6, 0)), Date.UTC(2026, 9, 17, 22, 0));
  assert.equal(nextFire(night, Date.UTC(2026, 9, 17, 23, 0)), Date.UTC(2026, 9, 18, 0, 0));
  assert.equal(nextFire(night, Date.UTC(2026, 9, 18, 5, 0)), Date.UTC(2026, 9, 18, 22, 0));
  // 09:00–10:00 Berlin (CEST) is 07:00–08:00Z.
  const berlin = { ...day, tz: 'Europe/Berlin', window: { from: '09:00', to: '10:00' } };
  assert.deepEqual(iso(firesBetween(berlin, Date.UTC(2026, 9, 17, 0, 0), Date.UTC(2026, 9, 18, 23, 0))), ['2026-10-17T07:00:00.000Z', '2026-10-18T07:00:00.000Z']);
});

test('a window that never matches ends the schedule instead of looping forever', () => {
  const started = Date.now();
  assert.equal(nextFire({ everyMs: 60_000, tz: 'UTC', window: { from: '10:00', to: '10:00' } }, T0), undefined);
  assert.ok(Date.now() - started < 2000, 'bounded search');
});

test('firesBetween: (from, to], ordered, capped by limit', () => {
  const spec = { at: T0, everyMs: H };
  assert.deepEqual(firesBetween(spec, T0, T0 + 3 * H), [T0 + H, T0 + 2 * H, T0 + 3 * H]);
  assert.deepEqual(firesBetween(spec, T0 - 1, T0 + 100 * H, 5), [T0, T0 + H, T0 + 2 * H, T0 + 3 * H, T0 + 4 * H]);
  assert.deepEqual(firesBetween({ at: T0 }, T0, T0 + D), []);
});

test('localParts: date and minute of day in a zone (midnight is 0, not 24)', () => {
  assert.deepEqual(localParts(Date.UTC(2026, 9, 24, 22, 0), 'Europe/Berlin'), { date: '2026-10-25', minutes: 0 });
  assert.deepEqual(localParts(Date.UTC(2026, 9, 24, 22, 0), 'UTC'), { date: '2026-10-24', minutes: 22 * 60 });
  assert.deepEqual(localParts(Date.UTC(2026, 9, 25, 23, 59), 'Europe/Berlin'), { date: '2026-10-26', minutes: 59 });
});
