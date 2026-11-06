// The composer's schedule mode (ui/chat/composer/schedule-form.ts): the settings block's fields become the spec
// messages.schedule takes – a one-off, an interval, clock times on weekdays or a cron rule, with an optional start and end
// – in the local zone, every mistake gets one short text; a stored spec becomes the form again (Edit).
// Owns: these assertions only. Never: renders the block or calls the runtime (the window check: test/ui/schedule-window.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultForm, editableSchedule, formFromSpec, formKey, localInput, quickPicks, scheduleSpec, splitEvery, todayIn,
} from '../../../src/ui/chat/composer/schedule-form.ts';
import type { ScheduleForm } from '../../../src/ui/chat/composer/schedule-form.ts';
import { validateSpec } from '../../../src/runtime/schedules/spec.ts';

const TZ = 'Europe/Berlin';
const NOW = Date.UTC(2026, 9, 31, 12, 30, 45); // Sat 31 Oct 2026, 13:30:45 in Berlin (CET after the clock change)
const H = 3_600_000;

const form = (patch: Partial<ScheduleForm>): ScheduleForm => ({ ...defaultForm(NOW, TZ), ...patch });
const specOf = (patch: Partial<ScheduleForm>) => {
  const result = scheduleSpec(form(patch), NOW);
  assert.ok('spec' in result, `expected a spec, got ${JSON.stringify(result)}`);
  assert.equal(validateSpec(result.spec), undefined, 'the runtime accepts what the form builds');
  return result.spec;
};
const errorOf = (patch: Partial<ScheduleForm>) => {
  const result = scheduleSpec(form(patch), NOW);
  assert.ok('error' in result, 'expected an error');
  return result;
};

test('a new form starts as Once, one hour ahead to the whole minute on the zone\'s clock; Repeat as "every day at 09:00"', () => {
  assert.deepEqual(defaultForm(NOW, TZ), {
    kind: 'once', date: '2026-10-31', time: '14:30', repeat: 'days', every: '1', unit: 'hours',
    days: [0, 1, 2, 3, 4, 5, 6], clock: '09:00', cron: '', start: '', end: '', tz: TZ,
  });
  assert.deepEqual(pick(defaultForm(Date.UTC(2026, 9, 31, 22, 30), TZ)), { date: '2026-11-01', time: '00:30' }, 'crosses midnight');
  assert.equal(todayIn(NOW, TZ), '2026-10-31');
});
const pick = (f: ScheduleForm) => ({ date: f.date, time: f.time });

test('Once: a future date and time give a one-off spec in that zone; passed, now and empty or broken fields are refused', () => {
  const result = scheduleSpec(form({ date: '2026-11-02', time: '09:00' }), NOW);
  assert.ok('spec' in result);
  assert.equal(result.at, Date.UTC(2026, 10, 2, 8, 0));
  assert.deepEqual(result.spec, { at: result.at, tz: TZ, catchUp: 'once' });
  assert.deepEqual(errorOf({ date: '2026-10-31', time: '13:00' }), { error: 'Pick a time in the future.' });
  assert.deepEqual(errorOf({ date: '2026-10-31', time: '13:30' }), { error: 'Pick a time in the future.' }, 'the minute that is running');
  assert.deepEqual(errorOf({ date: '', time: '09:00' }), { error: 'Pick a date and a time.' });
  assert.deepEqual(errorOf({ date: '2026-11-02', time: '' }), { error: 'Pick a date and a time.' });
  assert.deepEqual(errorOf({ date: '2026-11-02', time: '25:00' }), { error: 'Pick a date and a time.' });
});

test('Repeat on days: the time on chosen weekdays; all seven days need no weekday list; none is refused', () => {
  assert.deepEqual(specOf({ kind: 'repeat', repeat: 'days', days: [1, 3, 5], clock: '09:00' }), { tz: TZ, catchUp: 'once', times: ['09:00'], days: [1, 3, 5] });
  assert.deepEqual(specOf({ kind: 'repeat', repeat: 'days', days: [5, 1, 3, 1], clock: '07:15' }).days, [1, 3, 5], 'sorted, once each');
  assert.equal(specOf({ kind: 'repeat', repeat: 'days', days: [0, 1, 2, 3, 4, 5, 6] }).days, undefined);
  assert.deepEqual(errorOf({ kind: 'repeat', repeat: 'days', days: [] }), { error: 'Pick at least one day.' });
  assert.deepEqual(errorOf({ kind: 'repeat', repeat: 'days', clock: '' }), { error: 'Pick a time.' });
});

test('Repeat at intervals: every N minutes, hours, days or weeks, anchored one interval from now (or at the start)', () => {
  assert.deepEqual(specOf({ kind: 'repeat', repeat: 'every', every: '2', unit: 'hours' }), { tz: TZ, catchUp: 'once', everyMs: 2 * H, at: Date.UTC(2026, 9, 31, 14, 31) });
  assert.equal(specOf({ kind: 'repeat', repeat: 'every', every: '15', unit: 'minutes' }).everyMs, 900_000);
  assert.equal(specOf({ kind: 'repeat', repeat: 'every', every: '3', unit: 'days' }).everyMs, 3 * 86_400_000);
  assert.equal(specOf({ kind: 'repeat', repeat: 'every', every: '1', unit: 'weeks' }).everyMs, 7 * 86_400_000);
  const started = specOf({ kind: 'repeat', repeat: 'every', every: '1', unit: 'days', start: '2026-11-02T09:00' });
  assert.equal(started.at, Date.UTC(2026, 10, 2, 8, 0), 'the first run is the start');
  for (const bad of ['', '0', '-1', '1.5', 'x', '100000']) {
    assert.deepEqual(errorOf({ kind: 'repeat', repeat: 'every', every: bad }), { error: 'Enter how often: a whole number, 1 or more.' }, bad);
  }
});

test('Repeat with a cron rule (Advanced): five fields; nothing typed yet is a soft hint, not a mistake', () => {
  assert.deepEqual(specOf({ kind: 'repeat', repeat: 'cron', cron: '  0   9 * * 1 ' }), { tz: TZ, catchUp: 'once', cron: '0 9 * * 1' });
  const empty = errorOf({ kind: 'repeat', repeat: 'cron', cron: '' });
  assert.equal('soft' in empty && empty.soft, true);
  assert.equal('soft' in errorOf({ kind: 'repeat', repeat: 'cron', cron: '0 9 *' }), false, 'a half-written rule is a mistake');
  assert.deepEqual(errorOf({ kind: 'repeat', repeat: 'cron', cron: '0 9 *' }), { error: 'A cron rule has 5 fields: minute hour day month weekday.' });
});

test('start is "not before", end is the whole last day; an end that has passed or lies before the start is refused', () => {
  const spec = specOf({ kind: 'repeat', repeat: 'days', days: [1], start: '2026-11-02T09:00', end: '2026-11-30' });
  assert.equal(spec.at, Date.UTC(2026, 10, 2, 8, 0));
  assert.equal(spec.until, Date.UTC(2026, 10, 30, 23, 0) - 1, 'the last millisecond of 30 Nov in Berlin');
  assert.deepEqual(errorOf({ kind: 'repeat', end: '2026-10-30' }), { error: 'The end date has passed.' });
  assert.deepEqual(errorOf({ kind: 'repeat', start: '2026-12-05T09:00', end: '2026-12-01' }), { error: 'The end is before the start.' });
  assert.deepEqual(errorOf({ kind: 'repeat', start: 'soon' }), { error: 'Pick a start date and time, or clear it.' });
  assert.equal(specOf({ kind: 'repeat', repeat: 'days', end: '2026-10-31' }).until, Date.UTC(2026, 9, 31, 23, 0) - 1, 'today is still a day to run');
});

test('the quick picks: in an hour, this evening, tomorrow morning, the Monday after; a passed evening stays, switched off', () => {
  assert.deepEqual(quickPicks(NOW, TZ).map(({ key, date, time, disabled }) => [key, date, time, disabled]), [
    ['hour', '2026-10-31', '14:30', false], ['evening', '2026-10-31', '18:00', false],
    ['tomorrow', '2026-11-01', '09:00', false], ['monday', '2026-11-02', '09:00', false],
  ]);
  const late = Date.UTC(2026, 9, 31, 19, 0); // 20:00 in Berlin
  assert.equal(quickPicks(late, TZ)[1].disabled, true);
  assert.equal(quickPicks(late, TZ)[0].date, '2026-10-31', '21:00 is still today');
  const sunday = Date.UTC(2026, 10, 1, 10, 0);
  assert.equal(quickPicks(sunday, TZ)[3].date, '2026-11-09', 'on a Sunday the Monday after tomorrow is the one a week out');
});

test('a stored spec becomes the form again; what the form cannot show is not editable', () => {
  const back = (patch: Partial<ScheduleForm>) => {
    const original = form(patch);
    const result = scheduleSpec(original, NOW);
    assert.ok('spec' in result);
    const again = formFromSpec(result.spec, NOW, 'UTC');
    assert.ok(again, 'shown again');
    return { original, again };
  };
  for (const patch of [
    { date: '2026-11-02', time: '09:30' },
    { kind: 'repeat', repeat: 'days', days: [1, 2, 3, 4, 5], clock: '08:00', start: '2026-11-02T09:00', end: '2026-12-24' },
    { kind: 'repeat', repeat: 'cron', cron: '0 9 * * 1' },
  ] as Array<Partial<ScheduleForm>>) {
    const { original, again } = back(patch);
    assert.equal(formKey(again), formKey(original), JSON.stringify(patch));
  }
  const hourly = formFromSpec({ everyMs: 6 * H, at: NOW - 3 * H, tz: TZ }, NOW, 'UTC');
  assert.deepEqual([hourly?.every, hourly?.unit, hourly?.start], ['6', 'hours', ''], 'an anchor in the past shows no start');
  assert.deepEqual(splitEvery(90 * 60_000), { n: 90, unit: 'minutes' });
  assert.deepEqual(splitEvery(14 * 86_400_000), { n: 2, unit: 'weeks' });
  assert.equal(formFromSpec({ times: ['09:00', '13:30'], tz: TZ }, NOW, TZ), undefined, 'several times a day');
  assert.equal(formFromSpec({ cron: '0 9 * * 1', window: { from: '09:00', to: '17:00' } }, NOW, TZ), undefined);
  assert.equal(formFromSpec({ times: ['09:00'], maxRuns: 5 }, NOW, TZ), undefined);
  assert.equal(formFromSpec({ times: ['09:00'], except: ['2026-11-11'] }, NOW, TZ), undefined);
  assert.equal(localInput(Date.UTC(2026, 10, 2, 8, 0), TZ), '2026-11-02T09:00');
});

test('only the person\'s own scheduled message can be edited, and only with a rule the form can show', () => {
  const base = { ownerId: 'human', kind: 'message', conversationId: 'chat_1', spec: { at: NOW + H, tz: TZ } } as const;
  assert.equal(editableSchedule(base, NOW, TZ), true);
  assert.equal(editableSchedule({ ...base, ownerId: 'agent_1' }, NOW, TZ), false, 'an agent changes its own');
  assert.equal(editableSchedule({ ...base, kind: 'routine' }, NOW, TZ), false);
  assert.equal(editableSchedule({ ...base, kind: 'reminder' }, NOW, TZ), false);
  assert.equal(editableSchedule({ ...base, spec: { times: ['09:00', '18:00'] } }, NOW, TZ), false);
});
