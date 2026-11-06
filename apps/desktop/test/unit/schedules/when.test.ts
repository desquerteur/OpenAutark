// Tests for how the agents' one `when` shape becomes a ScheduleSpec (B-044, src/runtime/schedules/when.ts,
// parseWhen in src/runtime/tools/builtin/util.ts): { once } with an ISO time (a zone-less one in the
// profile time zone), an ISO duration or a relative form; { repeat } with every (anchored at its start),
// times, cron, weekday names, a window, start, until (a date is its whole local day), count and ifMissed;
// refusals in plain words; the rule's words and zone-offset ISO times of the tool results.
// Owns: these assertions only. Never: real clocks or a real scheduler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWhen } from '../../../src/runtime/tools/builtin/util.ts';
import { isoIn, parseEvery, parsePoint, ruleWords, specFromWhen } from '../../../src/runtime/schedules/when.ts';

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0); // Sat 17 Oct 2026, 11:00 in Berlin
const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const TZ = 'Europe/Berlin';

test('parseWhen: epoch ms, ISO datetime, ISO duration and relative forms', () => {
  assert.equal(parseWhen(T0 + 5, T0), T0 + 5);
  assert.equal(parseWhen('2026-10-18T07:30:00Z', T0), Date.UTC(2026, 9, 18, 7, 30));
  assert.equal(parseWhen('2026-10-18T09:30:00+02:00', T0), Date.UTC(2026, 9, 18, 7, 30));
  assert.equal(parseWhen('PT24H', T0), T0 + 24 * H);
  assert.equal(parseWhen('PT1H30M', T0), T0 + 90 * M);
  assert.equal(parseWhen('P1DT2H', T0), T0 + 26 * H);
  assert.equal(parseWhen('pt45s', T0), T0 + 45_000, 'case-insensitive');
  assert.equal(parseWhen('+24h', T0), T0 + 24 * H);
  assert.equal(parseWhen('in 30m', T0), T0 + 30 * M);
  assert.equal(parseWhen('2d', T0), T0 + 48 * H);
  assert.equal(parseWhen('1.5 hours', T0), T0 + 90 * M);
  assert.equal(parseWhen('1w', T0), T0 + 7 * 24 * H);
  assert.equal(parseWhen('10 minutes', T0), T0 + 10 * M);
});

test('parseWhen: empty, zero and unreadable input gives undefined', () => {
  for (const value of ['', '   ', 'PT', 'P', 'PT0S', 'tomorrow-ish', 'soon', undefined, null, Number.NaN, {}]) {
    assert.equal(parseWhen(value, T0), undefined, `"${String(value)}"`);
  }
});

test('parsePoint: a time without a zone is in the given zone (DST-correct); with a zone or relative as parseWhen', () => {
  assert.equal(parsePoint('2026-10-18T09:00', T0, TZ), Date.UTC(2026, 9, 18, 7, 0), 'CEST');
  assert.equal(parsePoint('2026-10-26 09:00:30', T0, TZ), Date.UTC(2026, 9, 26, 8, 0, 30), 'CET, a space and seconds');
  assert.equal(parsePoint('2026-10-26', T0, TZ), Date.UTC(2026, 9, 25, 23, 0), 'a date: local midnight');
  assert.equal(parsePoint('2026-10-18T09:00Z', T0, TZ), Date.UTC(2026, 9, 18, 9, 0), 'an explicit zone wins');
  assert.equal(parsePoint('+2h', T0, TZ), T0 + 2 * H);
  assert.equal(parsePoint('2026-10-18T25:00', T0, TZ), undefined);
  assert.equal(parseEvery('30m'), 30 * M);
  assert.equal(parseEvery('2 hours'), 2 * H);
  assert.equal(parseEvery('1d'), D);
  assert.equal(parseEvery('2w'), 14 * D);
  assert.equal(parseEvery('often'), undefined);
});

test('once: a one-off at that time in the profile zone; past or unreadable times are refused', () => {
  assert.deepEqual(specFromWhen({ once: 'PT24H' }, T0, TZ), { at: T0 + 24 * H, tz: TZ, catchUp: 'once' });
  assert.deepEqual(specFromWhen({ once: '2026-10-19T09:00' }, T0, TZ), { at: Date.UTC(2026, 9, 19, 7, 0), tz: TZ, catchUp: 'once' });
  assert.deepEqual(specFromWhen({ once: '2026-10-19T09:00', tz: 'America/New_York' }, T0, TZ), { at: Date.UTC(2026, 9, 19, 13, 0), tz: 'America/New_York', catchUp: 'once' });
  assert.deepEqual(specFromWhen({ once: '+2h' }, T0, undefined), { at: T0 + 2 * H, tz: undefined, catchUp: 'once' }, 'no profile zone: the OS zone');
  assert.equal(specFromWhen({ once: 'next blue moon' }, T0, TZ), 'Cannot read the time "next blue moon".');
  assert.equal(specFromWhen({ once: '2026-10-17T08:00:00Z' }, T0, TZ), 'That time is in the past.');
  assert.equal(typeof specFromWhen({ once: '2026-10-17T08:59:30Z' }, T0, TZ), 'object', 'up to a minute in the past is tolerated (clock skew)');
  assert.match(specFromWhen(undefined, T0, TZ) as string, /^Give when:/);
  assert.match(specFromWhen({}, T0, TZ) as string, /^Give when:/);
  assert.match(specFromWhen({ once: '+1h', repeat: { every: '1d' } }, T0, TZ) as string, /^Give when:/, 'either once or repeat');
  assert.equal(specFromWhen({ once: '+1h', tz: 'Mars/Olympus' }, T0, TZ), 'Unknown time zone.');
});

test('repeat every: an interval anchored at its start (default: one interval from now), weekdays, window, count', () => {
  assert.deepEqual(specFromWhen({ repeat: { every: '30m' } }, T0, TZ), { everyMs: 30 * M, at: T0 + 30 * M, tz: TZ, catchUp: 'once' });
  const weekly = specFromWhen({ repeat: { every: '1w', start: '2026-10-19T09:00', count: 4, ifMissed: 'skip' } }, T0, TZ);
  assert.deepEqual(weekly, { everyMs: 7 * D, at: Date.UTC(2026, 9, 19, 7, 0), tz: TZ, maxRuns: 4, catchUp: 'skip' });
  const office = specFromWhen({ repeat: { every: '2h', days: ['mon', 'Tuesday', 'fri', 'mon'], window: { from: '9:00', to: '17:00' } } }, T0, TZ);
  assert.deepEqual(office, { everyMs: 2 * H, at: T0 + 2 * H, tz: TZ, days: [1, 2, 5], window: { from: '09:00', to: '17:00' }, catchUp: 'once' });
  assert.equal(specFromWhen({ repeat: { every: '0.5m' } }, T0, TZ), 'Repeat at most every minute.');
  assert.match(specFromWhen({ repeat: { every: 'often' } }, T0, TZ) as string, /^Cannot read "every"/);
  assert.equal(specFromWhen({ repeat: { days: ['mon'] } }, T0, TZ), 'A repeat needs "every", "times" or "cron".');
  assert.equal(specFromWhen({ repeat: { every: '1d', cron: '0 9 * * *' } }, T0, TZ), 'Use only one of "every", "times" and "cron".');
  assert.equal(specFromWhen({ repeat: { every: '1d', days: ['someday'] } }, T0, TZ), '"days" must be weekday names like "mon".');
});

test('repeat times / cron: several times a day, "not before", until a whole local day, never-firing refused', () => {
  const thrice = specFromWhen({ repeat: { times: ['18:00', '9:00', '13:30', '09:00'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] } }, T0, TZ);
  assert.deepEqual(thrice, { times: ['09:00', '13:30', '18:00'], days: [1, 2, 3, 4, 5], tz: TZ, catchUp: 'once' });
  const until = specFromWhen({ repeat: { times: ['09:00'], start: '2026-10-20', until: '2026-10-31' } }, T0, TZ) as { at: number; until: number };
  assert.equal(until.at, Date.UTC(2026, 9, 19, 22, 0), 'not before local midnight of the 20th');
  assert.equal(until.until, Date.UTC(2026, 9, 31, 23, 0) - 1, 'the whole 31st (CET)');
  assert.equal(specFromWhen({ repeat: { times: ['9 am'] } }, T0, TZ), '"times" must be clock times like "09:00".');
  assert.deepEqual(specFromWhen({ repeat: { cron: ' 0 18 * * 1 ' } }, T0, TZ), { cron: '0 18 * * 1', tz: TZ, catchUp: 'once' });
  assert.equal(specFromWhen({ repeat: { cron: 'every day at nine' } }, T0, TZ), 'Invalid cron expression.');
  assert.equal(specFromWhen({ repeat: { cron: '0 9 * * *', until: '2026-10-16T00:00:00Z' } }, T0, TZ), 'That schedule never fires.');
  assert.equal(typeof specFromWhen({ repeat: { every: '1h', until: 'PT2H' } }, T0, TZ), 'object');
  assert.match(specFromWhen({ repeat: { times: ['09:00'], start: 'whenever' } }, T0, TZ) as string, /^Cannot read the start/);
});

test("the rule's words and zone-offset ISO times for the tool results", () => {
  assert.equal(isoIn(Date.UTC(2026, 9, 19, 7, 0), TZ), '2026-10-19T09:00+02:00');
  assert.equal(isoIn(Date.UTC(2026, 9, 26, 8, 0), TZ), '2026-10-26T09:00+01:00');
  assert.equal(isoIn(Date.UTC(2026, 9, 26, 8, 0), 'UTC'), '2026-10-26T08:00Z');
  assert.equal(isoIn(Date.UTC(2026, 9, 26, 8, 0), 'America/New_York'), '2026-10-26T04:00-04:00');
  assert.equal(ruleWords({ at: Date.UTC(2026, 9, 19, 7, 0), tz: TZ }), 'once 2026-10-19T09:00+02:00');
  assert.equal(ruleWords({ times: ['09:00', '13:30'], days: [1, 3], tz: TZ, maxRuns: 10 }), 'daily at 09:00, 13:30 on Mon, Wed · 10 runs in total');
  assert.equal(ruleWords({ everyMs: 2 * H, at: T0, window: { from: '09:00', to: '17:00' }, catchUp: 'skip' }), 'every 2h · between 09:00–17:00 · if missed: skip');
  assert.equal(ruleWords({ cron: '0 18 * * 1', except: ['2026-10-26'] }), 'cron "0 18 * * 1" · skips 1 date');
  assert.equal(ruleWords({ everyMs: 90 * M, at: T0 }), 'every 90m');
});
